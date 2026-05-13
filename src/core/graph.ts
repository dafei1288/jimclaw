import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentResourceExhaustedError, AgentServiceUnavailableError, AgentTimeoutError, BaseAgent } from "./agent";
import * as fs from "fs/promises";
import * as path from "path";
import { ModelManager } from "../utils/models";
import { JimClawState } from "./graph_types";
import { getBeijingTime } from "../utils/common";
import { getTemplateEngine } from "./template_engine";
import { buildCheckpointMeta, buildRepairPlan, buildTraceIndex, buildValidationReport, extractFailureEvidence, recordNodeFailure, recoverWorkspaceFromWriteIntents, shouldPersistCheckpoint } from "./logic_utils";
import { AuditLogger } from "../utils/audit";

// 导入重构后的节点函数
import { pmNode } from "./nodes/pm_node";
import { architectNode } from "./nodes/architect_node";
import { contractSyncNode } from "./nodes/contract_sync_node";
import { approvalNode } from "./nodes/approval_node";
import { orchestratorNode } from "./nodes/orchestrator_node";
import { sprintPlannerNode } from "./nodes/sprint_planner_node";
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

/**
 * 判断错误是否可自动恢复（模型 API 不可用 / ts-node 瞬时编译错误）
 * ts-node 的 "Debug Failure. Output generation failed" 是 TypeScript 编译器内存/瞬时问题，
 * 重试大概率能成功，不应直接标记为 crash 终止整个流程。
 */
function isAgentRecoveryError(error: unknown): error is AgentServiceUnavailableError | AgentResourceExhaustedError | AgentTimeoutError {
  if (error instanceof AgentServiceUnavailableError || error instanceof AgentResourceExhaustedError || error instanceof AgentTimeoutError) return true;
  // ts-node 瞬时编译错误：TypeScript "Debug Failure" 系列可重试
  const msg = error instanceof Error ? error.message : String(error || "");
  if (/Debug Failure/i.test(msg)) return true;
  return false;
}

export function hasPendingExecutorApproval(state: JimClawState): boolean {
  const ticketId = String(state.pendingApprovalTicketId || "").trim();
  if (!ticketId) return false;
  const ticket = (state.executorState?.approvalTickets || []).find((item: any) => item?.id === ticketId);
  if (!ticket) return true;
  return ticket.status === "pending";
}

function shouldPauseForAgentPending(state: JimClawState): boolean {
  if (!state.agentRecoveryPending) return false;
  if (!state.pendingApprovalTicketId) return true;
  return hasPendingExecutorApproval(state);
}

