import * as path from "path";
import { JimClawState, Issue, ConsensusProgress, ProtocolFailure, RepairLedgerEntry } from "../graph_types";
import { BaseAgent } from "../agent";
import {
  analyzeTestProblem,
  buildFailureFingerprint,
  buildRepairPlan,
  buildValidationReport,
  buildSystemContext,
  extractFailureEvidence,
  writeMeetingNote
} from "../logic_utils";
import { extractText, parseJsonFromResponse } from "../../utils/common";

const QA_MODEL_TIMEOUT_MS = 45000;

/**
 * QA 节点：负责测试结果分析、定级并更新 IssueTracker
 */
export async function qaNode(
  state: JimClawState,
  agents: { qa: BaseAgent },
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  function buildIssuesFromProtocolFailures(protocolFailures: ProtocolFailure[], detectedRound: number): Issue[] {
    return protocolFailures.map((failure, index) => ({
      id: `BUG-PROTOCOL-${index + 1}`,
      title: `${failure.file || failure.node} 协议未通过`,
      description: failure.summary,
      severity: failure.blocking ? "major" as const : "minor" as const,
      status: "open" as const,
      relatedFiles: failure.file ? [failure.file] : [],
      rawErrorSnippet: failure.evidence?.join(" | ") || failure.summary,
      detectedRound,
    }));
  }

  function buildVerifierFallbackIssues(output: string, detectedRound: number): Issue[] {
    const verifierLines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("[Verifier 预检失败]"));

    return verifierLines.map((line, index) => {
      const fileMatch = line.match(/(?:文件|服务文件|测试文件)\s+([^\s:，,]+)/);
      const relatedFile = fileMatch?.[1] || "Verifier";
      return {
        id: `BUG-VERIFIER-${index + 1}`,
        title: `${relatedFile} 预检未通过`,
        description: line,
        severity: "major" as const,
        status: "open" as const,
        relatedFiles: fileMatch?.[1] ? [fileMatch[1]] : [],
        rawErrorSnippet: line,
        detectedRound,
      };
    });
  }

  function mapProtocolFailureType(
    failures: ProtocolFailure[]
  ): "planning_gap" | "implementation_bug" | "environment_gap" | "runtime_gap" {
    if (failures.some((failure) => failure.type === "tooling_unavailable")) return "environment_gap";
    if (failures.some((failure) => failure.type === "runtime_mismatch")) return "runtime_gap";
    if (failures.some((failure) => failure.type === "contract_drift")) return "implementation_bug";
    return "planning_gap";
  }

  function inferQaFailureType(
    issues: Issue[],
    opts: {
      verifierFailed: boolean;
      deploymentFail: boolean;
      environmentProblem: boolean;
    }
  ): "planning_gap" | "implementation_bug" | "environment_gap" | "runtime_gap" {
    if (opts.environmentProblem) return "environment_gap";
    if (opts.deploymentFail) return "runtime_gap";
    if (issues.some((issue) => /契约漂移|导出|语法|类型|阻塞/.test(`${issue.title} ${issue.description}`))) {
      return "implementation_bug";
    }
    if (opts.verifierFailed) return "planning_gap";
    return "implementation_bug";
  }

  function isHostEnvironmentBlocked(text: string): boolean {
    return /(spawn EPERM|spawn ENOENT|docker(\.exe)? .*not found|docker-compose .*not found|Docker Desktop is not running|permission denied while trying to connect to the Docker daemon|无法连接 Docker|宿主环境阻塞)/i.test(String(text || ""));
  }

  function normalizeFileTarget(file: string | undefined | null): string {
    let normalized = String(file || "").replace(/\\/g, "/").trim();
    if (!normalized) return "";
    normalized = normalized.replace(/^\.\/+/, "").replace(/^\/+/, "");
    const workspacePosix = String(WORKSPACE || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (workspacePosix) {
      while (normalized.startsWith(`${workspacePosix}/`)) {
        normalized = normalized.slice(workspacePosix.length + 1);
      }
      const workspaceName = path.posix.basename(workspacePosix);
      while (workspaceName && normalized.startsWith(`${workspaceName}/`)) {
        normalized = normalized.slice(workspaceName.length + 1);
      }
    }
    if (/workspace\/run_[^/]+\//.test(normalized)) {
      const segments = normalized.split(/workspace\/run_[^/]+\//g).filter(Boolean);
      normalized = segments[segments.length - 1] || normalized;
    }
    return normalized.replace(/^\.\/+/, "").replace(/^\/+/, "");
  }

  function collectKnownProjectFiles(state: JimClawState): string[] {
    return Array.from(
      new Set([
        ...((state.subTasks || []).map((task) => normalizeFileTarget(task.fileTarget))),
        ...(((state.spec as any)?.filesToCreate || []).map((file: string) => normalizeFileTarget(file))),
      ].filter(Boolean))
    );
  }

  function buildBasenameIndex(fileTargets: string[]): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const file of fileTargets) {
      const base = path.posix.basename(file);
      if (!base) continue;
      const existing = index.get(base) || [];
      existing.push(file);
      index.set(base, existing);
    }
    return index;
  }

  function inferFilesFromText(
    text: string,
    knownFiles: string[],
    basenameIndex: Map<string, string[]>
  ): string[] {
    const normalizedText = String(text || "");
    if (!normalizedText.trim()) return [];
    const hits = new Set<string>();

    for (const file of knownFiles) {
      if (normalizedText.includes(file)) hits.add(file);
    }

    for (const [base, files] of basenameIndex.entries()) {
      if (files.length !== 1) continue;
      const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|[^\\w./-])${escaped}([^\\w./-]|$)`).test(normalizedText)) {
        hits.add(files[0]);
      }
    }

    return Array.from(hits);
  }

  function inferConfigOwnedFiles(text: string, knownFiles: Set<string>): string[] {
    const normalizedText = String(text || "");
    const hits = new Set<string>();
    const dependencyGap =
      /cannot find module\s+['"]([^'"./][^'"]*)['"]|module not found|missing dependency|依赖缺失|未安装依赖|package\.json|npm install|pnpm install|yarn install|runtime dependency/i;
    const tsConfigGap = /tsconfig|compileroptions|typescript|ts\d{4}|noUnusedLocals|moduleResolution/i;
    const jestGap = /jest|ts-jest|@types\/jest|jest\.config/i;
    const vitestGap = /vitest|vite\.config|vitest\.config/i;

    if (knownFiles.has("package.json") && dependencyGap.test(normalizedText)) {
      hits.add("package.json");
    }
    if (knownFiles.has("tsconfig.json") && tsConfigGap.test(normalizedText)) {
      hits.add("tsconfig.json");
    }
    for (const file of knownFiles) {
      if (/^jest\.config\.(cjs|js|ts)$/i.test(file) && jestGap.test(normalizedText)) hits.add(file);
      if (/^vitest\.config\.(ts|js|mjs)$/i.test(file) && vitestGap.test(normalizedText)) hits.add(file);
    }
    return Array.from(hits);
  }

  type CompileFailure = {
    file: string;
    line?: number;
    column?: number;
    code?: string;
    message: string;
    raw: string;
  };

  function extractCompileFailures(text: string): CompileFailure[] {
    const output = String(text || "");
    if (!output.trim()) return [];
    const failures: CompileFailure[] = [];
    const seen = new Set<string>();
    const patterns: RegExp[] = [
      /([^\s:]+?\.[a-zA-Z0-9]+)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*([^\r\n]+)/g, // tsc
      /([^\s:]+?\.[a-zA-Z0-9]+):(\d+):(\d+):\s*error(?:\[[^\]]+\])?:\s*([^\r\n]+)/g, // rustc/gcc/eslint-like
      /([^\s:]+?\.[a-zA-Z0-9]+):(\d+):\s*([^\r\n]+error[^\r\n]*)/gi, // file:line: ...error...
    ];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(output)) !== null) {
        const file = normalizeFileTarget(match[1]);
        if (!file) continue;
        const line = Number(match[2] || 0) || undefined;
        const column = Number(match[3] || 0) || undefined;
        const code = match[4]?.startsWith("TS") ? match[4] : undefined;
        const message = (match[5] || match[4] || "").trim() || "编译失败";
        const raw = match[0].trim();
        const key = `${file}|${line || 0}|${column || 0}|${code || ""}|${message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        failures.push({ file, line, column, code, message, raw });
      }
    }
    return failures;
  }

  function isTransientEnvironmentFailure(text: string): boolean {
    return /spawn\s+\w+\s+ENOENT|spawn EPERM|EADDRINUSE|EACCES|docker|connect ECONNREFUSED|timed out|timeout|port already in use/i.test(String(text || ""));
  }

  function augmentIssueOwnership(
    state: JimClawState,
    issues: Issue[],
    failingTestFiles: string[],
    rawUnitOutput: string,
    compileFailures: CompileFailure[]
  ): { issues: Issue[]; reopenFiles: string[] } {
    const knownFiles = collectKnownProjectFiles(state);
    const knownFileSet = new Set(knownFiles);
    const basenameIndex = buildBasenameIndex(knownFiles);
    const normalizedFailingTests = failingTestFiles.map((file) => normalizeFileTarget(file)).filter(Boolean);
    const validationText = (state.validationReport?.findings || [])
      .flatMap((finding: any) => [finding?.summary, ...(finding?.evidence || []), finding?.file])
      .filter(Boolean)
      .join("\n");
    const globalText = [rawUnitOutput, validationText, state.lastFailureSummary || "", state.blockedReason || ""]
      .filter(Boolean)
      .join("\n");
    const compileFailureFiles = compileFailures.map((item) => normalizeFileTarget(item.file)).filter(Boolean);
    const globalConfigFiles = inferConfigOwnedFiles(globalText, knownFileSet);
    const augmentedIssues = issues.map((issue) => {
      const issueText = [issue.title, issue.description, issue.rawErrorSnippet, validationText].filter(Boolean).join("\n");
      const nextFiles = new Set((issue.relatedFiles || []).map((file) => normalizeFileTarget(file)).filter(Boolean));
      for (const file of inferFilesFromText(issueText, knownFiles, basenameIndex)) nextFiles.add(file);
      for (const file of inferConfigOwnedFiles(issueText, knownFileSet)) nextFiles.add(file);
      for (const file of normalizedFailingTests) {
        if (issueText.includes(file)) nextFiles.add(file);
      }
      for (const file of compileFailureFiles) {
        if (issueText.includes(file) || issueText.includes(path.posix.basename(file))) nextFiles.add(file);
      }
      return {
        ...issue,
        relatedFiles: Array.from(nextFiles),
      };
    });

    const reopenFiles = new Set<string>([
      ...normalizedFailingTests,
      ...compileFailureFiles,
      ...globalConfigFiles,
      ...augmentedIssues.filter((issue) => issue.status === "open").flatMap((issue) => issue.relatedFiles || []),
    ]);

    return {
      issues: augmentedIssues,
      reopenFiles: Array.from(reopenFiles).filter(Boolean),
    };
  }

  startSpan("qa");
  emit("phase-change", "System", "verification");

  const round = state.retryCount || 0;
  const rawUnitOutput = state.testResults || "";
  let failureEvidence = extractFailureEvidence(rawUnitOutput, state.deploymentStatus, state.blockedReason);
  const hasPersistedQaFailure =
    !failureEvidence.hasBlockingFailure &&
    Boolean(
      state.validationReport?.blocking &&
      ((state.qaFailures?.failedFiles?.length || 0) > 0 || state.lastFailedNode || state.lastFailureSummary)
    );
  if (hasPersistedQaFailure) {
    failureEvidence = {
      ...failureEvidence,
      hasBlockingFailure: true,
      coderBlocked: state.lastFailedNode === "coder" || /Coder 阻塞失败/.test(state.lastFailureSummary || ""),
      verifierFailed: state.lastFailedNode === "verifier" || state.validationReport?.failureType === "planning_gap",
      deploymentFailed: state.lastFailedNode === "deploy" || state.validationReport?.failureType === "runtime_gap",
    };
  }
  const unitTestFail = failureEvidence.hasBlockingFailure && !failureEvidence.deploymentFailed;
  const deploymentFail = failureEvidence.deploymentFailed;
  const failureFingerprint = buildFailureFingerprint(rawUnitOutput);
  const sameFailureCount = failureFingerprint && state.failureFingerprint === failureFingerprint
    ? (state.sameFailureCount || 0) + 1
    : (failureFingerprint ? 1 : 0);
  const problem = analyzeTestProblem(rawUnitOutput, round, Boolean(state.mediationDirectives?.length));
  const knownProjectFiles = new Set(collectKnownProjectFiles(state));
  const configOwnedFailure =
    !isTransientEnvironmentFailure([rawUnitOutput, state.blockedReason || "", state.lastFailureSummary || ""].join("\n")) &&
    inferConfigOwnedFiles(
      [
        rawUnitOutput,
        state.validationReport?.findings?.map((item: any) => [item?.summary, ...(item?.evidence || []), item?.file].filter(Boolean).join("\n")).join("\n") || "",
        state.lastFailureSummary || "",
      ].join("\n"),
      knownProjectFiles
    ).length > 0;
  const hostEnvironmentBlocked = isHostEnvironmentBlocked(
    [rawUnitOutput, state.blockedReason || "", state.lastFailureSummary || ""].join("\n")
  );
  const environmentProblemDetected =
    hostEnvironmentBlocked ||
    (problem.type === "environment_problem" && !configOwnedFailure) ||
    state.validationReport?.failureType === "environment_gap" ||
    state.lastFailedNode === "env_guard" ||
    /^\[EnvGuard\]/.test(state.blockedReason || "") ||
    /^\[EnvGuard\]/.test(rawUnitOutput);

  // P0-D：拆分单元测试输出与部署错误，避免 QA 标签混乱
  const unitTestSection = rawUnitOutput.split("[部署验证失败]")[0].trim() || rawUnitOutput;
  const deployErrorSection = rawUnitOutput.includes("[部署验证失败]")
    ? rawUnitOutput.split("[部署验证失败]").slice(1).join("[部署验证失败]").trim()
    : (deploymentFail ? "部署健康检查失败，无详细日志" : "无");

  // 1. 如果完全没有错误，且之前的 Issue 都已解决，则直接通过
  const openIssues = (state.issueTracker || []).filter(i => i.status === 'open');
  const hasPendingTasks = (state.subTasks || []).some((task) => task.status !== "completed");
  if (!failureEvidence.hasBlockingFailure && hasPendingTasks && !hostEnvironmentBlocked) {
    const noteId = `note-qa-r${round}`;
    const pendingCount = state.subTasks.filter((task) => task.status !== "completed").length;
    const resumedFromCheckpoint = Boolean(state.validationCheckpointRequested);
    const summary = resumedFromCheckpoint
      ? `QA 第${round}轮：阶段验证通过，恢复 coder 完成剩余 ${pendingCount} 个文件`
      : `QA 第${round}轮：当前无阻塞失败，恢复 coder 完成剩余 ${pendingCount} 个文件`;
    const fullContent = `# QA 第${round}轮阶段验证纪要

## 判定结论
- 结论：阶段验证通过
- 说明：当前核心骨架已可通过验证，但仍存在待补齐文件，因此恢复 coder 继续实现，不进入 deploy。

## 待完成文件
${state.subTasks.filter((task) => task.status !== "completed").map((task) => `- ${task.fileTarget}`).join("\n") || "无"}
`;
    const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "qa", round, summary, fullContent);
    const validationReport = buildValidationReport([], { status: "pass", blocking: false });
    const result = {
      isDone: false,
      retryCount: state.retryCount || 0,
      qaFailures: null,
      recoveredEnvironment: false,
      failureFingerprint: "",
      sameFailureCount: 0,
      validationReport,
      repairPlan: null,
      blockedReason: "",
      validationCheckpointRequested: false,
      validationCheckpointCompleted: resumedFromCheckpoint,
      validationCheckpointReason: "",
      resumeAfterValidation: true,
      meetingNotes: [meetingNote],
    };
    await saveBoulder({ ...state, ...result }, "qa_checkpoint_resume");
    return result;
  }

  if (!failureEvidence.hasBlockingFailure && !environmentProblemDetected && openIssues.length === 0 && !hasPendingTasks) {
    const validationReport = buildValidationReport([], { status: "pass", blocking: false });
    return {
      isDone: true,
      qaFailures: null,
      recoveredEnvironment: false,
      failureFingerprint: "",
      sameFailureCount: 0,
      validationReport,
      repairPlan: null,
    };
  }

  // 1.0 如果当前没有任何失败证据，但还残留历史 open issues，
  // 说明这些工单已经失去现时性，不能再阻塞流程。
  if (!failureEvidence.hasBlockingFailure && openIssues.length > 0) {
    const resolvedIssues = (state.issueTracker || []).map((issue) =>
      issue.status === "open"
        ? {
            ...issue,
            status: "resolved" as const,
          }
        : issue
    );
    const consensusProgress: ConsensusProgress = {
      completedFiles: state.consensusProgress?.completedFiles || [],
      pendingFiles: state.consensusProgress?.pendingFiles || [],
      currentRound: round,
      openIssues: [],
    };
    const noteId = `note-qa-r${round}`;
    const summary = `QA 第${round}轮：放行，自动关闭 ${openIssues.length} 个历史工单`;
    const fullContent = `# QA 第${round}轮审计纪要

## 判定结论
- 结论：放行
- 是否存在失败证据：否
- 自动关闭的历史工单数：${openIssues.length}

## 说明
当前 terminal/verifier/deploy/coder 均未提供新的失败证据，因此历史遗留工单不再阻塞流程，已统一标记为 resolved。

## 已关闭工单
\`\`\`json
${JSON.stringify(resolvedIssues.filter((issue) => issue.status === "resolved"), null, 2)}
\`\`\`
`;
    const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "qa", round, summary, fullContent);
    const validationReport = buildValidationReport([], { status: "pass", blocking: false });
    const result = {
      issueTracker: resolvedIssues,
      isDone: true,
      retryCount: state.retryCount || 0,
      recoveredEnvironment: false,
      failureFingerprint: "",
      sameFailureCount: 0,
      qaFailures: null,
      protocolFailures: [],
      blockedReason: "",
      consensusProgress,
      meetingNotes: [meetingNote],
      validationReport,
      repairPlan: null,
      lastFailedNode: "",
      lastFailureSummary: "",
    };
    await saveBoulder({ ...state, ...result }, "qa");
    return result;
  }

  // 1.1 环境问题优先自动修复，避免把依赖缺失误判为代码缺陷反复返工
  if (environmentProblemDetected) {
    const environmentSummary =
      state.validationReport?.findings?.[0]?.summary ||
      state.lastFailureSummary ||
      state.blockedReason ||
      problem.reason ||
      "检测到环境类故障";
    const environmentFingerprint = `env:${environmentSummary}`;
    const environmentSameFailureCount =
      state.failureFingerprint === environmentFingerprint
        ? (state.sameFailureCount || 0) + 1
        : 1;
    emit("thinking", "System", `检测到环境类故障，转交 EnvGuard 统一修复：${environmentSummary}`, {});
    const ledger: RepairLedgerEntry[] = [{
      round,
      phase: "qa",
      action: "识别环境类故障并转交 EnvGuard",
      result: "success",
      fingerprint: failureFingerprint || undefined,
    }];
    const validationReport = buildValidationReport(
      [{
        summary: problem.reason || "检测到环境类故障",
        evidence: [rawUnitOutput || problem.reason || "environment problem"],
      }],
      { failureType: "environment_gap", blocking: true }
    );
    const result = {
      isDone: false,
      retryCount: (state.retryCount || 0) + 1,
      recoveredEnvironment: false,
      failureFingerprint: environmentFingerprint,
      sameFailureCount: environmentSameFailureCount,
      qaFailures: { failedFiles: [], testErrors: [environmentSummary], failedTestNames: [] },
      repairLedger: ledger,
      validationReport,
      repairPlan: buildRepairPlan(validationReport),
      validationCheckpointRequested: false,
      validationCheckpointCompleted: false,
      validationCheckpointReason: "",
      resumeAfterValidation: false,
      lastFailedNode: "qa",
      lastFailureSummary: environmentSummary,
    };
    await saveBoulder({ ...state, ...result }, "qa_env_fix");
    return result;
  }

  // 静态提取失败的测试文件（比 LLM 更可靠）
  const failingTestFiles: string[] = [];
  const failPattern = /^FAIL\s+([\w/.+-]+\.(?:test|spec)\.[tj]s)/gm;
  let m;
  while ((m = failPattern.exec(rawUnitOutput)) !== null) {
    failingTestFiles.push(m[1]);
  }

  const isCoderBlockedFailure = failureEvidence.coderBlocked;
  const compileFailures = extractCompileFailures(rawUnitOutput);
  const compileFailureFiles = Array.from(new Set(compileFailures.map((item) => normalizeFileTarget(item.file)).filter(Boolean)));
  const shouldBypassQaLlmForCompileFailures =
    compileFailures.length > 0 &&
    !isCoderBlockedFailure &&
    !failureEvidence.verifierFailed &&
    !deploymentFail;
  if (isCoderBlockedFailure) {
    const blockedFiles = Array.from(new Set(state.qaFailures?.failedFiles || []));
    const blockedErrors = state.qaFailures?.testErrors?.length
      ? state.qaFailures.testErrors
      : [state.blockedReason].filter(Boolean) as string[];
    const issues: Issue[] = blockedFiles.map((file, index) => ({
      id: `BUG-CODER-BLOCK-${index + 1}`,
      title: `${file} 阻塞了本轮生成`,
      description: `Coder 在生成 ${file} 时遇到阻塞错误，必须先修复该文件后才能继续后续文件生成。请优先处理这一个阻塞点，暂不要扩散到仍处于 pending 的文件。`,
      severity: "major",
      status: "open",
      relatedFiles: [file],
      rawErrorSnippet: blockedErrors[index] || blockedErrors[0] || state.blockedReason,
      detectedRound: round,
    }));

    const consensusProgress: ConsensusProgress = {
      completedFiles: state.consensusProgress?.completedFiles || [],
      pendingFiles: state.consensusProgress?.pendingFiles || [],
      currentRound: round,
      openIssues: issues.map((i) => `${i.id} ${i.title}`),
    };

    const noteId = `note-qa-r${round}`;
    const summary = `QA 第${round}轮：聚焦 Coder 阻塞文件 ${blockedFiles.join(", ")}`;
    const fullContent = `# QA 第${round}轮阻塞审计纪要\n\n## 阻塞原因\n${state.blockedReason}\n\n## 聚焦工单\n\`\`\`json\n${JSON.stringify(issues, null, 2)}\n\`\`\`\n`;
    const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "qa", round, summary, fullContent);
    const validationReport = buildValidationReport(
      blockedErrors.map((error, index) => ({
        summary: error,
        file: blockedFiles[index] || blockedFiles[0],
        evidence: [error],
      })),
      { failureType: "implementation_bug", blocking: true }
    );

    const result = {
      issueTracker: issues,
      isDone: false,
      retryCount: (state.retryCount || 0) + 1,
      recoveredEnvironment: false,
      failureFingerprint,
      sameFailureCount,
      qaFailures: {
        failedFiles: blockedFiles,
        testErrors: blockedErrors,
        failedTestNames: []
      },
      validationReport,
      repairPlan: buildRepairPlan(validationReport),
      consensusProgress,
      meetingNotes: [meetingNote],
      lastFailedNode: "coder",
      lastFailureSummary: state.blockedReason || blockedErrors[0] || "Coder 阻塞失败",
    };

    await saveBoulder({ ...state, ...result }, "qa");
    return result;
  }

  const blockingProtocolFailures = (state.protocolFailures || []).filter((item) => item?.blocking);
  if (blockingProtocolFailures.length > 0) {
    const issues = buildIssuesFromProtocolFailures(blockingProtocolFailures, round);
    const consensusProgress: ConsensusProgress = {
      completedFiles: state.consensusProgress?.completedFiles || [],
      pendingFiles: state.consensusProgress?.pendingFiles || [],
      currentRound: round,
      openIssues: issues.map((issue) => `${issue.id} ${issue.title}`),
    };
    const primaryFailure = blockingProtocolFailures[0];
    const failureType = mapProtocolFailureType(blockingProtocolFailures);
    const noteId = `note-qa-r${round}`;
    const summary = `QA 第${round}轮：协议阻塞 ${blockingProtocolFailures.length} 项`;
    const fullContent = `# QA 第${round}轮协议审计纪要

## 判定结论
- 结论：阻塞
- QA 是否调用 LLM：否
- 协议阻塞项数：${blockingProtocolFailures.length}

## 协议失败
\`\`\`json
${JSON.stringify(blockingProtocolFailures, null, 2)}
\`\`\`

## 生成工单
\`\`\`json
${JSON.stringify(issues, null, 2)}
\`\`\`
`;
    const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "qa", round, summary, fullContent);
    const validationReport = buildValidationReport(
      blockingProtocolFailures.map((failure) => ({
        summary: failure.summary,
        file: failure.file,
        evidence: failure.evidence || [failure.summary],
      })),
      { failureType, blocking: true }
    );
    const result = {
      issueTracker: issues,
      isDone: false,
      retryCount: (state.retryCount || 0) + 1,
      recoveredEnvironment: false,
      failureFingerprint,
      sameFailureCount,
      qaFailures: {
        failedFiles: Array.from(new Set(issues.flatMap((issue) => issue.relatedFiles))),
        testErrors: issues.map((issue) => `${issue.title}: ${issue.description}`),
        failedTestNames: [],
      },
      validationReport,
      repairPlan: buildRepairPlan(validationReport),
      consensusProgress,
      meetingNotes: [meetingNote],
      lastFailedNode: primaryFailure.node || "qa",
      lastFailureSummary: primaryFailure.summary || "执行协议未通过",
    };

    await saveBoulder({ ...state, ...result }, "qa");
    return result;
  }

  // 2. 唤醒 QA (清扬) 进行深度分析
  const prompt = `你现在是首席测试审计员。请根据以下信息分析系统质量并提交/更新 [缺陷工单 (Issues)]。

[项目需求与契约]：
- 任务契约：${JSON.stringify(state.contract)}
- 接口契约：${JSON.stringify(state.apiContract)}

[当前运行实测数据]：
- 单元测试结果：\n${unitTestSection}
- 部署连通性状态：${state.deploymentStatus?.status}
- 部署错误详情：${deployErrorSection}

[当前存量工单]：
${JSON.stringify(state.issueTracker || [])}

[你的任务]：
1. 识别新的 Bug，并为每个 Bug 创建唯一的 ID（如 BUG-001）。
2. 定级严重程度：
   - critical: 容器崩溃、服务不通、核心功能完全失效。
   - major: 业务逻辑错误、测试用例不通过。
   - minor: 格式问题、警告信息、不影响主流程的小瑕疵。
3. 验证 [存量工单]：只有在单元测试输出中能看到该具体错误已消失时，才将工单标记为 "resolved"。
   **铁律**：如果单元测试结果中仍然显示 "FAIL tests/xxx.test.ts"，则该测试文件相关的工单绝对不能标记为 resolved。
4. 提炼修复建议：不要只给报错，要告诉 Coder 应该改哪里。
5. **文件归因铁律**：
   - 如果错误信息显示 "FAIL tests/foo.test.ts" 或测试断言失败（如 expect(...).toBeDefined()），则 relatedFiles 必须首先包含 "tests/foo.test.ts"。
   - 如果是 TypeScript 编译错误（如 TS6133: 'X' is declared but never read），relatedFiles 必须包含报错的测试文件。
   - 只有当错误明确来自 src/ 的源文件（如接口不匹配、方法不存在），才将源文件列入 relatedFiles。
   - 常见陷阱：测试断言失败（mock.calls[0][0] 为 undefined）很可能是测试文件的 mock 状态污染（beforeEach 调用了 mock 导致 calls 数组非空），应修复测试文件，而非源文件。
6. **Jest mock 污染检测**：如果测试中使用了 mock.calls[0][0] 但 beforeEach 中调用了 mock 函数（如 register/setup），则问题根因是测试文件需要在 beforeEach 末尾添加 mockClear()，relatedFiles 应为测试文件。

请严格输出 JSON 数组格式：{"issues": [{"id": "...", "title": "...", "description": "...", "severity": "...", "status": "...", "relatedFiles": ["..."], "rawErrorSnippet": "...", "detectedRound": ${round}}]}
请确保内容使用中文。`;

  let issues: Issue[] = [];
  let qaModelFallbackReason = "";
  if (shouldBypassQaLlmForCompileFailures) {
    issues = compileFailures.map((failure, idx) => ({
      id: `BUG-COMPILE-${idx + 1}`,
      title: `${failure.file} 编译失败`,
      description: failure.code ? `${failure.code}: ${failure.message}` : failure.message,
      severity: "major" as const,
      status: "open" as const,
      relatedFiles: [failure.file],
      rawErrorSnippet: failure.raw,
      detectedRound: round,
    }));
    qaModelFallbackReason = "检测到明确编译错误，已跳过 QA 模型深度分析。";
    emit("thinking", "System", qaModelFallbackReason, { node: "qa", compileFailureCount: compileFailures.length });
  }
  try {
    if (!issues.length) {
      const response = await agents.qa.chat([{ role: "user", content: prompt }], (ev) => emit(ev.type, ev.sender, "正在深度审计质量问题", ev), {
        mode: "coding",
        workspaceDir: WORKSPACE,
        brief: buildSystemContext(state),
        timeoutMs: QA_MODEL_TIMEOUT_MS,
      });
      const parsed = parseJsonFromResponse(extractText(response.content), { issues: [] });
      issues = parsed.issues || [];
    }
  } catch (error: any) {
    qaModelFallbackReason = String(error?.message || error || "qa 模型不可用");
    emit("thinking", "System", `QA 模型不可用，启用静态归因兜底：${qaModelFallbackReason}`, {
      node: "qa",
      timeoutMs: QA_MODEL_TIMEOUT_MS,
    });
  }

  // 安全网：如果 LLM 解析失败返回空数组，但验证仍未通过，必须生成兜底工单，禁止 QA 歧义放行
  if (issues.length === 0 && failureEvidence.hasBlockingFailure) {
    const existingOpen = (state.issueTracker || []).filter(i => i.status === 'open');
    if (existingOpen.length > 0) {
      issues = existingOpen;
    } else if (compileFailures.length > 0) {
      issues = compileFailures.map((failure, idx) => ({
        id: `BUG-COMPILE-${idx + 1}`,
        title: `${failure.file} 编译失败`,
        description: failure.code
          ? `${failure.code}: ${failure.message}`
          : failure.message,
        severity: "major" as const,
        status: "open" as const,
        relatedFiles: [failure.file],
        rawErrorSnippet: failure.raw,
        detectedRound: round,
      }));
    } else if (failingTestFiles.length > 0) {
      issues = failingTestFiles.map((f, idx) => ({
        id: `BUG-AUTO-${idx + 1}`,
        title: `${f} 测试失败`,
        description: `测试文件 ${f} 在本轮测试中失败，请检查并修复。`,
        severity: 'major' as const,
        status: 'open' as const,
        relatedFiles: [f],
        rawErrorSnippet: '',
        detectedRound: round,
      }));
    } else if (failureEvidence.verifierFailed) {
      issues = buildVerifierFallbackIssues(rawUnitOutput, round);
    } else if (deploymentFail) {
      issues = [{
        id: "BUG-DEPLOY-001",
        title: "部署连通性验证失败",
        description: deployErrorSection || qaModelFallbackReason || "部署健康检查失败，请检查启动日志、监听端口和容器映射。",
        severity: "critical",
        status: "open",
        relatedFiles: [],
        rawErrorSnippet: rawUnitOutput.slice(0, 400),
        detectedRound: round,
      }];
    } else {
      issues = [{
        id: "BUG-QA-FALLBACK-001",
        title: "测试验证未通过",
        description: qaModelFallbackReason
          ? `测试输出中存在明确失败证据，且 QA 模型不可用（${qaModelFallbackReason}），已启用静态兜底。`
          : "测试输出中存在明确失败证据，但未能自动归因到具体工单，请优先检查最新失败日志。",
        severity: "major",
        status: "open",
        relatedFiles: [],
        rawErrorSnippet: rawUnitOutput.slice(0, 400),
        detectedRound: round,
      }];
    }
  }

  const augmentedOwnership = augmentIssueOwnership(state, issues, failingTestFiles, rawUnitOutput, compileFailures);
  issues = augmentedOwnership.issues;
  const reopenFiles = augmentedOwnership.reopenFiles;

  // 3. 决策路由逻辑
  const activeOpenIssues = issues.filter(i => i.status === 'open');
  const isDone = activeOpenIssues.length === 0 && !failureEvidence.hasBlockingFailure && !hasPendingTasks;

  // 更新 consensusProgress.openIssues
  const stillOpenIssues = issues.filter(i => i.status === 'open');
  const openIssueSummaries = stillOpenIssues.map(i => `${i.id} ${i.title}`);
  const consensusProgress: ConsensusProgress = {
    completedFiles: state.consensusProgress?.completedFiles || [],
    pendingFiles: state.consensusProgress?.pendingFiles || [],
    currentRound: round,
    openIssues: openIssueSummaries,
  };

  const critical = issues.filter(i => i.status === 'open' && i.severity === 'critical').length;
  const major = issues.filter(i => i.status === 'open' && i.severity === 'major').length;
  const failureType = isDone
    ? undefined
    : inferQaFailureType(issues, {
        verifierFailed: failureEvidence.verifierFailed,
        deploymentFail,
        environmentProblem: environmentProblemDetected,
      });
  const noteId = `note-qa-r${round}`;
  const decisionLabel = isDone ? "放行" : "阻塞";
  const summary = `QA 第${round}轮：${decisionLabel}，${critical}个严重，${major}个主要问题`;
  const fullContent = `# QA 第${round}轮审计纪要

## 判定结论
- 结论：${decisionLabel}
- 是否存在失败证据：${failureEvidence.hasBlockingFailure ? "是" : "否"}
- Verifier 预检失败：${failureEvidence.verifierFailed ? "是" : "否"}
- 单元/编译失败：${unitTestFail ? "是" : "否"}
- 部署失败：${deploymentFail ? "是" : "否"}
- 当前未关闭工单数：${activeOpenIssues.length}

## 缺陷工单
\`\`\`json
${JSON.stringify(issues, null, 2)}
\`\`\`
  `;
  const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "qa", round, summary, fullContent);
  const validationReport = isDone
    ? buildValidationReport([], { status: "pass", blocking: false })
    : buildValidationReport(
        issues
          .filter((issue) => issue.status === "open")
          .map((issue) => ({
            summary: issue.title,
            file: issue.relatedFiles?.[0],
            evidence: [issue.description || issue.rawErrorSnippet || issue.title].filter(Boolean),
          })),
        { failureType, blocking: true }
      );

  // P1-B：QA 决策重试时统一增加 retryCount（语义：已完成 QA 判断并决定重试的次数）
  const result = {
    issueTracker: issues,
    isDone,
    retryCount: isDone ? (state.retryCount || 0) : (state.retryCount || 0) + 1,
    recoveredEnvironment: false,
    failureFingerprint: isDone ? "" : failureFingerprint,
    sameFailureCount: isDone ? 0 : sameFailureCount,
    qaFailures: isDone ? null : {
      // 合并 LLM 识别的文件 + 静态从测试输出提取的失败测试文件（双保险）
      failedFiles: Array.from(new Set([
        ...issues.filter(i => i.status === 'open').flatMap(i => i.relatedFiles),
        ...failingTestFiles,
        ...compileFailureFiles,
        ...reopenFiles,
      ])),
      testErrors: issues.filter(i => i.status === 'open').map(i => `${i.title}: ${i.description}`),
      failedTestNames: []
    },
    validationReport,
    repairPlan: isDone ? null : buildRepairPlan(validationReport),
    consensusProgress,
    meetingNotes: [meetingNote],
    lastFailedNode: isDone ? "" : (deploymentFail ? "deploy" : failureEvidence.verifierFailed ? "verifier" : "qa"),
    lastFailureSummary: isDone
      ? ""
      : (
          qaModelFallbackReason
            ? `${decisionLabel}：${issues[0]?.title || "测试验证未通过"}（QA 模型兜底：${qaModelFallbackReason}）`
            : (issues[0]?.title ? `${decisionLabel}：${issues[0].title}` : `${decisionLabel}：测试验证未通过`)
        ),
  };

  await saveBoulder({ ...state, ...result }, "qa");
  return result;
}
