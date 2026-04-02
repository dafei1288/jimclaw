import { JimClawState, ConsensusCore, ProtocolPatch } from "../graph_types";
import { AgentResourceExhaustedError, AgentServiceUnavailableError, AgentTimeoutError, BaseAgent } from "../agent";
import { extractText, parseJsonFromResponse } from "../../utils/common";
import { applyProtocolPatches, buildSystemContext, buildProtocolPatchesForFixPlan, writeMeetingNote } from "../logic_utils";

const ARCHITECT_MEDIATION_TIMEOUT_MS = 45000;

function isRecoverableAgentError(error: unknown): error is AgentTimeoutError | AgentServiceUnavailableError | AgentResourceExhaustedError {
  return (
    error instanceof AgentTimeoutError ||
    error instanceof AgentServiceUnavailableError ||
    error instanceof AgentResourceExhaustedError
  );
}

/**
 * ArchitectMediation 节点：在多轮失败后，由架构师输出绑定性的修复指令与协议补丁。
 */
export async function architectMediationNode(
  state: JimClawState,
  agents: { architect: BaseAgent },
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  const synthesizeOpenIssues = () =>
    (state.protocolFailures || [])
      .filter((failure) => failure?.blocking)
      .map((failure, index) => ({
        id: `BUG-PROTOCOL-${index + 1}`,
        title: `${failure.file || failure.node} 协议未通过`,
        description: failure.summary,
        severity: "major" as const,
        status: "open" as const,
        relatedFiles: failure.file ? [failure.file] : [],
        detectedRound: state.retryCount || 0,
      }));

  startSpan("architect_mediation");

  const round = state.retryCount || 0;
  const mediationCount = Math.floor((round - 2) / 3) + 1;
  const issueOpenIssues = (state.issueTracker || []).filter((issue) => issue.status === "open");
  const protocolOpenIssues = synthesizeOpenIssues();
  const openIssues = protocolOpenIssues.length > 0 ? protocolOpenIssues : issueOpenIssues;
  const resolvedIssues = (state.issueTracker || []).filter((issue) => issue.status === "resolved");
  const stagnantIssues = openIssues.filter((issue) => (round - (issue.detectedRound || 0)) >= 3);
  const previousProtocolPatches = state.protocolPatches || [];

  const issueHistory = `
[未解决缺陷工单]
${openIssues.map((issue) => `- [${issue.id}] ${issue.title} (${issue.severity}): ${issue.description} (影响文件: ${issue.relatedFiles.join(", ")}) [已存在 ${round - (issue.detectedRound || 0)} 轮]`).join("\n") || "暂无"}

[停滞工单（连续3轮以上未解决）]
${stagnantIssues.map((issue) => `- [${issue.id}] ${issue.title} - 已持续 ${round - (issue.detectedRound || 0)} 轮未修复`).join("\n") || "暂无"}

[已解决缺陷工单]
${resolvedIssues.map((issue) => `- [${issue.id}] ${issue.title}`).join("\n") || "暂无"}
`;

  const previousDirectives = state.mediationDirectives?.length
    ? `\n[上次仲裁指令]\n${state.mediationDirectives.map((directive) => `- ${directive.file}: ${directive.action} -> ${directive.detail}`).join("\n")}`
    : "";
  const previousPatches = previousProtocolPatches.length
    ? `\n[历史协议补丁]\n${JSON.stringify(previousProtocolPatches, null, 2)}`
    : "";
  const latestTestOutput = state.testResults
    ? `\n[最新失败输出]\n${state.testResults.slice(-1500)}`
    : "";

  const currentSpec = state.spec ? JSON.stringify({
    framework: state.spec.framework,
    dependencies: state.spec.dependencies,
    devDependencies: state.spec.devDependencies,
    architecture: state.spec.architecture,
  }, null, 2) : "暂无";

  const prompt = `开发已陷入循环，第 ${round} 轮仍未通过测试，这是第 ${mediationCount} 次仲裁介入。请你作为首席架构师进行深度分析。

[当前架构设计]
${currentSpec}

[缺陷工单历史]
${issueHistory}
${previousDirectives}
${previousPatches}
${latestTestOutput}

[你的任务]
1. 判断当前失败属于测试问题、代码实现问题、设计问题还是契约冲突。
2. 对停滞工单优先怀疑之前的根因判断是否错误。
3. 输出绑定性的 mediationDirectives，必须精确到文件和动作。
4. 如需修改执行协议，同时输出 protocolPatches。

只输出 JSON：
{
  "directives": [{"file":"文件或*","action":"动作","detail":"详细指令"}],
  "protocolPatches": [{"target":"contracts","action":"replace","path":"files.src/routes/users.ts.ownedEndpoints","value":["GET /api/users"],"reason":"统一端点归属"}]
}`;

  let mediationDirectives: any[] = [];
  let protocolPatches: ProtocolPatch[] = [];
  try {
    const response = await agents.architect.chat(
      [{ role: "user", content: prompt }],
      (ev) => emit(ev.type, ev.sender, "正在分析冲突并进行仲裁", ev),
      {
        workspaceDir: WORKSPACE,
        brief: buildSystemContext(state),
        timeoutMs: ARCHITECT_MEDIATION_TIMEOUT_MS,
      }
    );

    const parsed = parseJsonFromResponse(extractText(response.content), { directives: [], protocolPatches: [] });
    mediationDirectives = parsed.directives || [];
    protocolPatches = parsed.protocolPatches || [];
  } catch (error: any) {
    if (!isRecoverableAgentError(error)) throw error;
    emit("thinking", "System", `架构仲裁模型暂不可用，改用规则化仲裁指令继续执行：${error.message || error}`, {});
    mediationDirectives = openIssues.flatMap((issue) =>
      (issue.relatedFiles || []).map((file: string) => ({
        file,
        action: "stabilize",
        detail: `围绕缺陷“${issue.title}”做最小修复，严格对齐当前 ApiContract / ExecutionProtocol，不要扩散到无关文件。`,
      }))
    );
  }

  if (protocolPatches.length === 0) {
    const fallbackFiles = Array.from(new Set(openIssues.flatMap((issue) => issue.relatedFiles || [])));
    protocolPatches = buildProtocolPatchesForFixPlan(fallbackFiles, state.executionProtocol, state.apiContract);
  }

  const updatedCore: ConsensusCore = {
    ...(state.consensusCore || {
      projectTitle: "",
      requirements: [],
      architectureSummary: "",
      techStack: "",
      framework: "",
      port: 0,
      coreDependencies: {},
      coreDevDependencies: {},
      criticalDecisions: [],
    }),
    criticalDecisions: [
      ...(state.consensusCore?.criticalDecisions || []),
      ...mediationDirectives.map((directive: any) => `${directive.file}: ${directive.action}`),
    ],
  };

  const noteId = `note-mediation-r${round}`;
  const summary = `架构仲裁第${round}轮：${mediationDirectives.length}条指令，${protocolPatches.length}条协议补丁`;
  const fullContent = `# 架构仲裁纪要 - 第${round}轮

## 仲裁指令
\`\`\`json
${JSON.stringify(mediationDirectives, null, 2)}
\`\`\`

## 协议补丁
\`\`\`json
${JSON.stringify(protocolPatches, null, 2)}
\`\`\`

## 缺陷历史
${issueHistory}
`;
  const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "mediation", round, summary, fullContent);
  const nextExecutionProtocol = applyProtocolPatches(state.executionProtocol, protocolPatches);

  const result = {
    mediationDirectives,
    protocolPatches,
    executionProtocol: nextExecutionProtocol,
    consensusCore: updatedCore,
    meetingNotes: [meetingNote],
  };
  await saveBoulder({ ...state, ...result }, "architect_mediation");
  return result;
}