function routeWithAgentPending<T extends string>(
  resolver: (state: JimClawState) => T,
  pendingNode: string = "agent_pending"
) {
  return (state: JimClawState): T | typeof pendingNode => {
    if (shouldPauseForAgentPending(state)) return pendingNode;
    return resolver(state);
  };
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

export function getVerifierNextNode(state: JimClawState): "coder" | "architect" | "env_guard" | "qa" {
  if (shouldPauseForAgentPending(state)) return "qa";
  if (!state.testResults?.startsWith("[Verifier 预检失败]")) {
    return "qa";
  }
  if (state.testResults.includes("文件缺失")) {
    return "coder";
  }

  // verifier 是静态预检，所有失败最终都应由 QA 分析处理
  // 之前 runtime_gap 路由到 infra_setup 导致无限循环（verifier→infra→terminal→verifier）
  return "qa";
}

export function getInfraNextNode(state: JimClawState): "terminal" | "qa" {
  const output = `${state.testResults || ""}\n${state.lastFailureSummary || ""}\n${state.blockedReason || ""}`;
  // FP-007: infra 阶段的任何失败都不应该路由到 terminal
  // 之前 bug: containerId 已设置但 build 失败 → 路由到 terminal → 测试跑在残缺环境上
  if (/基础设施异常|build 失败|not found|exit code\s*127/i.test(output)) {
    return "qa";
  }
  // TypeScript 编译错误（TS2307 等）是代码问题，需要 Coder 修复，路由到 QA
  if (/\bTS\d{4}\b|Cannot find module/i.test(output)) {
    return "qa";
  }
  if (!state.containerId && /(基础设施|docker|docker-compose|spawn EPERM|spawn ENOENT|EACCES|OCI runtime|容器未成功启动)/i.test(output)) {
    return "qa";
  }
  return "terminal";
}

function isHostEnvironmentBlocked(state: JimClawState): boolean {
  const output = `${state.testResults || ""}\n${state.lastFailureSummary || ""}\n${state.blockedReason || ""}`;
  return /(spawn EPERM|spawn ENOENT|docker(\.exe)? .*not found|docker-compose .*not found|Docker Desktop is not running|permission denied while trying to connect to the Docker daemon|无法连接 Docker|宿主环境阻塞)/i.test(output);
}

export function getQaNextNode(
  state: JimClawState,
  maxRetries: number
): "approval" | "deploy" | "architect" | "env_guard" | "infra_setup" | "post_mortem" | "architect_mediation" | "fix_plan" | "coder" {
  if (shouldPauseForAgentPending(state)) return "coder";
  const openIssues = (state.issueTracker || []).filter((issue: any) => issue.status === "open");
  const blockingProtocolFailures = (state.protocolFailures || []).filter((failure: any) => failure?.blocking);
  const failureEvidence = extractFailureEvidence(state.testResults || "", state.deploymentStatus, state.blockedReason);
  const failureType = state.validationReport?.failureType;

  if (state.resumeAfterValidation) return "coder";
  if (state.isDone && openIssues.length === 0 && blockingProtocolFailures.length === 0 && !failureEvidence.hasBlockingFailure) {
    if (shouldRequireApproval(state, "deploy")) return "approval";
    return "deploy";
  }
  if (failureType === "environment_gap" && isHostEnvironmentBlocked(state)) {
    return "post_mortem";
  }
  if (failureType === "environment_gap" && (((state.sameFailureCount || 0) >= 2) || ((state.retryCount || 0) >= maxRetries))) {
    return "post_mortem";
  }
  if (failureType === "planning_gap") return "architect";
  if (failureType === "environment_gap") return "env_guard";
  // runtime_gap（如 deploy 失败）需要重试，但必须遵守重试上限
  if (failureType === "runtime_gap") {
    if ((state.sameFailureCount || 0) >= 3 || (state.retryCount || 0) >= maxRetries) {
      return "post_mortem";
    }
    return "infra_setup";
  }
  if (state.recoveredEnvironment) return "infra_setup";
  if ((state.sameFailureCount || 0) >= 2) return "post_mortem";
  if ((state.retryCount || 0) >= maxRetries) return "post_mortem";
  if ((state.retryCount || 0) >= 2 && ((state.retryCount || 0) - 2) % 3 === 0) return "architect_mediation";
  return "fix_plan";
}

export function getDeployNextNode(state: JimClawState): "qa" | "post_mortem" {
  if (state.deploymentStatus?.status === "failed" && state.validationReport?.failureType === "runtime_gap") {
    return "qa";
  }
  return "post_mortem";
}

function shouldRequireApproval(
  state: JimClawState,
  stage: "requirements" | "solution" | "deploy"
) {
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
  const WORKSPACE = path.resolve(options?.workspacePath || path.join(process.cwd(), "workspace", `run_${Date.now()}`));
  process.env.JIMCLAW_WORKSPACE = WORKSPACE;

  const templateEngine = getTemplateEngine();
  await templateEngine.loadTemplates();

  // 初始化 Scaffold 提供者注册表
  try {
    const { initScaffolds } = require("../scaffolds") as typeof import("../scaffolds");
    initScaffolds();
  } catch (e: any) {
    console.warn("[JimClaw] Scaffold 注册表初始化失败:", e.message);
  }

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
        if (isAgentRecoveryError(error)) {
          const validationReport = buildValidationReport(
            [{
              summary: `${nodeName} 模型服务暂不可用`,
              evidence: [error.message || failure.summary],
            }],
            { failureType: "environment_gap", blocking: true }
          );
          const pendingState = {
            ...state,
            meetingNotes,
            lastFailedNode: failure.node,
            lastFailureSummary: failure.summary,
            validationReport,
            repairPlan: buildRepairPlan(validationReport),
            agentRecoveryPending: true,
            agentRecoveryNode: nodeName,
            agentRecoveryReason: error.message || failure.summary,
            resumeFromNode: nodeName,
          } as JimClawState;
          await saveBoulder(pendingState, "agent_pending");
          return pendingState;
        }
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
    .addNode("approval_pending", async (s: JimClawState) => s)
    .addNode("agent_pending", async (s: JimClawState) => {
      const retryCount = (s.agentRecoveryRetryCount || 0) + 1;
      const reason = s.agentRecoveryReason || "";
      const isDebugFailure = /Debug Failure/i.test(reason);
      const isRetryable = /Connection error|超时|502|Debug Failure/i.test(reason);
      const maxRetries = isDebugFailure ? 5 : 3; // ts-node 编译器瞬时错误需要更多重试

      if (isRetryable && retryCount <= maxRetries) {
        // 可重试的临时故障：等待后重试（Debug Failure 需要更长延迟让 ts-node GC）
        const delay = isDebugFailure ? 5000 : 2000;
        console.log(`[AgentPending] 第 ${retryCount}/${maxRetries} 次重试: ${s.agentRecoveryNode} (${reason.slice(0, 80)})`);
        emit("thinking", "System", `模型服务临时不可用（${reason.slice(0, 60)}），第 ${retryCount}/${maxRetries} 次重试...`, {});
        await new Promise(resolve => setTimeout(resolve, delay));
        return {
          agentRecoveryPending: false,
          agentRecoveryRetryCount: retryCount,
        } as Partial<JimClawState>;
      } else {
        // 不可重试或已达上限：放弃
        console.log(`[AgentPending] 无法恢复: ${reason.slice(0, 80)}`);
        emit("thinking", "System", `模型服务不可恢复（${reason.slice(0, 60)}），终止运行`, {});
        return {
          agentRecoveryPending: false,
          agentRecoveryRetryCount: retryCount,
        } as Partial<JimClawState>;
      }
    })
    .addNode("orchestrator", withNodeGuard("orchestrator", (s) => orchestratorNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder)))
    .addNode("sprint_planner", withNodeGuard("sprint_planner", (s) => sprintPlannerNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder)))
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
    sprint_planner: "sprint_planner",
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
    approval_pending: "approval_pending",
    agent_pending: "agent_pending",
  });
  workflow.addConditionalEdges("pm", routeWithAgentPending((s) => {
    if (shouldRequireApproval(s, "requirements")) return "approval";
    return "architect";
  }), { approval: "approval", architect: "architect", agent_pending: "agent_pending" });
  workflow.addConditionalEdges("architect", routeWithAgentPending((s) => {
    if (shouldRequireApproval(s, "solution")) return "approval";
    return "contract_sync";
  }), { approval: "approval", contract_sync: "contract_sync", agent_pending: "agent_pending" });
  workflow.addConditionalEdges("contract_sync", routeWithAgentPending(() => "orchestrator"), {
    orchestrator: "orchestrator",
    agent_pending: "agent_pending",
  });
  workflow.addConditionalEdges("approval", routeWithAgentPending((s) => {
    if (s.requiresApproval) return "approval_pending";
    return s.approvalNextNode || "orchestrator";
  }), {
    approval_pending: "approval_pending",
    architect: "architect",
    contract_sync: "contract_sync",
    orchestrator: "orchestrator",
    deploy: "deploy",
    agent_pending: "agent_pending",
  });
  workflow.addEdge("approval_pending", END);
  // agent_pending: 可重试时回到失败节点，不可重试时结束
  workflow.addConditionalEdges("agent_pending", (state: JimClawState) => {
    const retryCount = state.agentRecoveryRetryCount || 0;
    const reason = state.agentRecoveryReason || "";
    const isDebugFailure = /Debug Failure/i.test(reason);
    const isRetryable = /Connection error|超时|502|Debug Failure/i.test(reason);
    const maxRetries = isDebugFailure ? 5 : 3;

    if (isRetryable && retryCount <= maxRetries) {
      const targetNode = state.agentRecoveryNode || "pm";
      console.log(`[AgentPending] 路由回 ${targetNode} 进行重试`);
      return targetNode as any;
    }
    return "__end__";
  }, {
    pm: "pm",
    architect: "architect",
    contract_sync: "contract_sync",
    orchestrator: "orchestrator",
    sprint_planner: "sprint_planner",
    coder: "coder",
    env_guard: "env_guard",
    infra_setup: "infra_setup",
    terminal: "terminal",
    verifier: "verifier",
    qa: "qa",
    fix_plan: "fix_plan",
    architect_mediation: "architect_mediation",
    deploy: "deploy",
    post_mortem: "post_mortem",
    persistence: "persistence",
    __end__: END,
  });
  workflow.addConditionalEdges("orchestrator", routeWithAgentPending(() => "sprint_planner"), {
    sprint_planner: "sprint_planner",
    agent_pending: "agent_pending",
  });
  workflow.addConditionalEdges("sprint_planner", routeWithAgentPending(() => "env_guard"), {
    env_guard: "env_guard",
    agent_pending: "agent_pending",
  });
  // coder 有 pending 任务时继续循环自身，全部完成后进入 infra。
  // 若环境尚未准备好，则先回到 env_guard。
  workflow.addConditionalEdges("coder", routeWithAgentPending((s) => {
    if (s.blockedReason) return "qa";
    if (s.validationCheckpointRequested) return "env_guard";
    const hasPending = (s.subTasks || []).some((t: any) => t.status === "pending");
    if (hasPending) return "coder";
    return "env_guard";
  }), { coder: "coder", env_guard: "env_guard", infra_setup: "infra_setup", qa: "qa", agent_pending: "agent_pending" });

  workflow.addConditionalEdges("env_guard", routeWithAgentPending((s) => {
    if (s.envReady === false) return "qa";
    if (s.validationCheckpointRequested) return "infra_setup";
    const hasPending = (s.subTasks || []).some((t: any) => t.status === "pending");
    return hasPending ? "coder" : "infra_setup";
  }), { qa: "qa", coder: "coder", infra_setup: "infra_setup", agent_pending: "agent_pending" });
  workflow.addConditionalEdges("infra_setup", routeWithAgentPending((s) => getInfraNextNode(s)), {
    terminal: "terminal",
    qa: "qa",
    agent_pending: "agent_pending",
  });
  workflow.addConditionalEdges("terminal", routeWithAgentPending(() => "verifier"), {
    verifier: "verifier",
    agent_pending: "agent_pending",
  });

  // verifier：文件缺失直回 coder；其他失败一律走 QA 分析（不再路由 infra/architect/env_guard）
  workflow.addConditionalEdges("verifier", routeWithAgentPending((s) => getVerifierNextNode(s)), {
    coder: "coder",
    qa: "qa",
    agent_pending: "agent_pending",
  });

  workflow.addConditionalEdges("qa", routeWithAgentPending((s) => getQaNextNode(s, maxRetries)), {
    approval: "approval",
    deploy: "deploy",
    architect: "architect",
    env_guard: "env_guard",
    infra_setup: "infra_setup",
    post_mortem: "post_mortem",
    architect_mediation: "architect_mediation",
    fix_plan: "fix_plan",
    coder: "coder",
    agent_pending: "agent_pending",
  });

  // 仲裁完直接去 coder（仲裁指令已够精确）
  workflow.addConditionalEdges("architect_mediation", routeWithAgentPending(() => "coder"), {
    coder: "coder",
    agent_pending: "agent_pending",
  });
  workflow.addConditionalEdges("fix_plan", routeWithAgentPending((s) => {
    const repairType = s.repairPlan?.repairType;
    if (repairType === "planning") return "architect";
    if (repairType === "environment") return "env_guard";
    if (repairType === "runtime") return "infra_setup";
    return "coder";
  }), {
    architect: "architect",
    env_guard: "env_guard",
    infra_setup: "infra_setup",
    coder: "coder",
    agent_pending: "agent_pending",
  });
  workflow.addConditionalEdges("deploy", routeWithAgentPending((s) => getDeployNextNode(s)), {
    qa: "qa",
    post_mortem: "post_mortem",
    agent_pending: "agent_pending",
  });
  workflow.addConditionalEdges("post_mortem", routeWithAgentPending(() => "persistence"), {
    persistence: "persistence",
    agent_pending: "agent_pending",
  });
  workflow.addEdge("persistence", END);

  return workflow.compile();
}
