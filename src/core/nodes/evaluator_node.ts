import { EvaluationAssertion, EvaluationAssertionEvidence, EvaluationCheck, EvaluationResult, Issue, JimClawState, SprintContract } from "../graph_types";
import * as fs from "fs/promises";
import * as path from "path";
import {
  buildRepairPlan,
  buildValidationReport,
  execInContainer,
  extractFailureEvidence,
  getActiveSprintContract,
  writeMeetingNote,
} from "../logic_utils";
import { host } from "../../infra";
import { appendSessionEvent } from "../../utils/session_events";

type CheckResult = EvaluationResult["checks"][number];

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizePath(value: string): string {
  return String(value || "").replace(/\\/g, "/");
}

function materializeHttpPath(value: string): string {
  return String(value || "")
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name) => /id$/i.test(name) ? "1" : "test")
    .replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => /id$/i.test(name) ? "1" : "test");
}

function resolveEvaluationUrl(state: JimClawState, rawUrl?: string): { url: string; error?: string } {
  const value = materializeHttpPath(String(rawUrl || "").trim());
  if (!value) return { url: "", error: "HTTP 检查缺少 URL" };
  if (/^https?:\/\//i.test(value)) return { url: value };

  const pathPart = value.startsWith("/") ? value : `/${value}`;
  const deploymentUrl = state.deploymentStatus?.url;
  if (deploymentUrl && /^https?:\/\//i.test(deploymentUrl)) {
    try {
      const parsed = new URL(deploymentUrl);
      return { url: `${parsed.origin}${pathPart}` };
    } catch {
      return { url: value, error: `部署地址无效：${deploymentUrl}` };
    }
  }

  const rawPort = state.allocatedHostPort || state.manifest?.services?.[0]?.port;
  const port = typeof rawPort === "number" ? rawPort : parseInt(String(rawPort || ""), 10);
  if (Number.isFinite(port) && port > 0 && port < 65535) {
    return { url: `http://127.0.0.1:${port}${pathPart}` };
  }

  return { url: value, error: "缺少部署地址或已分配端口，无法执行 HTTP 验收" };
}

function hasHttpChecks(checks: EvaluationCheck[]): boolean {
  return checks.some((check) => check.kind === "http");
}

function resolveEvaluationPort(state: JimClawState): number {
  const rawPort = state.allocatedHostPort || state.manifest?.services?.[0]?.port;
  const port = typeof rawPort === "number" ? rawPort : parseInt(String(rawPort || ""), 10);
  return Number.isFinite(port) && port > 0 && port < 65535 ? port : 0;
}

function getEvaluatorRuntimePaths(workspace: string) {
  const runtimeDir = path.join(workspace, ".jimclaw");
  return {
    runtimeDir,
    pidPath: path.join(runtimeDir, "evaluator.pid"),
    stdoutLogPath: path.join(runtimeDir, "evaluator.stdout.log"),
    stderrLogPath: path.join(runtimeDir, "evaluator.stderr.log"),
  };
}

async function stopPreviousEvaluatorRuntime(workspace: string): Promise<void> {
  const paths = getEvaluatorRuntimePaths(workspace);
  const pidText = await host.readFile(paths.pidPath).catch(() => "");
  const pid = parseInt(pidText.trim(), 10);
  if (pid > 0 && host.isProcessRunning(pid)) {
    await host.killProcess(pid);
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function buildContainerEvaluatorLaunchCommand(runCmd: string, port: number): string {
  const effectiveRunCmd = `exec env PORT=${port} HOST=0.0.0.0 ${runCmd}`;
  const innerRunCmd = `echo $$ >/tmp/jimclaw/evaluator.pid; ${effectiveRunCmd}`;
  return [
    "mkdir -p /tmp/jimclaw",
    "if [ -f /tmp/jimclaw/evaluator.pid ]; then kill $(cat /tmp/jimclaw/evaluator.pid) 2>/dev/null || true; fi",
    ": > /tmp/jimclaw/evaluator.log",
    `sh -c ${shellSingleQuote(innerRunCmd)} >/tmp/jimclaw/evaluator.log 2>&1`,
  ].join("; ");
}

function isTransientRuntimeReadinessError(error: string): boolean {
  return /ECONNREFUSED|ECONNRESET|socket hang up|connect|timed?out|timeout/i.test(error);
}

async function waitForRuntime(origin: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await host.httpGet(origin, 1000);
    if (result.statusCode || (result.error && !isTransientRuntimeReadinessError(result.error))) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function ensureRuntimeForHttpChecks(
  state: JimClawState,
  WORKSPACE: string,
  checks: EvaluationCheck[]
): Promise<{ statePatch: Partial<JimClawState>; cleanup?: () => Promise<void> }> {
  if (!hasHttpChecks(checks)) return { statePatch: {} };
  if (state.deploymentStatus?.status === "running" && /^https?:\/\//i.test(state.deploymentStatus.url || "")) {
    return { statePatch: {} };
  }

  const port = resolveEvaluationPort(state);
  if (!port) return { statePatch: {} };

  const runCmd = state.spec?.runCommand || state.executionProtocol?.runtime?.startCommand || "npm start";
  const origin = `http://127.0.0.1:${port}`;

  if (state.executionBackend === "host") {
    await stopPreviousEvaluatorRuntime(WORKSPACE);
    const paths = getEvaluatorRuntimePaths(WORKSPACE);
    const pid = await host.startBackground({
      command: runCmd,
      cwd: WORKSPACE,
      stdoutLog: paths.stdoutLogPath,
      stderrLog: paths.stderrLogPath,
      env: { PORT: String(port), HOST: "0.0.0.0" },
    });
    await host.writeFile(paths.pidPath, String(pid));
    await waitForRuntime(origin);
    return {
      statePatch: {
        deploymentStatus: { status: "running", url: origin },
        hostRuntimePid: pid,
        hostRuntimeLogPath: paths.stdoutLogPath,
      },
      cleanup: async () => {
        await host.killProcess(pid);
      },
    };
  }

  if (state.containerId) {
    const containerPort = state.manifest?.services?.[0]?.port || port;
    await execInContainer(state.containerId, buildContainerEvaluatorLaunchCommand(runCmd, containerPort), { background: true });
    await waitForRuntime(origin);
    return {
      statePatch: {
        deploymentStatus: { status: "running", url: origin },
      },
      cleanup: async () => {
        await execInContainer(state.containerId || "", "if [ -f /tmp/jimclaw/evaluator.pid ]; then kill $(cat /tmp/jimclaw/evaluator.pid) 2>/dev/null || true; fi");
      },
    };
  }

  return { statePatch: {} };
}

function inferEndpointStem(check: EvaluationCheck): string {
  const raw = String(check.url || check.description || "");
  const clean = raw.split("?")[0].replace(/\/+$/, "");
  const last = clean.split("/").filter(Boolean).reverse().find((segment) =>
    !segment.startsWith(":") && !/^\{.+\}$/.test(segment)
  ) || "";
  const stripped = last.replace(/[:{}]/g, "").toLowerCase();
  if (!stripped) return "";
  return stripped.endsWith("s") ? stripped.slice(0, -1) : stripped;
}

function inferEntryFiles(state: JimClawState): string[] {
  const candidates = [
    state.spec?.entryPoint,
    ...((state.executionProtocol?.project?.workspaceLayout?.entryFiles || []) as string[]),
    ...(state.subTasks || [])
      .map((task) => normalizePath(task.fileTarget))
      .filter((file) => /(^|\/)(index|app)\.(ts|tsx|js|jsx)$/i.test(file)),
  ];
  return unique(candidates.filter(Boolean) as string[]);
}

function inferSuspectedFilesFromCheck(
  state: JimClawState,
  check: EvaluationCheck,
  contract: SprintContract,
  failure?: { httpStatus?: number | null }
): string[] {
  const stem = inferEndpointStem(check);
  const entryFiles = inferEntryFiles(state);
  const candidates = [
    ...((state.subTasks || []).map((task) => normalizePath(task.fileTarget))),
    ...(contract.builderPlan.filesLikelyTouched || []).map(normalizePath),
    ...(contract.agreedScope.allowedFiles || []).map(normalizePath),
  ];
  const matched = candidates.filter((file) => {
    const normalized = file.toLowerCase();
    return (
      Boolean(stem && normalized.includes(stem)) ||
      normalized.includes("/routes/") ||
      normalized.includes("/controllers/") ||
      normalized.includes("/services/")
    );
  });
  if (failure?.httpStatus === 404) {
    const routeMountFiles = candidates.filter((file) => {
      const normalized = file.toLowerCase();
      return (
        entryFiles.includes(file) ||
        normalized.includes("/routes/") ||
        normalized.includes("/controllers/") ||
        Boolean(stem && normalized.includes(stem))
      );
    });
    return unique([...entryFiles, ...routeMountFiles, ...matched]).slice(0, 8);
  }
  return unique(matched.length > 0 ? matched : candidates).slice(0, 6);
}

function hasConcreteEvidence(check: CheckResult): boolean {
  const evidence = check.evidence || {};
  return Object.values(evidence).some((value) => {
    if (value === undefined || value === null) return false;
    return String(value).trim().length > 0;
  });
}

function parseJsonBody(body: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (error: any) {
    return { ok: false, error: `响应体不是合法 JSON：${error?.message || error}` };
  }
}

function getFieldValue(value: any, field?: string): { exists: boolean; value: any } {
  if (!field) return { exists: false, value: undefined };
  const parts = field.split(".").filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (current === null || typeof current !== "object" || !(part in current)) {
      return { exists: false, value: undefined };
    }
    current = current[part];
  }
  return { exists: true, value: current };
}

function compareAssertionValue(actual: any, operator: EvaluationAssertion["operator"], expected: any): boolean {
  switch (operator) {
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const actualNumber = Number(actual);
      const expectedNumber = Number(expected);
      if (!Number.isFinite(actualNumber) || !Number.isFinite(expectedNumber)) return false;
      if (operator === "lt") return actualNumber < expectedNumber;
      if (operator === "lte") return actualNumber <= expectedNumber;
      if (operator === "gt") return actualNumber > expectedNumber;
      return actualNumber >= expectedNumber;
    }
    case "includes":
      if (Array.isArray(actual)) return actual.includes(expected);
      return String(actual ?? "").includes(String(expected ?? ""));
    default:
      return false;
  }
}

function evaluateJsonFieldExists(assertion: EvaluationAssertion, json: any): EvaluationAssertionEvidence {
  const scope = assertion.scope || (Array.isArray(json) ? "each" : "root");
  if (scope === "each") {
    if (!Array.isArray(json)) {
      return {
        id: assertion.id,
        type: assertion.type,
        status: "fail",
        message: `断言 ${assertion.id} 需要 JSON 数组才能逐项检查字段 ${assertion.field || ""}`,
      };
    }
    const missingIndex = json.findIndex((item) => !getFieldValue(item, assertion.field).exists);
    return {
      id: assertion.id,
      type: assertion.type,
      status: missingIndex >= 0 ? "fail" : "pass",
      message: missingIndex >= 0
        ? `第 ${missingIndex} 个元素缺少字段 ${assertion.field || ""}`
        : `所有元素均包含字段 ${assertion.field || ""}`,
    };
  }

  const found = getFieldValue(json, assertion.field).exists;
  return {
    id: assertion.id,
    type: assertion.type,
    status: found ? "pass" : "fail",
    message: found ? `响应对象包含字段 ${assertion.field || ""}` : `响应对象缺少字段 ${assertion.field || ""}`,
  };
}

function evaluateJsonEvery(assertion: EvaluationAssertion, json: any): EvaluationAssertionEvidence {
  if (!Array.isArray(json)) {
    return {
      id: assertion.id,
      type: assertion.type,
      status: "fail",
      message: `断言 ${assertion.id} 需要 JSON 数组才能逐项检查`,
    };
  }
  if (!assertion.field || !assertion.operator) {
    return {
      id: assertion.id,
      type: assertion.type,
      status: "fail",
      message: `断言 ${assertion.id} 缺少 field 或 operator`,
    };
  }

  const failingIndex = json.findIndex((item) => {
    const field = getFieldValue(item, assertion.field);
    return !field.exists || !compareAssertionValue(field.value, assertion.operator, assertion.value);
  });
  return {
    id: assertion.id,
    type: assertion.type,
    status: failingIndex >= 0 ? "fail" : "pass",
    message: failingIndex >= 0
      ? `第 ${failingIndex} 个元素不满足 ${assertion.field} ${assertion.operator} ${String(assertion.value)}`
      : `所有元素满足 ${assertion.field} ${assertion.operator} ${String(assertion.value)}`,
  };
}

function runSemanticAssertions(check: EvaluationCheck, body: string): EvaluationAssertionEvidence[] {
  const assertions = check.assertions || [];
  if (assertions.length === 0) return [];

  let parsedJson: ReturnType<typeof parseJsonBody> | null = null;
  const getJson = () => {
    if (!parsedJson) parsedJson = parseJsonBody(body);
    return parsedJson;
  };

  return assertions.map((assertion) => {
    if (assertion.type === "bodyContains" || assertion.type === "bodyNotContains") {
      const text = String(assertion.text ?? "");
      const contains = body.includes(text);
      const ok = assertion.type === "bodyContains" ? contains : !contains;
      return {
        id: assertion.id,
        type: assertion.type,
        status: ok ? "pass" : "fail",
        message: ok
          ? `响应文本${assertion.type === "bodyContains" ? "包含" : "不包含"} ${text}`
          : `响应文本${assertion.type === "bodyContains" ? "未包含" : "不应包含"} ${text}`,
      };
    }

    const json = getJson();
    if (!json.ok) {
      const message = "error" in json ? json.error : "响应体不是合法 JSON";
      return {
        id: assertion.id,
        type: assertion.type,
        status: "fail",
        message,
      };
    }

    if (assertion.type === "jsonArray") {
      const ok = Array.isArray(json.value);
      return {
        id: assertion.id,
        type: assertion.type,
        status: ok ? "pass" : "fail",
        message: ok ? "响应体是 JSON 数组" : "响应体不是 JSON 数组",
      };
    }
    if (assertion.type === "jsonFieldExists") {
      return evaluateJsonFieldExists(assertion, json.value);
    }
    return evaluateJsonEvery(assertion, json.value);
  });
}

async function runHttpCheck(
  state: JimClawState,
  check: EvaluationCheck,
  contract: SprintContract
): Promise<CheckResult> {
  const method = String(check.method || "GET").toUpperCase();
  const resolved = resolveEvaluationUrl(state, check.url);
  if (resolved.error) {
    return {
      checkId: check.id,
      status: "fail",
      evidence: { error: resolved.error },
      reproSteps: [method, resolved.url].filter(Boolean),
      suspectedFiles: inferSuspectedFilesFromCheck(state, check, contract),
    };
  }
  if (method !== "GET") {
    return {
      checkId: check.id,
      status: "fail",
      evidence: { error: `当前 evaluator 仅支持 GET HTTP 检查，收到 ${method}` },
      reproSteps: [`${method} ${resolved.url}`],
      suspectedFiles: inferSuspectedFilesFromCheck(state, check, contract),
    };
  }

  const result = await host.httpGet(resolved.url, 5000);
  const expectedStatus = check.expectedStatus?.length ? check.expectedStatus : [200];
  const statusOk = Boolean(result.statusCode && expectedStatus.includes(result.statusCode));
  const assertionEvidence = statusOk ? runSemanticAssertions(check, String(result.body || "")) : [];
  const assertionsOk = assertionEvidence.every((item) => item.status === "pass");
  const ok = statusOk && assertionsOk;
  const assertionError = assertionEvidence
    .filter((item) => item.status === "fail")
    .map((item) => item.message)
    .join("; ");
  return {
    checkId: check.id,
    status: ok ? "pass" : "fail",
    evidence: {
      httpStatus: result.statusCode,
      httpBodySnippet: String(result.body || "").slice(0, 500),
      assertions: assertionEvidence.length ? assertionEvidence : undefined,
      error: result.error || assertionError || undefined,
    },
    reproSteps: [`GET ${resolved.url}`],
    suspectedFiles: ok ? [] : inferSuspectedFilesFromCheck(state, check, contract, { httpStatus: result.statusCode }),
  };
}

function runCommandCheck(state: JimClawState, check: EvaluationCheck, contract: SprintContract): CheckResult {
  const output = String(state.testResults || "");
  const evidence = extractFailureEvidence(output, state.deploymentStatus, state.blockedReason);
  const hasOutput = output.trim().length > 0;
  const ok = hasOutput && !evidence.hasBlockingFailure;
  return {
    checkId: check.id,
    status: ok ? "pass" : "fail",
    evidence: {
      commandOutput: output.slice(0, 2000),
      error: hasOutput ? undefined : "缺少命令验收证据",
    },
    reproSteps: [check.command || state.spec?.testCommand || ""].filter(Boolean),
    suspectedFiles: ok ? [] : unique([
      ...((state.qaFailures?.failedFiles || []).map(normalizePath)),
      ...inferSuspectedFilesFromCheck(state, check, contract),
    ]),
  };
}

function resolveEvaluationFilePath(
  workspace: string,
  check: EvaluationCheck
): { relativePath: string; absolutePath: string; error?: string } {
  const rawPath = normalizePath(check.path || check.targetFile || "");
  if (!rawPath.trim()) {
    return { relativePath: "", absolutePath: "", error: "文件检查缺少 path/targetFile" };
  }
  const absolutePath = path.resolve(workspace, rawPath);
  const relativePath = path.relative(workspace, absolutePath).replace(/\\/g, "/");
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return { relativePath: rawPath, absolutePath, error: `文件检查路径越界：${rawPath}` };
  }
  return { relativePath, absolutePath };
}

function inferSuspectedFilesFromFileCheck(
  state: JimClawState,
  check: EvaluationCheck,
  contract: SprintContract
): string[] {
  const target = normalizePath(check.path || check.targetFile || "");
  const buildInputs = unique([
    "package.json",
    "tsconfig.json",
    state.spec?.entryPoint ? normalizePath(state.spec.entryPoint) : "",
    ...((state.executionProtocol?.project?.workspaceLayout?.entryFiles || []) as string[]).map(normalizePath),
  ]);
  if (/^(dist|build|out)\//i.test(target)) {
    return buildInputs.slice(0, 6);
  }
  return unique([
    target,
    ...buildInputs,
    ...(contract.builderPlan.filesLikelyTouched || []).map(normalizePath),
  ]).slice(0, 6);
}

async function runFileCheck(
  state: JimClawState,
  check: EvaluationCheck,
  contract: SprintContract,
  workspace: string
): Promise<CheckResult> {
  const resolved = resolveEvaluationFilePath(workspace, check);
  const expectedExists = check.exists !== false;
  if (resolved.error) {
    return {
      checkId: check.id,
      status: "fail",
      evidence: {
        path: resolved.relativePath,
        fileExists: false,
        error: resolved.error,
      },
      reproSteps: [`file ${resolved.relativePath}`],
      suspectedFiles: inferSuspectedFilesFromFileCheck(state, check, contract),
    };
  }

  const stat = await fs.stat(resolved.absolutePath).catch(() => null);
  const actualExists = Boolean(stat);
  const ok = expectedExists ? actualExists : !actualExists;
  return {
    checkId: check.id,
    status: ok ? "pass" : "fail",
    evidence: {
      path: resolved.relativePath,
      fileExists: actualExists,
      sizeBytes: stat?.isFile() ? stat.size : undefined,
      error: ok
        ? undefined
        : expectedExists
          ? `文件不存在或缺失：${resolved.relativePath}`
          : `文件不应存在但实际存在：${resolved.relativePath}`,
    },
    reproSteps: [`file ${resolved.relativePath}`],
    suspectedFiles: ok ? [] : inferSuspectedFilesFromFileCheck(state, check, contract),
  };
}

async function runEvaluationCheck(
  state: JimClawState,
  check: EvaluationCheck,
  contract: SprintContract,
  workspace: string
): Promise<CheckResult> {
  if (check.kind === "http") return runHttpCheck(state, check, contract);
  if (check.kind === "command" || check.kind === "unit") {
    return runCommandCheck(state, check, contract);
  }
  if (check.kind === "file") return runFileCheck(state, check, contract, workspace);
  return {
    checkId: check.id,
    status: "fail",
    evidence: { error: `暂不支持的 evaluator 检查类型：${check.kind}` },
    reproSteps: [check.description],
    suspectedFiles: inferSuspectedFilesFromCheck(state, check, contract),
  };
}

function buildEvaluationIssues(state: JimClawState, evaluation: EvaluationResult): Issue[] {
  const round = state.retryCount || 0;
  return evaluation.checks
    .filter((check) => check.status !== "pass")
    .map((check, index) => ({
      id: `EVAL-${evaluation.sprintId}-${check.checkId || index + 1}`,
      title: `Sprint 验收失败：${check.checkId}`,
      description: evaluation.summary,
      severity: "major" as const,
      status: "open" as const,
      relatedFiles: check.suspectedFiles,
      rawErrorSnippet: JSON.stringify(check.evidence || {}).slice(0, 500),
      detectedRound: round,
    }));
}

export async function evaluatorNode(
  state: JimClawState,
  agents: any,
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("evaluator");
  emit("phase-change", "System", "evaluation");
  const round = state.retryCount || 0;
  const contract = getActiveSprintContract(state);

  if (!contract) {
    const message = "缺少已确认的 SprintContract，无法执行 evaluator 验收";
    const validationReport = buildValidationReport(
      [{ summary: message, evidence: [message] }],
      { failureType: "planning_gap", status: "fail", blocking: true }
    );
    const note = await writeMeetingNote(
      WORKSPACE,
      `note-evaluator-r${round}`,
      "evaluator",
      round,
      `Evaluator 第${round}轮：缺少 SprintContract`,
      `# Evaluator 第${round}轮\n\n${message}\n`
    );
    const result = {
      validationReport,
      repairPlan: buildRepairPlan(validationReport),
      testResults: `[Evaluator 验收失败]\n${message}`,
      meetingNotes: [note],
      lastFailedNode: "evaluator",
      lastFailureSummary: message,
    };
    await appendSessionEvent(WORKSPACE, {
      type: "evaluation_failed",
      node: "evaluator",
      summary: message,
      payload: { reason: "missing_sprint_contract" },
    });
    await saveBoulder({ ...state, ...result }, "evaluator");
    return result;
  }

  const plannedChecks = contract.evaluatorPlan.checks || [];
  const checks = [];
  const runtime = await ensureRuntimeForHttpChecks(state, WORKSPACE, plannedChecks);
  try {
    const evaluationState = { ...state, ...runtime.statePatch };
    for (const check of plannedChecks) {
      checks.push(await runEvaluationCheck(evaluationState, check, contract, WORKSPACE));
    }
  } finally {
    await runtime.cleanup?.();
  }

  const status = checks.length > 0 && checks.every((check) => check.status === "pass" && hasConcreteEvidence(check))
    ? "pass"
    : "fail";
  const failedChecks = checks.filter((check) => check.status !== "pass" || !hasConcreteEvidence(check));
  const evaluation: EvaluationResult = {
    version: "v1",
    sprintId: contract.sprintId,
    status,
    checks,
    summary: status === "pass"
      ? `${contract.sprintId} 验收通过`
      : `${contract.sprintId} 验收失败：${failedChecks.map((check) => check.checkId).join(", ") || "缺少证据"}`,
  };

  const evaluationResults = [
    ...(state.evaluationResults || []).filter((item) => item.sprintId !== evaluation.sprintId),
    evaluation,
  ];
  const failedFiles = unique(failedChecks.flatMap((check) => check.suspectedFiles || []));
  const validationReport = status === "pass"
    ? buildValidationReport([], { status: "pass", blocking: false })
    : buildValidationReport(
        failedChecks.map((check) => ({
          summary: `Evaluator 验收失败：${check.checkId}`,
          file: check.suspectedFiles?.[0],
          evidence: [JSON.stringify(check.evidence || {})],
        })),
        { failureType: "runtime_gap", status: "fail", blocking: true }
      );
  const issues = buildEvaluationIssues(state, evaluation);
  const issueIds = new Set(issues.map((issue) => issue.id));
  const issueTracker = [
    ...(state.issueTracker || []).filter((issue) => !issueIds.has(issue.id)),
    ...issues,
  ];

  const note = await writeMeetingNote(
    WORKSPACE,
    `note-evaluator-r${round}`,
    "evaluator",
    round,
    `Evaluator 第${round}轮：${contract.sprintId} ${status === "pass" ? "通过" : "失败"}`,
    `# Evaluator 第${round}轮

## 结果
\`\`\`json
${JSON.stringify(evaluation, null, 2)}
\`\`\`
`
  );

  emit("thinking", "System", `[Evaluator] ${evaluation.summary}`, {});
  await appendSessionEvent(WORKSPACE, {
    type: "evaluation_completed",
    node: "evaluator",
    summary: evaluation.summary,
    payload: { evaluation },
  });

  const result = {
    evaluationResults,
    validationReport,
    repairPlan: buildRepairPlan(validationReport),
    issueTracker,
    qaFailures: status === "fail"
      ? {
          failedFiles,
          testErrors: failedChecks.map((check) => JSON.stringify(check.evidence || {})),
          failedTestNames: failedChecks.map((check) => check.checkId),
        }
      : null,
    consensusProgress: {
      ...(state.consensusProgress || { completedFiles: [], pendingFiles: [], currentRound: round, openIssues: [] }),
      currentRound: round,
      openIssues: status === "fail" ? validationReport.findings.map((finding) => finding.summary) : [],
    },
    testResults: status === "fail" ? `[Evaluator 验收失败]\n${evaluation.summary}` : state.testResults,
    meetingNotes: [note],
    lastFailedNode: status === "fail" ? "evaluator" : "",
    lastFailureSummary: status === "fail" ? evaluation.summary : "",
  };
  await saveBoulder({ ...state, ...result }, "evaluator");
  return result;
}
