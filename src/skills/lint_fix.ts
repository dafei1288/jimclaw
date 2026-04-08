import { Skill } from "../core/skill";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";

const execPromise = promisify(exec);

export function classifyPrettierFailure(message: string): "blocking" | "warning" {
  const text = String(message || "");
  if (
    /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|network|registry\.npmjs\.org|could not determine executable|prettier is not recognized|not recognized as an internal or external command|command not found/i.test(
      text
    )
  ) {
    return "warning";
  }
  if (/No files matching the pattern were found/i.test(text)) {
    return "warning";
  }
  return "blocking";
}

async function runPrettierWithFallback(fullPath: string): Promise<string | null> {
  try {
    await execPromise(`npx prettier --write "${fullPath}"`);
    return null;
  } catch {
    try {
      await execPromise(`npx --yes prettier@3 --write "${fullPath}"`);
      return null;
    } catch (fallbackError: any) {
      const message = String(
        fallbackError?.stderr || fallbackError?.stdout || fallbackError?.message || fallbackError || ""
      );
      if (classifyPrettierFailure(message) === "warning") {
        return `Prettier 暂不可用，已跳过格式化（非阻塞）: ${message.slice(0, 200)}`;
      }
      throw fallbackError;
    }
  }
}

export const LintFixSkill = new Skill({
  name: "lint_fix",
  description: "根据文件类型自动修复代码规范和格式问题（支持 TS, JS, Python, Go, JSON, MD 等）。",
  schema: z.object({
    file_path: z.string().describe("需要修复规范的文件路径"),
  }),
  run: async (args) => {
    const { file_path } = args;
    const fullPath = path.resolve(process.cwd(), file_path);
    const ext = path.extname(file_path).toLowerCase();

    try {
      switch (ext) {
        case ".ts":
        case ".tsx":
        case ".js":
        case ".jsx": {
          const prettierWarning = await runPrettierWithFallback(fullPath);
          try {
            await execPromise(`npx eslint --fix "${fullPath}"`);
          } catch (e: any) {
            if (e.code !== 1 && e.code !== 2) {
              return `文件 ${file_path} 已格式化，但 ESLint 修复失败（非阻塞）：${e.message}`;
            }
          }
          if (prettierWarning) {
            return `[WARNING] ${prettierWarning}`;
          }
          return `文件 ${file_path} (JS/TS) 已完成格式化和规范修复。`;
        }

        case ".py": {
          // ruff 可能未安装，静默跳过
          try {
            await execPromise(`ruff --version`);
          } catch {
            return `文件 ${file_path} (Python) 跳过 lint：ruff 未安装（非阻塞）`;
          }
          await execPromise(`ruff format "${fullPath}"`);
          await execPromise(`ruff check --fix "${fullPath}"`);
          return `文件 ${file_path} (Python) 已使用 ruff 完成格式化和规范修复。`;
        }

        case ".go":
          await execPromise(`gofmt -w "${fullPath}"`);
          return `文件 ${file_path} (Go) 已使用 gofmt 完成格式化。`;

        case ".json":
        case ".md":
        case ".yml":
        case ".yaml": {
          const prettierWarning = await runPrettierWithFallback(fullPath);
          if (prettierWarning) {
            return `[WARNING] ${prettierWarning}`;
          }
          return `文件 ${file_path} 已使用 prettier 完成格式化。`;
        }

        default:
          return `未找到文件后缀 ${ext} 的对应规范工具，跳过修复。`;
      }
    } catch (error: any) {
      return `修复规范时出错(${file_path}): ${error.message}`;
    }
  },
});
