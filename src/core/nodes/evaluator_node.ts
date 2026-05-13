import { EvaluationCheck, EvaluationResult, Issue, JimClawState, SprintContract } from "../graph_types";
import {
  buildRepairPlan,
  buildValidationReport,
  extractFailureEvidence,
  getActiveSprintContract,
  writeMeetingNote,
} from "../logic_utils";
import { host } from "../../infra";

type CheckResult = EvaluationResult["checks"][number];

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizePath(value: string): string {
  return String(value || "").replace(/\\/g, "/");
}

function resolveEvaluationUrl(state: JimClawState, rawUrl?: string): { url: string; error?: string } {
  const value = String(rawUrl || "").trim();
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

function inferEndpointStem(check: EvaluationCheck): string {
  const raw = String(check.url || check.description || "");
  const clean = raw.split("?")[0].replace(/\/+$/, "");
  const last = clean.split("/").filter(Boolean).pop() || "";
  const stripped = last.replace(/[:{}]/g, "").toLowerCase();
  if (!stripped) return "";
  return stripped.endsWith("s") ? stripped.slice(0, -1) : stripped;
}

function inferSuspectedFilesFromCheck(
  state: JimClawState,
  check: EvaluationCheck,
  contract: SprintContract
): string[] {
  const stem = inferEndpointStem(check);
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
  return unique(matched.length > 0 ? matched : candidates).slice(0, 6);
}

function hasConcreteEvidence(check: CheckResult): boolean {
  const evidence = check.evidence || {};
  return Object.values(evidence).some((value) => {
    if (value === undefined || value === null) return false;
    return String(value).trim().length > 0;
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
  const ok = Boolean(result.statusCode && expectedStatus.includes(result.statusCode));
  return {
    checkId: check.id,
    status: ok ? "pass" : "fail",
    evidence: {
      httpStatus: result.statusCode,
      httpBodySnippet: String(result.body || "").slice(0, 500),
      error: result.error,
    },
    reproSteps: [`GET ${resolved.url}`],
    suspectedFiles: ok ? [] : inferSuspectedFilesFromCheck(state, check, contract),
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

async function runEvaluationCheck(
  state: JimClawState,
  check: EvaluationCheck,
  contract: SprintContract
): Promise<CheckResult> {
  if (check.kind === "http") return runHttpCheck(state, check, contract);
  if (check.kind === "command" || check.kind === "unit") {
    return runCommandCheck(state, check, contract);
  }
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
    await saveBoulder({ ...state, ...result }, "evaluator");
    return result;
  }

  const checks = [];
  for (const check of contract.evaluatorPlan.checks || []) {
    checks.push(await runEvaluationCheck(state, check, contract));
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
