import * as fs from "fs/promises";
import * as path from "path";
import * as ts from "typescript";
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

type VerifierFailureType = "planning_gap" | "implementation_bug" | "environment_gap" | "runtime_gap";

function formatTsDiagnostics(fileTarget: string, content: string, diagnostics: readonly ts.Diagnostic[]): string {
  return diagnostics
    .map((diag) => {
      const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
      if (typeof diag.start !== "number") {
        return `语法错误: ${message}`;
      }
      const sourceFile = ts.createSourceFile(fileTarget, content, ts.ScriptTarget.ES2020, true);
      const position = sourceFile.getLineAndCharacterOfPosition(diag.start);
      return `语法错误(${fileTarget}:L${position.line + 1}:C${position.character + 1}): ${message}`;
    })
    .join("; ");
}

function getSyntaxValidationError(fileTarget: string, content: string): string | null {
  if (!/\.(ts|tsx|js|jsx)$/i.test(fileTarget)) return null;
  const diagnostics = ts.transpileModule(content, {
    fileName: fileTarget,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
  }).diagnostics || [];
  if (diagnostics.length === 0) return null;
  return formatTsDiagnostics(fileTarget, content, diagnostics);
}

function extractIssueFile(issue: string): string | undefined {
  const explicitFileMatch = issue.match(/(?:文件|服务文件|测试文件|入口文件)\s+([^\s:，,]+)/);
  if (explicitFileMatch?.[1]) {
    return explicitFileMatch[1].replace(/\\/g, "/");
  }
  const pathMatch = issue.match(/([A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|json|cjs|mjs|html|py|go|ya?ml)|Dockerfile)/);
  return pathMatch?.[1] ? pathMatch[1].replace(/\\/g, "/") : undefined;
}

function classifyVerifierIssue(issue: string): {
  failureType: VerifierFailureType;
  protocolType: "layout_mismatch" | "contract_drift" | "runtime_mismatch" | "test_discovery_gap" | "tooling_unavailable";
} {
  if (
    /缺少 package\.json|缺少 jest\.config\.cjs|运行时框架 .*devDependencies|jest: not found|npm ERR|node_modules|module not found/i.test(issue)
  ) {
    return { failureType: "environment_gap", protocolType: "tooling_unavailable" };
  }
  if (/未找到监听声明|入口挂载缺失|前端页面入口|健康检查/i.test(issue)) {
    return { failureType: "runtime_gap", protocolType: "runtime_mismatch" };
  }
  if (/契约漂移|语法错误/i.test(issue)) {
    return { failureType: "implementation_bug", protocolType: "contract_drift" };
  }
  if (/Jest roots|Jest testMatch|测试文件 .*覆盖范围/.test(issue)) {
    return { failureType: "planning_gap", protocolType: "test_discovery_gap" };
  }
  return { failureType: "planning_gap", protocolType: "layout_mismatch" };
}

function isInfrastructureFailureOutput(text: string): boolean {
  return /(基础设施|docker-compose|docker run|spawn EPERM|spawn ENOENT|EACCES|OCI runtime|容器未成功启动|容器 ID 为空)/i.test(String(text || ""));
}

