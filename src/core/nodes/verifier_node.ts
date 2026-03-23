import * as fs from "fs/promises";
import * as path from "path";
import { JimClawState } from "../graph_types";
import { findContractRouteDrift } from "../logic_utils";

/**
 * Verifier 节点：纯静态预检，无 LLM 调用，运行极快。
 * 检查项：文件存在、服务监听、测试断言、契约漂移、依赖分类、Dockerfile 头部。
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

  for (const file of filesToCreate) {
    try {
      await fs.access(path.join(WORKSPACE, file));
    } catch {
      issues.push(`文件缺失: ${file}`);
    }
  }

  const serverFilePatterns = /server|app|main|index/i;
  const listenPatterns: Record<string, RegExp> = {
    typescript: /app\.listen\(|server\.listen\(/,
    javascript: /app\.listen\(|server\.listen\(/,
    python: /uvicorn\.run\(|app\.run\(|serve\(/,
    go: /http\.ListenAndServe\(|ListenAndServe\(/,
  };
  const listenPattern =
    Object.entries(listenPatterns).find(([lang]) => language.includes(lang))?.[1] ||
    /app\.listen\(|server\.listen\(|uvicorn\.run\(|ListenAndServe\(/;

  for (const file of filesToCreate) {
    if (serverFilePatterns.test(path.basename(file)) && !file.includes("test") && !file.includes("spec")) {
      try {
        const content = await fs.readFile(path.join(WORKSPACE, file), "utf-8");
        if (!listenPattern.test(content)) {
          issues.push(`服务文件 ${file} 未找到监听声明（如 app.listen()）`);
        }
      } catch {
        // 文件缺失已由前置检查覆盖
      }
    }
  }

  const testFilePatterns = /test|spec/i;
  const assertionPattern = /expect\(|assert\.|\.toBe\(|\.toEqual\(|\.assert\(|test\(|it\(/;
  for (const file of filesToCreate) {
    if (testFilePatterns.test(path.basename(file))) {
      try {
        const content = await fs.readFile(path.join(WORKSPACE, file), "utf-8");
        if (!assertionPattern.test(content)) {
          issues.push(`测试文件 ${file} 未找到断言语句（如 expect()、assert.）`);
        }
      } catch {
        // 文件缺失已由前置检查覆盖
      }
    }
  }

  for (const file of filesToCreate) {
    if (/routes?[\\/].+\.[tj]s$/i.test(file) || /Routes?\.[tj]s$/i.test(path.basename(file))) {
      try {
        const content = await fs.readFile(path.join(WORKSPACE, file), "utf-8");
        const routeDrift = findContractRouteDrift(content, state.apiContract);
        issues.push(...routeDrift.map((item) => `契约漂移 ${file}: ${item}`));
      } catch {
        // 文件缺失已由前置检查覆盖
      }
    }
  }

  const isNodeProject = /typescript|javascript/.test(language);
  const pkgPath = path.join(WORKSPACE, "package.json");
  try {
    const pkgContent = await fs.readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgContent);
    const runtimeFrameworks = ["express", "fastify", "koa", "hapi", "nest", "restify"];
    const devDeps = Object.keys(pkg.devDependencies || {});
    const runtimeInDev = runtimeFrameworks.filter((fw) => devDeps.includes(fw));
    if (runtimeInDev.length > 0) {
      issues.push(`运行时框架 [${runtimeInDev.join(", ")}] 被错误放在 devDependencies，应移至 dependencies`);
    }
  } catch {
    if (isNodeProject) {
      issues.push("缺少 package.json：Node.js/TypeScript 项目必须包含 package.json，否则无法安装依赖和运行测试");
    }
  }

  const dockerfilePath = path.join(WORKSPACE, "Dockerfile");
  try {
    const dockerfileContent = await fs.readFile(dockerfilePath, "utf-8");
    const firstLine = dockerfileContent.trim().split("\n")[0].trim().toUpperCase();
    const validFirstInstructions = ["FROM", "ARG", "#", "COMMENT"];
    if (!validFirstInstructions.some((inst) => firstLine.startsWith(inst))) {
      issues.push(
        `Dockerfile 格式错误：第一行 "${dockerfileContent.trim().split("\n")[0].trim().slice(0, 60)}" 不是合法的 Docker 指令（必须以 FROM 或 ARG 开头，不能是 shell 命令）`
      );
    }
  } catch {
    // Dockerfile 缺失已由前置检查覆盖
  }

  if (issues.length === 0) return {};
  return { isDone: false, testResults: `[Verifier 预检失败]\n${issues.join("\n")}` };
}
