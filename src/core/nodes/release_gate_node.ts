import { Issue, JimClawState, ProtocolFailure } from "../graph_types";
import { buildRepairPlan, buildValidationReport, writeMeetingNote } from "../logic_utils";

function evidenceText(value: unknown): string {
  return JSON.stringify(value || {});
}

function hasUiEvidence(state: JimClawState): boolean {
  return (state.evaluationResults || [])
    .filter((result) => result.status === "pass")
    .some((result) => result.checks.some((check) => {
      const text = [
        evidenceText(check.evidence),
        ...(check.reproSteps || []),
      ].join("\n");
      return Boolean(
        check.evidence?.screenshotPath ||
        check.evidence?.tracePath ||
        /playwright|browser|浏览器|页面|点击|ui|screenshot|trace/i.test(text)
      );
    }));
}

function criterionHasEvidence(state: JimClawState, criterion: { id: string; description: string }): boolean {
  const passedSprintIds = new Set(
    (state.evaluationResults || [])
      .filter((result) => result.status === "pass")
      .map((result) => result.sprintId)
  );
  const owningSprintIds = (state.sprintPlans || [])
    .filter((plan) => (plan.acceptanceCriteriaIds || []).includes(criterion.id))
    .map((plan) => plan.id);

  if (owningSprintIds.length > 0) {
    return owningSprintIds.some((id) => passedSprintIds.has(id));
  }

  return (state.evaluationResults || [])
    .filter((result) => result.status === "pass")
    .some((result) => {
      const text = [
        result.summary,
        ...result.checks.flatMap((check) => [
          check.checkId,
          evidenceText(check.evidence),
          ...(check.reproSteps || []),
        ]),
      ].join("\n");
      return text.includes(criterion.description);
    });
}

function buildReleaseGateIssues(state: JimClawState, failures: ProtocolFailure[]): Issue[] {
  const round = state.retryCount || 0;
  return failures.map((failure, index) => ({
    id: `RELEASE-GATE-${index + 1}`,
    title: failure.summary,
    description: failure.evidence.join("\n") || failure.summary,
    severity: "major" as const,
    status: "open" as const,
    relatedFiles: failure.file ? [failure.file] : [],
    rawErrorSnippet: failure.evidence.join(" | ").slice(0, 500),
    detectedRound: round,
  }));
}

export async function releaseGateNode(
  state: JimClawState,
  agents: any,
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("release_gate");
  emit("phase-change", "System", "release_gate");
  const round = state.retryCount || 0;
  const productSpec = state.productSpec;
  const failures: ProtocolFailure[] = [];

  if (!productSpec) {
    failures.push({
      type: "test_discovery_gap",
      node: "release_gate",
      summary: "缺少 ProductSpec，无法确认验收覆盖",
      evidence: ["state.productSpec 为空"],
      blocking: true,
    });
  }

  const failedEvaluations = (state.evaluationResults || []).filter((result) => result.status !== "pass");
  for (const result of failedEvaluations) {
    failures.push({
      type: "runtime_mismatch",
      node: "release_gate",
      summary: `${result.sprintId} 仍有 evaluator 验收失败`,
      evidence: [result.summary, evidenceText(result.checks)],
      blocking: true,
    });
  }

  const passedSprintIds = new Set(
    (state.evaluationResults || [])
      .filter((result) => result.status === "pass")
      .map((result) => result.sprintId)
  );
  for (const plan of state.sprintPlans || []) {
    if (!passedSprintIds.has(plan.id)) {
      failures.push({
        type: "test_discovery_gap",
        node: "release_gate",
        summary: `${plan.id} 缺少通过的 evaluator 验收结果`,
        evidence: [`sprint=${plan.id}`, `goal=${plan.goal}`],
        blocking: true,
      });
    }
  }

  const uncoveredCriteria = (productSpec?.acceptanceCriteria || [])
    .filter((criterion) => !criterionHasEvidence(state, criterion));
  for (const criterion of uncoveredCriteria) {
    failures.push({
      type: "test_discovery_gap",
      node: "release_gate",
      summary: `${criterion.id} 缺少验收证据`,
      evidence: [criterion.description],
      blocking: true,
    });
  }

  const frontendCriteria = (productSpec?.acceptanceCriteria || [])
    .filter((criterion) => criterion.verificationKind === "ui");
  if (frontendCriteria.length > 0 && !hasUiEvidence(state)) {
    failures.push({
      type: "test_discovery_gap",
      node: "release_gate",
      summary: "前端验收缺少 UI 证据",
      evidence: frontendCriteria.map((criterion) => `${criterion.id}: ${criterion.description}`),
      blocking: true,
    });
  }

  const blocking = failures.length > 0;
  const failureType = failures.some((failure) => failure.type === "runtime_mismatch")
    ? "runtime_gap"
    : "planning_gap";
  const validationReport = blocking
    ? buildValidationReport(
        failures.map((failure) => ({
          summary: failure.summary,
          file: failure.file,
          evidence: failure.evidence,
        })),
        { failureType, status: "fail", blocking: true }
      )
    : buildValidationReport([], { status: "pass", blocking: false });
  const issues = blocking ? buildReleaseGateIssues(state, failures) : [];
  const issueIds = new Set(issues.map((issue) => issue.id));
  const issueTracker = [
    ...(state.issueTracker || []).filter((issue) => !issueIds.has(issue.id)),
    ...issues,
  ];
  const summary = blocking
    ? `ReleaseGate 第${round}轮：阻塞，${failures.length} 项证据缺口`
    : `ReleaseGate 第${round}轮：放行`;
  const note = await writeMeetingNote(
    WORKSPACE,
    `note-release-gate-r${round}`,
    "release_gate",
    round,
    summary,
    `# Release Gate 第${round}轮

## ValidationReport
\`\`\`json
${JSON.stringify(validationReport, null, 2)}
\`\`\`

## EvaluationResults
\`\`\`json
${JSON.stringify(state.evaluationResults || [], null, 2)}
\`\`\`
`
  );

  emit("thinking", "System", `[ReleaseGate] ${summary}`, {});

  const result = {
    isDone: !blocking,
    validationReport,
    repairPlan: blocking ? buildRepairPlan(validationReport) : null,
    protocolFailures: blocking ? failures : [],
    issueTracker,
    qaFailures: blocking
      ? {
          failedFiles: failures.map((failure) => failure.file).filter(Boolean) as string[],
          testErrors: failures.map((failure) => failure.summary),
          failedTestNames: [],
        }
      : null,
    consensusProgress: {
      ...(state.consensusProgress || { completedFiles: [], pendingFiles: [], currentRound: round, openIssues: [] }),
      currentRound: round,
      openIssues: blocking ? failures.map((failure) => failure.summary) : [],
    },
    meetingNotes: [note],
    testResults: blocking ? `[ReleaseGate 阻塞]\n${failures.map((failure) => failure.summary).join("\n")}` : state.testResults,
    lastFailedNode: blocking ? "release_gate" : "",
    lastFailureSummary: blocking ? failures.map((failure) => failure.summary).join("；") : "",
    blockedReason: blocking ? "ReleaseGate 证据不足，禁止发布" : "",
  };
  await saveBoulder({ ...state, ...result }, "release_gate");
  return result;
}