/**
 * Verifier 节点：纯静态预检，无 LLM 调用，运行极快。
 * 检查项：文件存在、入口挂载/覆盖、测试断言、契约漂移、依赖分类、Dockerfile 头部。
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
  const stagedValidationMode = Boolean(state.validationCheckpointRequested);
  const completedTaskFiles = new Set(
    (state.subTasks || [])
      .filter((task) => task.status === "completed")
      .map((task) => normalizeNodeJestTestFilePath(task.fileTarget))
  );
  const activeFiles = stagedValidationMode && completedTaskFiles.size > 0
    ? filesToCreate.filter((file) => completedTaskFiles.has(file))
    : filesToCreate;
  const plannedFiles = filesToCreate;
  const requirementProtocol = state.requirementProtocol || state.executionProtocol?.requirements || null;
  const language = (state.spec?.language || "").toLowerCase();
  if (!state.containerId && isInfrastructureFailureOutput(`${state.testResults || ""}\n${state.lastFailureSummary || ""}\n${state.blockedReason || ""}`)) {
    const issue = state.testResults || state.lastFailureSummary || "[Verifier] 基础设施未就绪，跳过静态预检";
    const validationReport = buildValidationReport(
      [{ summary: issue, evidence: [issue] }],
      { failureType: "environment_gap", blocking: true }
    );
    const repairPlan = buildRepairPlan(validationReport);
    const note = await writeMeetingNote(
      WORKSPACE,
      `note-verifier-r${round}`,
      "verifier",
      round,
      `Verifier 第${round}轮：基础设施未就绪，回退环境修复`,
      `# Verifier 第${round}轮\n\n## 预检结论\n- 状态：跳过\n- 原因：检测到基础设施层失败，避免把环境问题误判为规划/实现问题\n\n## 原始信息\n\`\`\`text\n${issue}\n\`\`\`\n`
    );
    return {
      testResults: `[Verifier 预检失败]\n${issue}`,
      validationReport,
      repairPlan,
      protocolFailures: validationReport.findings.map((finding) => ({
        type: "tooling_unavailable" as const,
        node: "verifier",
        file: finding.file,
        summary: finding.summary,
        evidence: finding.evidence || [],
        blocking: true,
      })),
      meetingNotes: [note],
      lastFailedNode: "verifier",
      lastFailureSummary: issue.slice(0, 120),
    };
  }

  const globToRegExp = (pattern: string) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "§§DOUBLESTAR§§")
      .replace(/\*/g, "[^/]*")
      .replace(/§§DOUBLESTAR§§/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`);
  };

  for (const file of activeFiles) {
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
    const frontendFiles = plannedFiles.filter((file) => /^public\/.+/i.test(file) || /\.html$/i.test(file));
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
    const routeFiles = plannedFiles.filter((file) => getProtocolFileContract(state.executionProtocol, file)?.role === "route");
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

  const testFilePatterns = /test|spec/i;
  const assertionPattern = /expect\(|assert\.|\.toBe\(|\.toEqual\(|\.assert\(|test\(|it\(/;
  for (const file of activeFiles) {
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

  for (const file of activeFiles) {
    if (/routes?[\\/].+\.[tj]s$/i.test(file) || /Routes?\.[tj]s$/i.test(path.basename(file))) {
      try {
        const content = await fs.readFile(path.join(WORKSPACE, file), "utf-8");
        const routeDrift = findContractRouteDrift(content, state.apiContract, {
          ownedEndpoints: getProtocolFileContract(state.executionProtocol, file)?.ownedEndpoints || [],
        });
        issues.push(...routeDrift.map((item) => `契约漂移 ${file}: ${item}`));
      } catch {
        // 文件缺失已由前置检查覆盖
      }
    }
  }

  for (const file of activeFiles) {
    if (!/\.(ts|tsx|js|jsx)$/i.test(file)) continue;
    try {
      const content = await fs.readFile(path.join(WORKSPACE, file), "utf-8");
      const syntaxError = getSyntaxValidationError(file, content);
      if (syntaxError) {
        issues.push(syntaxError);
      }
    } catch {
      // 文件缺失已由前置检查覆盖
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
      const declaredBusinessTests = getProtocolBusinessTestFiles(state.executionProtocol, state.spec)
        .filter((file) => !stagedValidationMode || completedTaskFiles.has(file));

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
        `# Verifier 第${round}轮\n\n## 预检结论\n- 状态：通过\n- 模式：${stagedValidationMode ? "阶段验证" : "完整验证"}\n- 检查文件数：${activeFiles.length}\n`
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
  const classifiedIssues = issues.map((issue) => {
    const category = classifyVerifierIssue(issue);
    return {
      issue,
      file: extractIssueFile(issue),
      ...category,
    };
  });
  const failureType = classifiedIssues.some((item) => item.failureType === "environment_gap")
    ? "environment_gap"
    : classifiedIssues.some((item) => item.failureType === "runtime_gap")
      ? "runtime_gap"
      : classifiedIssues.some((item) => item.failureType === "implementation_bug")
        ? "implementation_bug"
        : "planning_gap";
  const validationReport = buildValidationReport(
    classifiedIssues.map((item) => ({
      summary: item.issue,
      file: item.file,
      evidence: [item.issue],
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
    protocolFailures: classifiedIssues.map((item) => ({
      type: item.protocolType,
      node: "verifier",
      file: item.file,
      summary: item.issue,
      evidence: [item.issue],
      blocking: true,
    })),
    meetingNotes: [note],
    lastFailedNode: "verifier",
    lastFailureSummary: issues[0] || "Verifier 预检失败",
  };
}
