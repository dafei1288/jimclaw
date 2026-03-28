import * as fs from "fs/promises";
import * as path from "path";
import { JimClawState } from "../graph_types";
import {
  buildRepairPlan,
  buildValidationReport,
  findContractRouteDrift,
  getProtocolBusinessTestFiles,
  getProtocolTestRoots,
  getProtocolFileContract,
  isNodeJestProject,
  normalizeNodeJestTestFilePath,
  writeMeetingNote
} from "../logic_utils";

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
  const round = state.retryCount || 0;
  const issues: string[] = [];
  const filesToCreate = (state.spec?.filesToCreate || []).map((file: string) => normalizeNodeJestTestFilePath(file));
  const requirementProtocol = state.requirementProtocol || state.executionProtocol?.requirements || null;
  const language = (state.spec?.language || "").toLowerCase();
  const globToRegExp = (pattern: string) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "§§DOUBLESTAR§§")
      .replace(/\*/g, "[^/]*")
      .replace(/§§DOUBLESTAR§§/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`);
  };

  for (const file of filesToCreate) {
    try {
      await fs.access(path.join(WORKSPACE, file));
    } catch {
      issues.push(`文件缺失: ${file}`);
    }
  }

  const entryFile = state.executionProtocol?.project?.workspaceLayout?.entryFiles?.[0] || state.spec?.entryPoint;
  let entryContent = "";
  if (entryFile) {
    try {
      entryContent = await fs.readFile(path.join(WORKSPACE, entryFile), "utf-8");
    } catch {}
  }

  if (requirementProtocol?.capabilities?.frontendRequired) {
    const frontendFiles = filesToCreate.filter((file) => /^public\/.+/i.test(file) || /\.html$/i.test(file));
    if (frontendFiles.length === 0) {
      issues.push("需求覆盖失败：用户要求前端，但 filesToCreate 中不存在任何前端页面文件");
    }
    if (entryContent) {
      const hasFrontendMount = /express\.static\(|res\.sendFile\(|app\.get\(\s*["'`]\/["'`]/.test(entryContent);
      if (!hasFrontendMount) {
        issues.push(`需求覆盖失败：入口文件 ${entryFile} 未提供前端页面入口（静态目录或根路径页面）`);
      }
    }
  }

  if (requirementProtocol?.capabilities?.backendRequired) {
    const routeFiles = filesToCreate.filter((file) => getProtocolFileContract(state.executionProtocol, file)?.role === "route");
    if (routeFiles.length === 0) {
      issues.push("需求覆盖失败：用户要求后端 API，但未规划任何 route 文件");
    }
    if (entryContent) {
      for (const routeFile of routeFiles) {
        if (/routes\/health\./i.test(routeFile)) continue;
        const stem = path.basename(routeFile, path.extname(routeFile)).replace(/routes?$/i, "");
        if (stem && !new RegExp(stem, "i").test(entryContent)) {
          issues.push(`入口挂载缺失：${entryFile} 未挂载路由文件 ${routeFile}`);
        }
      }
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
    if (serverFilePatterns.test(path.basename(file)) && !file.includes("test") && !file.includes("spec") && !/\.html?$/i.test(file)) {
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

  if (isNodeJestProject(state.spec)) {
    const jestConfigPath = path.join(WORKSPACE, "jest.config.cjs");
    try {
      const jestConfigContent = await fs.readFile(jestConfigPath, "utf-8");
      const rootsMatch = jestConfigContent.match(/roots\s*:\s*\[([\s\S]*?)\]/m);
      const testMatchBlock = jestConfigContent.match(/testMatch\s*:\s*\[([\s\S]*?)\]/m);
      const configuredRoots = rootsMatch
        ? Array.from(rootsMatch[1].matchAll(/["'`](.+?)["'`]/g)).map((match) =>
            match[1].replace(/^<rootDir>\//, "").replace(/\\/g, "/")
          )
        : [];
      const configuredTestMatch = testMatchBlock
        ? Array.from(testMatchBlock[1].matchAll(/["'`](.+?)["'`]/g)).map((match) =>
            match[1].replace(/^<rootDir>\//, "").replace(/\\/g, "/")
          )
        : [];
      const expectedRoots = getProtocolTestRoots(state.executionProtocol, state.spec);
      const declaredBusinessTests = getProtocolBusinessTestFiles(state.executionProtocol, state.spec);

      for (const expectedRoot of expectedRoots) {
        if (!configuredRoots.includes(expectedRoot)) {
          issues.push(`Jest roots 未覆盖声明的测试目录 ${expectedRoot}`);
        }
      }

      for (const testFile of declaredBusinessTests) {
        const isCovered = configuredRoots.some((root) => testFile === root || testFile.startsWith(`${root}/`));
        if (!isCovered) {
          issues.push(`测试文件 ${testFile} 不在 Jest roots 覆盖范围内`);
        }
        const matchesPattern =
          configuredTestMatch.length === 0 ||
          configuredTestMatch.some((pattern) => globToRegExp(pattern).test(testFile));
        if (!matchesPattern) {
          issues.push(`测试文件 ${testFile} 不在 Jest testMatch 覆盖范围内`);
        }
      }
    } catch {
      issues.push("缺少 jest.config.cjs：Jest 项目必须显式声明测试发现范围");
    }
  }

  if (issues.length === 0) {
    const note = await writeMeetingNote(
      WORKSPACE,
      `note-verifier-r${round}`,
      "verifier",
      round,
      `Verifier 第${round}轮：静态预检通过`,
      `# Verifier 第${round}轮\n\n## 预检结论\n- 状态：通过\n- 检查文件数：${filesToCreate.length}\n`
    );
    return {
      meetingNotes: [note],
      validationReport: buildValidationReport([], { status: "pass", blocking: false }),
      repairPlan: null,
      protocolFailures: [],
      lastFailedNode: "",
      lastFailureSummary: "",
    };
  }

  const output = `[Verifier 预检失败]\n${issues.join("\n")}`;
  const hasContractDrift = issues.some((issue) => /契约漂移/.test(issue));
  const hasEnvironmentGap = issues.some((issue) => /jest: not found|npm ERR|node_modules|module not found/i.test(issue));
  const failureType = hasEnvironmentGap
    ? "environment_gap"
    : hasContractDrift
      ? "implementation_bug"
      : "planning_gap";
  const validationReport = buildValidationReport(
    issues.map((issue) => ({
      summary: issue,
      evidence: [issue],
    })),
    { failureType, blocking: true }
  );
  const note = await writeMeetingNote(
    WORKSPACE,
    `note-verifier-r${round}`,
    "verifier",
    round,
    `Verifier 第${round}轮：发现 ${issues.length} 个预检问题`,
    `# Verifier 第${round}轮\n\n## 预检结论\n- 状态：失败\n- 问题数：${issues.length}\n\n## 问题列表\n\`\`\`text\n${issues.join("\n")}\n\`\`\`\n`
  );
  return {
    isDone: false,
    testResults: output,
    validationReport,
    repairPlan: buildRepairPlan(validationReport),
    protocolFailures: issues.map((issue) => ({
      type: (/Jest roots|Jest testMatch|测试文件/.test(issue)
        ? "test_discovery_gap"
        : /契约漂移/.test(issue)
          ? "contract_drift"
          : "layout_mismatch") as "test_discovery_gap" | "contract_drift" | "layout_mismatch",
      node: "verifier",
      summary: issue,
      evidence: [issue],
      blocking: true,
    })),
    meetingNotes: [note],
    lastFailedNode: "verifier",
    lastFailureSummary: issues[0] || "Verifier 预检失败",
  };
}
