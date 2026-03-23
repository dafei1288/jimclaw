import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { Skill } from "../core/skill";
import * as path from "path";
import * as fs from "fs/promises";

const execAsync = promisify(exec);

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function findNearestPackageRoot(startFilePath: string): Promise<string | null> {
  let dir = path.dirname(path.resolve(startFilePath));
  while (true) {
    if (await fileExists(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isDependencyMissingError(message: string): boolean {
  return /TS2307: Cannot find module|Cannot find module|Cannot find name 'jest'|TS2582: Cannot find name 'describe'|TS2503: Cannot find namespace 'jest'/i.test(message);
}

/**
 * 检测 Node.js HTTP 服务器中的常见作用域错误
 * 例如：在 createServer 回调外部引用 req/res 变量
 */
function detectHttpServerScopeErrors(content: string, filePath: string): string | null {
  const lines = content.split('\n');

  // 找到所有 HTTP 服务器回调的范围 (createServer, get, post, app.use 等)
  const callbackRanges: Array<[start: number, end: number]> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 匹配常见的 HTTP 服务器模式
    const httpPatterns = [
      /createServer\s*\(/,
      /app\.(get|post|put|delete|use|all)\s*\(/,
      /router\.(get|post|put|delete|use)\s*\(/,
      /express\s*\(\)\.[get|post|put|delete]/,
    ];

    for (const pattern of httpPatterns) {
      if (pattern.test(line) && line.includes('=>')) {
        // 找到回调的结束位置
        let depth = 0;
        let foundStart = false;
        for (let j = i; j < lines.length; j++) {
          for (let k = 0; k < lines[j].length; k++) {
            if (lines[j][k] === '{') {
              depth++;
              foundStart = true;
            } else if (lines[j][k] === '}') {
              depth--;
              if (foundStart && depth === 0) {
                callbackRanges.push([i, j]);
                break;
              }
            }
          }
          if (callbackRanges.some(r => r[0] === i)) break;
        }
        break;
      }
    }
  }

  // 检查是否有 req/res 在回调外被引用
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 跳过注释和空行
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed === '') continue;

    // 跳过在回调内的行
    const inCallback = callbackRanges.some(([start, end]) => i >= start && i <= end);
    if (inCallback) continue;

    // 检查是否有 req/res 引用
    // 排除合法的模式：函数定义、参数、字符串中的 req/res
    const hasSuspiciousRef =
      // 直接使用 req 或 res 的属性
      (/\breq\s*\./.test(line) || /\bres\s*\./.test(line)) ||
      // 赋值给 req/res（如 res.status = function...）
      (/\bres\s*=\s*function/.test(line) || /\breq\s*=\s*function/.test(line));

    if (hasSuspiciousRef) {
      return `第 ${i + 1} 行检测到可疑的 req/res 引用：\n` +
        `  ${trimmed}\n` +
        `【错误根源】你在 HTTP 服务器回调（如 createServer）外部引用了 req 或 res 变量，这在原生 Node.js 中会导致作用域错误。\n` +
        `【正确做法】请将所有使用 req/res 的辅助函数定义在 createServer 的回调内部。示例：\n\n` +
        `http.createServer((req, res) => {\n` +
        `  // 在此处定义辅助函数，它可以正确捕获闭包中的 req/res\n` +
        `  const sendJson = (data, status = 200) => {\n` +
        `    res.writeHead(status, { 'Content-Type': 'application/json' });\n` +
        `    res.end(JSON.stringify(data));\n` +
        `  };\n\n` +
        `  // ... 使用 sendJson\n` +
        `});\n\n` +
        `禁止在文件顶部或函数外部定义任何使用 req/res 变量的函数。`;
    }
  }

  return null;
}

/**
 * 鲁棒的多语言代码诊断技能
 */
export const LSPDiagnoseSkill = new Skill({
  name: "diagnose_code",
  description: "Check for syntax or type errors in a source file. Supports TS, JS, Python, and more.",
  schema: z.object({
    file_path: z.string().describe("The absolute or relative path to the file to check."),
  }),
  run: async ({ file_path }) => {
    const ext = path.extname(file_path).toLowerCase();
    
    try {
      switch (ext) {
        case ".ts":
        case ".tsx":
          // 优先尝试 tsc (非交互式，广泛存在)
          {
            const packageRoot = await findNearestPackageRoot(file_path);
            const hasNodeModules = packageRoot ? await fileExists(path.join(packageRoot, "node_modules")) : false;
            if (packageRoot && !hasNodeModules) {
              return "[WARNING] 依赖尚未安装（node_modules 缺失），跳过 TypeScript 类型诊断。请先执行 npm install。";
            }
          }
          try {
            await execAsync(`npx tsc ${JSON.stringify(file_path)} --noEmit --esModuleInterop --skipLibCheck`);
            return "[SUCCESS] No TypeScript errors found.";
          } catch (e: any) {
            const out = String(e.stdout || e.stderr || e.message || "");
            if (isDependencyMissingError(out)) {
              return `[WARNING] 检测到依赖缺失导致的类型错误，已降级为环境告警：\n${out}`;
            }
            return `[ERROR] TypeScript Error:\n${out}`;
          }

        case ".js":
        case ".jsx":
          // JS 增强检查：语法 + Node.js HTTP 服务器特定错误检测
          // 1. 语法检查
          try {
            await execAsync(`node --check ${file_path}`);
          } catch (e: any) {
            return `[ERROR] JavaScript Syntax Error:\n${e.stderr || e.message}`;
          }

          // 2. Node.js HTTP 服务器特定错误检测
          // 检测 createServer/get/post 等回调外部的 req/res 引用
          const jsContent = await fs.readFile(file_path, "utf-8");
          const scopeError = detectHttpServerScopeErrors(jsContent, file_path);
          if (scopeError) {
            return `[ERROR] HTTP Server 作用域错误:\n${scopeError}`;
          }

          return `[SUCCESS] JavaScript 语法和作用域检查通过。`;

        case ".py":
          // Python 语法检查 (基于 compileall 或 ruff)
          try {
            await execAsync(`python3 -m py_compile ${file_path}`);
            return "[SUCCESS] Python syntax is valid.";
          } catch (e: any) {
            return `[ERROR] Python Syntax Error:\n${e.stderr || e.message}`;
          }

        default:
          return `[INFO] No specialized diagnostic for ${ext}. Skipping deep check.`;
      }
    } catch (globalError: any) {
      return `[WARNING] Diagnostic tool failed to run: ${globalError.message}`;
    }
  },
});
