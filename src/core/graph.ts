import { StateGraph, START, END } from "@langchain/langgraph";
import { BaseAgent } from "./agent";
import * as fs from "fs/promises";
import * as path from "path";
import { ModelManager } from "../utils/models";
import { JimClawState } from "./graph_types";
import { getBeijingTime } from "../utils/common";
import { getTemplateEngine } from "./template_engine";

// 导入重构后的节点函数
import { pmNode } from "./nodes/pm_node";
import { architectNode } from "./nodes/architect_node";
import { contractSyncNode } from "./nodes/contract_sync_node";
import { approvalNode } from "./nodes/approval_node";
import { orchestratorNode } from "./nodes/orchestrator_node";
import { coderNode } from "./nodes/coder_node";
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

export async function createJimClawGraph(agents: {
  pm: BaseAgent;
  architect: BaseAgent;
  coder: BaseAgent;
  qa: BaseAgent;
}, onEvent?: (event: { type: string; sender: string; content: string; metadata?: any }) => void) {
  const maxRetries = ModelManager.getGlobalConfig()?.maxRetries ?? 5;
  const WORKSPACE = path.join(process.cwd(), "workspace", `run_${Date.now()}`);
  process.env.JIMCLAW_WORKSPACE = WORKSPACE;

  const templateEngine = getTemplateEngine();
  await templateEngine.loadTemplates();

  const traceId = `trace_${Date.now()}`;
  let currentSpanId = "";
  const spanStartTimes: Record<string, number> = {};

  const emit = (type: string, sender: string, content: string, metadata?: any) => {
    if (onEvent) {
      const timestamp = getBeijingTime();
      const traceMetadata = { ...metadata, traceId, spanId: currentSpanId, timestamp, 
        durationMs: currentSpanId && spanStartTimes[currentSpanId] ? (Date.now() - spanStartTimes[currentSpanId]) : undefined };
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
      const snapshot = { node: nodeName, timestamp: getBeijingTime(), traceId, state: { ...state, messages: [] } };
      await fs.writeFile(path.join(WORKSPACE, "boulder.json"), JSON.stringify(snapshot, null, 2));
      console.log(`${logPrefix()} [Persistence] ✓ 状态已保存至 boulder.json (${nodeName})`);
    } catch (e) { console.warn(`${logPrefix()} [Persistence] ⚠ 状态保存失败: ${e}`); }
  };

  emit("workspace-ready", "System", WORKSPACE, { workspacePath: WORKSPACE });

  const workflow = new StateGraph(JimClawState)
    .addNode("pm", (s) => pmNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder))
    .addNode("architect", (s) => architectNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder))
    .addNode("contract_sync", (s) => contractSyncNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder))
    .addNode("approval", (s) => approvalNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder))
    .addNode("orchestrator", (s) => orchestratorNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder))
    .addNode("coder", (s) => coderNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder))
    .addNode("infra_setup", (s) => infraNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder))
    .addNode("terminal", (s) => terminalNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder))
    .addNode("verifier", (s) => verifierNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder))
    .addNode("qa", (s) => qaNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder))
    .addNode("deploy", (s) => deployNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder))
    .addNode("post_mortem", (s) => postMortemNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder))
    .addNode("persistence", (s) => persistenceNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder))
    .addNode("architect_mediation", (s) => architectMediationNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder))
    .addNode("fix_plan", (s) => fixPlanNode(s, agents, WORKSPACE, emit, startSpan, saveBoulder));

  workflow.addEdge(START, "pm");
  workflow.addEdge("pm", "architect");
  workflow.addEdge("architect", "contract_sync");
  workflow.addConditionalEdges("contract_sync", () => onEvent ? "approval" : "orchestrator", { approval: "approval", orchestrator: "orchestrator" });
  workflow.addEdge("approval", "orchestrator");
  workflow.addEdge("orchestrator", "coder");
  // coder 有 pending 任务时继续循环自身，全部完成后才进入 infra_setup
  // 避免 MAX_TASKS_PER_RUN 分批写文件期间反复触发 Docker 构建
  workflow.addConditionalEdges("coder", (s) => {
    const hasPending = (s.subTasks || []).some((t: any) => t.status === "pending");
    return hasPending ? "coder" : "infra_setup";
  }, { coder: "coder", infra_setup: "infra_setup" });
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
    if (s.isDone) return "deploy";
    if (s.retryCount >= maxRetries) return "post_mortem";

    // 每 3 轮失败强制触发一次架构仲裁（retryCount = 2, 5, 8, 11...）
    // 仲裁后直接去 coder（仲裁指令本身已足够精确，不需要再 fix_plan 协商）
    if (s.retryCount >= 2 && (s.retryCount - 2) % 3 === 0) {
      return "architect_mediation";
    }

    // 其他情况：先走 QA-Coder 协商，确认修复方向后再实现
    return "fix_plan";
  }, {
    deploy: "deploy",
    post_mortem: "post_mortem",
    architect_mediation: "architect_mediation",
    fix_plan: "fix_plan",
  });

  // 仲裁完直接去 coder（仲裁指令已够精确）
  workflow.addEdge("architect_mediation", "coder");
  // fix_plan 协商完去 coder 实现
  workflow.addEdge("fix_plan", "coder");
  workflow.addEdge("deploy", "post_mortem");
  workflow.addEdge("post_mortem", "persistence");
  workflow.addEdge("persistence", END);

  return workflow.compile();
}
