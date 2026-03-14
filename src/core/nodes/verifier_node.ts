import * as fs from "fs/promises";
import * as path from "path";
import { JimClawState } from "../graph_types";

/**
 * Verifier 节点：纯静态预检，无 LLM 调用，运行极快（Atlas 原则）
 * 检查项：① 文件存在性 ② 服务文件含监听声明 ③ 测试文件含断言 ④ package.json 依赖分类
 */
export async function verifierNode(
  state: JimClawState,
  agents: any,
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("verifier");
  const issues: string[] = [];
  const filesToCreate = state.spec?.filesToCreate || [];
  const language = (state.spec?.language || "").toLowerCase();

  // 检查 ①：文件存在性
  for (const f of filesToCreate) {
    try { await fs.access(path.join(WORKSPACE, f)); } catch { issues.push(`文件缺失: ${f}`); }
  }

  // 检查 ②：服务文件含监听声明
  const serverFilePatterns = /server|app|main|index/i;
  const listenPatterns: Record<string, RegExp> = {
    typescript: /app\.listen\(|server\.listen\(/,
    javascript: /app\.listen\(|server\.listen\(/,
    python: /uvicorn\.run\(|app\.run\(|serve\(/,
    go: /http\.ListenAndServe\(|ListenAndServe\(/,
  };
  const listenPattern = Object.entries(listenPatterns).find(([lang]) => language.includes(lang))?.[1]
    || /app\.listen\(|server\.listen\(|uvicorn\.run\(|ListenAndServe\(/;

  for (const f of filesToCreate) {
    if (serverFilePatterns.test(path.basename(f)) && !f.includes("test") && !f.includes("spec")) {
      try {
        const content = await fs.readFile(path.join(WORKSPACE, f), "utf-8");
        if (!listenPattern.test(content)) {
          issues.push(`服务文件 ${f} 未找到监听声明（如 app.listen()）`);
        }
      } catch { /* 文件缺失已在检查①中报告 */ }
    }
  }

  // 检查 ③：测试文件含断言
  const testFilePatterns = /test|spec/i;
  const assertionPattern = /expect\(|assert\.|\.toBe\(|\.toEqual\(|\.assert\(|test\(|it\(/;
  for (const f of filesToCreate) {
    if (testFilePatterns.test(path.basename(f))) {
      try {
        const content = await fs.readFile(path.join(WORKSPACE, f), "utf-8");
        if (!assertionPattern.test(content)) {
          issues.push(`测试文件 ${f} 未找到断言语句（如 expect()、assert.）`);
        }
      } catch { /* 文件缺失已在检查①中报告 */ }
    }
  }

  // 检查 ④：package.json 存在性 + 运行时依赖分类（仅 Node.js / TypeScript 项目）
  const isNodeProject = /typescript|javascript/.test(language);
  const pkgPath = path.join(WORKSPACE, "package.json");
  try {
    const pkgContent = await fs.readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgContent);
    const runtimeFrameworks = ["express", "fastify", "koa", "hapi", "nest", "restify"];
    const devDeps = Object.keys(pkg.devDependencies || {});
    // 精确匹配：避免 @types/express 误判为 express 在 devDependencies
    const runtimeInDev = runtimeFrameworks.filter(fw => devDeps.includes(fw));
    if (runtimeInDev.length > 0) {
      issues.push(`运行时框架 [${runtimeInDev.join(", ")}] 被错误放在 devDependencies，应移至 dependencies`);
    }
  } catch {
    // JS/TS 项目缺少 package.json 是致命错误，不能静默跳过
    if (isNodeProject) {
      issues.push("缺少 package.json：Node.js/TypeScript 项目必须包含 package.json，否则无法安装依赖和运行测试");
    }
  }

  // 检查 ⑤：Dockerfile 语法有效性（首行必须是合法指令）
  const dockerfilePath = path.join(WORKSPACE, "Dockerfile");
  try {
    const dockerfileContent = await fs.readFile(dockerfilePath, "utf-8");
    const firstLine = dockerfileContent.trim().split('\n')[0].trim().toUpperCase();
    const validFirstInstructions = ['FROM', 'ARG', '#', 'COMMENT'];
    if (!validFirstInstructions.some(inst => firstLine.startsWith(inst))) {
      issues.push(`Dockerfile 格式错误：第一行 "${dockerfileContent.trim().split('\n')[0].trim().slice(0, 60)}" 不是合法的 Docker 指令（必须以 FROM 或 ARG 开头，不能是 shell 命令）`);
    }
  } catch { /* Dockerfile 不存在已在文件缺失检查中报告 */ }

  // P1-B：verifier 不自增 retryCount，由 qa_node 统一管理
  if (issues.length === 0) return {};
  return { isDone: false, testResults: `[Verifier 预检失败]\n${issues.join("\n")}` };
}
