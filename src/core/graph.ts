import { StateGraph, START, END } from "@langchain/langgraph";
import { BaseAgent } from "./agent";
import * as fs from "fs/promises";
import * as path from "path";
import { ModelManager } from "../utils/models";
import { JimClawState } from "./graph_types";
import { getBeijingTime } from "../utils/common";
import { getTemplateEngine } from "./template_engine";
import { buildCheckpointMeta, buildTraceIndex, extractFailureEvidence, recordNodeFailure, recoverWorkspaceFromWriteIntents, shouldPersistCheckpoint } from "./logic_utils";
import { AuditLogger } from "../utils/audit";

// 导入重构后的节点函数
import { pmNode } from "./nodes/pm_node";
import { architectNode } from "./nodes/architect_node";
import { contractSyncNode } from "./nodes/contract_sync_node";
import { approvalNode } from "./nodes/approval_node";
import { orchestratorNode } from "./nodes/orchestrator_node";
import { coderNode } from "./nodes/coder_node";
import { envGuardNode } from "./nodes/env_guard_node";
import { infraNode } from "./nodes/infra_node";
import { terminalNode } from "./nodes/terminal_node";
import { verifierNode } from "./nodes/verifier_node";
import { qaNode } from "./nodes/qa_node";
import { deployNode } from "./nodes/deploy_node";
import { postMortemNode } from "./nodes/post_mortem_node";
import { persistenceNode } from "./nodes/persistence_node";
import { architectMediationNode } from "./nodes/architect_mediation_node";
import { fixPlanNode } from "./nodes/fix_plan_node";

function logPrefix(agentName: string = "System"): string {
  return `[${getBeijingTime()}] [${agentName}]`;
}

type ApprovalDecision = {
  approved: boolean;
  reason?: string;
};

type ApprovalRequest = {
  stage: "requirements" | "solution" | "deploy";
  summary: string;
  nextNode: string;
};

function shouldRequireApproval(
  state: JimClawState,
  stage: "requirements" | "solution" | "deploy",
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>
) {
  if (!requestApproval) return false;
  const checkpoint = state.customerApprovalState?.checkpoints?.find((item) => item.stage === stage);
  return Boolean(checkpoint?.required) && !checkpoint?.approved;
}

export async function createJimClawGraph(agents: {
  pm: BaseAgent;
  architect: BaseAgent;
  coder: BaseAgent;
  qa: BaseAgent;
}, onEvent?: (event: { type: string; sender: string; content: string; metadata?: any }) => void, options?: {
  workspacePath?: string;
  traceId?: string;
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}) {
  const maxRetries = ModelManager.getGlobalConfig()?.maxRetries ?? 5;
  const WORKSPACE = options?.workspacePath || path.join(process.cwd(), "workspace", `run_${Date.now()}`);
  process.env.JIMCLAW_WORKSPACE = WORKSPACE;

  const templateEngine = getTemplateEngine();
  await templateEngine.loadTemplates();

  const traceId = options?.traceId || `trace_${Date.now()}`;
  let currentSpanId = "";
  const spanStartTimes: Record<string, number> = {};

  const emit = (type: string, sender: string, content: string, metadata?: any) => {
    const timestamp = getBeijingTime();
    const traceMetadata = {
      ...metadata,
      traceId,
      spanId: currentSpanId,
      timestamp,
      durationMs: currentSpanId && spanStartTimes[currentSpanId] ? (Date.now() - spanStartTimes[currentSpanId]) : undefined
    };
    void AuditLogger.recordStructuredEvent(WORKSPACE, {
      type,
      sender,
      content,
      timestamp,
      metadata: traceMetadata,
    });
    if (onEvent) {
      onEvent({ type, sender, content: `[${timestamp}] ${content}`, metadata: traceMetadata });
    }
  };

  const startSpan = (name: string) => {
    currentSpanId = `span_${name}_${Date.now()}`;
    spanStartTimes[currentSpanId] = Date.now();
    console.log(`${logPrefix()} [Trace] >>> 开始 Span: ${currentSpanId}`);
  };

  const saveBoulder = async (state: JimClawState, nodeName: string) => {
    try {
      const timestamp = getBeijingTime();
      const snapshotState = { ...state, messages: [] };
      const snapshot = { node: nodeName, timestamp, traceId, state: snapshotState };
      await fs.writeFile(path.join(WORKSPACE, "boulder.json"), JSON.stringify(snapshot, null, 2));
      let checkpoints: any[] = [];
      try {
        const previousIndexRaw = await fs.readFile(path.join(WORKSPACE, "trace-index.json"), "utf-8");
        checkpoints = JSON.parse(previousIndexRaw).checkpoints || [];
      } catch {}

      if (shouldPersistCheckpoint(nodeName)) {
        const checkpoint = buildCheckpointMeta(nodeName, snapshotState.retryCount || 0, timestamp);
        await fs.mkdir(path.join(WORKSPACE, "checkpoints"), { recursive: true });
        await fs.writeFile(path.join(WORKSPACE, checkpoint.file), JSON.stringify(snapshot, null, 2));
        checkpoints = [...checkpoints.filter((item: any) => item.id !== checkpoint.id), checkpoint];
      }

      const tokenUsage = await AuditLogger.loadTokenUsageSummary(WORKSPACE);
      const traceIndex = buildTraceIndex(snapshotState, nodeName, traceId, timestamp, checkpoints, tokenUsage);
      await fs.writeFile(path.join(WORKSPACE, "trace-index.json"), JSON.stringify(traceIndex, null, 2));
      console.log(`${logPrefix()} [Persistence] ✓ 状态已保存至 boulder.json (${nodeName})`);
    } catch (e) { console.warn(`${logPrefix()} [Persistence] ⚠ 状态保存失败: ${e}`); }
  };

  const withNodeGuard = (
    nodeName: string,
    handler: (state: JimClawState) => Promise<Partial<JimClawState>>
  ) => async (state: JimClawState) => {
    try {
      return await handler(state);
    } catch (error: any) {
      try {
        const { failure, meetingNotes } = await recordNodeFailure(WORKSPACE, state, nodeName, error);
        await saveBoulder({
          ...state,
          meetingNotes,
          lastFailedNode: failure.node,
          lastFailureSummary: failure.summary,
        } as JimClawState, `${nodeName}_crash`);
        error.jimclawFailure = failure;
      } catch (captureError) {
        console.warn(`${logPrefix()} [FailureCapture] 节点 ${nodeName} 异常记录失败: ${captureError}`);
      }
      throw error;
    }
  };

  await fs.mkdir(WORKSPACE, { recursive: true });
  await recoverWorkspaceFromWriteIntents(WORKSPACE);

  const registerSignalRecovery = (signal: NodeJS.Signals) => {
    process.once(signal, () => {
      void (async () => {
        try {
          const recovered = await recoverWorkspaceFromWriteIntents(WORKSPACE);
          if (recovered.recovered > 0) {
            console.warn(`${logPrefix()} [Recovery] ${signal} 前已回放 ${recovered.recovered} 个中断写入`);
          }
        } catch (error) {
          console.warn(`${logPrefix()} [Recovery] ${signal} 回放中断写入失败: ${error}`);
        } finally {
          process.exit(1);
        }
      })();
    });
  };

  registerSignalRecovery("SIGINT");
  registerSignalRecovery("SIGTERM");

  emit("workspace-ready", "System", WORKSPACE, { workspacePath: WORKSPACE });

  const workflow = new StateGraph(JimClawState)
    .addNode("pm", withNodeGuard("pm", (s) => pmNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder)))
    .addNode("architect", withNodeGuard("architect", (s) => architectNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder)))
    .addNode("contract_sync", withNodeGuard("contract_sync", (s) => contractSyncNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder)))
    .addNode("approval", withNodeGuard("approval", (s) => approvalNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder, options?.requestApproval)))
    .addNode("orchestrator", withNodeGuard("orchestrator", (s) => orchestratorNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder)))
    .addNode("coder", withNodeGuard("coder", (s) => coderNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder)))
    .addNode("env_guard", withNodeGuard("env_guard", (s) => envGuardNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder)))
    .addNode("infra_setup", withNodeGuard("infra_setup", (s) => infraNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder)))
    .addNode("terminal", withNodeGuard("terminal", (s) => terminalNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder)))
    .addNode("verifier", withNodeGuard("verifier", (s) => verifierNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder)))
    .addNode("qa", withNodeGuard("qa", (s) => qaNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder)))
    .addNode("deploy", withNodeGuard("deploy", (s) => deployNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder)))
    .addNode("post_mortem", withNodeGuard("post_mortem", (s) => postMortemNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder)))
    .addNode("persistence", withNodeGuard("persistence", (s) => persistenceNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder)))
    .addNode("architect_mediation", withNodeGuard("architect_mediation", (s) => architectMediationNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder)))
    .addNode("fix_plan", withNodeGuard("fix_plan", (s) => fixPlanNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder)));

  workflow.addConditionalEdges(START, (s) => {
    const resumeNode = s.resumeFromNode || "pm";
    return resumeNode;
  }, {
    pm: "pm",
    architect: "architect",
    contract_sync: "contract_sync",
    approval: "approval",
    orchestrator: "orchestrator",
    coder: "coder",
    env_guard: "env_guard",
    infra_setup: "infra_setup",
    terminal: "terminal",
    verifier: "verifier",
    qa: "qa",
    qa_resume_router: "qa",
    deploy: "deploy",
    post_mortem: "post_mortem",
    persistence: "persistence",
    architect_mediation: "architect_mediation",
    fix_plan: "fix_plan",
  });
  workflow.addConditionalEdges("pm", (s) => {
    if (shouldRequireApproval(s, "requirements", options?.requestApproval)) return "approval";
    return "architect";
  }, { approval: "approval", architect: "architect" });
  workflow.addConditionalEdges("architect", (s) => {
    if (shouldRequireApproval(s, "solution", options?.requestApproval)) return "approval";
    return "contract_sync";
  }, { approval: "approval", contract_sync: "contract_sync" });
  workflow.addEdge("contract_sync", "orchestrator");
  workflow.addConditionalEdges("approval", (s) => s.approvalNextNode || "orchestrator", {
    architect: "architect",
    contract_sync: "contract_sync",
    orchestrator: "orchestrator",
    deploy: "deploy",
  });
  workflow.addEdge("orchestrator", "env_guard");
  // coder 有 pending 任务时继续循环自身，全部完成后进入 infra。
  // 若环境尚未准备好，则先回到 env_guard。
  workflow.addConditionalEdges("coder", (s) => {
    if (s.blockedReason) return "qa";
    const hasPending = (s.subTasks || []).some((t: any) => t.status === "pending");
    if (hasPending) return "coder";
    return s.envReady === false ? "env_guard" : "infra_setup";
  }, { coder: "coder", env_guard: "env_guard", infra_setup: "infra_setup", qa: "qa" });

  workflow.addConditionalEdges("env_guard", (s) => {
    if (s.envReady === false) return "qa";
    const hasPending = (s.subTasks || []).some((t: any) => t.status === "pending");
    return hasPending ? "coder" : "infra_setup";
  }, { qa: "qa", coder: "coder", infra_setup: "infra_setup" });
  workflow.addEdge("infra_setup", "terminal");
  workflow.addEdge("terminal", "verifier");

  // verifier：只有"文件缺失"才回 coder（coder 能创建文件）
  // 其他预检失败（依赖分类错误、监听声明缺失等）交给 qa 分析后定向修复
  // 避免 coder 无事可做时与 infra/verifier 形成无限循环
  workflow.addConditionalEdges("verifier", (s) => {
    if (s.testResults?.startsWith("[Verifier 预检失败]")) {
      if (s.testResults.includes("文件缺失")) return "coder";
      return "qa";
    }
    return "qa";
  }, { coder: "coder", qa: "qa" });

  workflow.addConditionalEdges("qa", (s) => {
    const openIssues = (s.issueTracker || []).filter((issue: any) => issue.status === "open");
    const blockingProtocolFailures = (s.protocolFailures || []).filter((failure: any) => failure?.blocking);
    const failureEvidence = extractFailureEvidence(s.testResults || "", s.deploymentStatus, s.blockedReason);
    const failureType = s.validationReport?.failureType;
    if (s.isDone && openIssues.length === 0 && blockingProtocolFailures.length === 0 && !failureEvidence.hasBlockingFailure) {
      if (shouldRequireApproval(s, "deploy", options?.requestApproval)) return "approval";
      return "deploy";
    }
    if (failureType === "planning_gap") return "architect";
    if (failureType === "environment_gap") return "env_guard";
    if (failureType === "runtime_gap") return "infra_setup";
    if (s.recoveredEnvironment) return "infra_setup";
    if ((s.sameFailureCount || 0) >= 2) return "post_mortem";
    if (s.retryCount >= maxRetries) return "post_mortem";

    // 每 3 轮失败强制触发一次架构仲裁（retryCount = 2, 5, 8, 11...）
    // 仲裁后直接去 coder（仲裁指令本身已足够精确，不需要再 fix_plan 协商）
    if (s.retryCount >= 2 && (s.retryCount - 2) % 3 === 0) {
      return "architect_mediation";
    }

    // 其他情况：先走 QA-Coder 协商，确认修复方向后再实现
    return "fix_plan";
  }, {
    approval: "approval",
    deploy: "deploy",
    architect: "architect",
    env_guard: "env_guard",
    infra_setup: "infra_setup",
    post_mortem: "post_mortem",
    architect_mediation: "architect_mediation",
    fix_plan: "fix_plan",
  });

  // 仲裁完直接去 coder（仲裁指令已够精确）
  workflow.addEdge("architect_mediation", "coder");
  workflow.addConditionalEdges("fix_plan", (s) => {
    const repairType = s.repairPlan?.repairType;
    if (repairType === "planning") return "architect";
    if (repairType === "environment") return "env_guard";
    if (repairType === "runtime") return "infra_setup";
    return "coder";
  }, {
    architect: "architect",
    env_guard: "env_guard",
    infra_setup: "infra_setup",
    coder: "coder",
  });
  workflow.addEdge("deploy", "post_mortem");
  workflow.addEdge("post_mortem", "persistence");
  workflow.addEdge("persistence", END);

  return workflow.compile();
}
