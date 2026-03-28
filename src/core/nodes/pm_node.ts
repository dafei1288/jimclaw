import * as fs from "fs/promises";
import * as path from "path";
import { JimClawState, TaskContractSchema, ConsensusCore } from "../graph_types";
import { BaseAgent } from "../agent";
import {
  logPrefix,
  buildSystemContext,
  buildCustomerApprovalState,
  buildRequirementProtocol,
  writeMeetingNote
} from "../logic_utils";
import { extractText, parseJsonFromResponse } from "../../utils/common";

/**
 * PM 节点：负责需求分析和契约起草
 */
export async function pmNode(
  state: JimClawState,
  agents: { pm: BaseAgent },
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("pm");
  console.log(`${logPrefix(agents.pm.getPersona().name)} 正在起草任务契约...`);
  emit("phase-change", "System", "requirement");
  emit("thinking", agents.pm.getPersona().name, "正在根据用户目标起草任务契约...");

  const goal = state.userGoal || "一个简单的计数器应用";
  const response = await agents.pm.chat([
    { role: "user", content: `请为以下目标定义任务契约：${goal}。
要求：
1. 深入分析用户目标，将功能拆解为具体的、可实现的 requirements。
2. 确保每个 requirement 都有对应的 acceptanceCriteria，且 criteria 必须是可验证的（例如：用户能够通过 XXX API 搜索到 YYY）。
3. 必须包含一个可测试的验证脚本。
4. 必须考虑边界情况和错误处理。
5. 必须涵盖用户权限管理、日志审计等非功能性需求（如果适用）。

请严格按照以下 JSON 格式输出：
{
  "title": "项目标题",
  "requirements": ["需求 1", "需求 2"],
  "acceptanceCriteria": ["验收标准 1", "验收标准 2"]
}
请确保内容使用中文描述，并且 requirements 和 acceptanceCriteria 必须是字符串数组。` }
  ], (ev) => emit(ev.type, ev.sender, ev.type === 'llm_call_start' ? "正在分析处理" : "分析完成", ev), { brief: buildSystemContext(state), workspaceDir: WORKSPACE });

  const contract = parseJsonFromResponse(extractText(response.content), { title: "待办任务", requirements: [], acceptanceCriteria: [] });
  const validation = TaskContractSchema.safeParse(contract);
  if (!validation.success) console.warn("[PM] TaskContract 校验失败:", validation.error.message);
  const requirementProtocol = buildRequirementProtocol(contract);
  const customerApprovalState = buildCustomerApprovalState({
    autoApprove: state.customerApprovalState?.autoApprove,
    summaries: {
      requirements: `${contract.title}：${(contract.requirements || []).slice(0, 3).join("；")}`,
      solution: state.customerApprovalState?.checkpoints?.find((item) => item.stage === "solution")?.summary || "",
      deploy: state.customerApprovalState?.checkpoints?.find((item) => item.stage === "deploy")?.summary || "",
    },
  });

  await fs.mkdir(WORKSPACE, { recursive: true });
  await fs.writeFile(path.join(WORKSPACE, "contract.json"), JSON.stringify(contract, null, 2));
  emit("artifact", agents.pm.getPersona().name, "任务契约已就绪。", { contract });

  const consensusCore: ConsensusCore = {
    projectTitle: contract.title,
    requirements: contract.requirements || [],
    architectureSummary: "",
    techStack: "",
    framework: "",
    port: 0,
    coreDependencies: {},
    coreDevDependencies: {},
    criticalDecisions: [],
  };

  const noteId = "note-pm-r0";
  const n = (contract.requirements || []).length;
  const summary = `PM 制定任务契约：${contract.title}，需求 ${n} 条`;
  const fullContent = `# 任务契约 - ${contract.title}\n\n## 需求列表\n${(contract.requirements || []).map((r: string, i: number) => `${i + 1}. ${r}`).join("\n")}\n\n## 验收标准\n${(contract.acceptanceCriteria || []).map((c: string, i: number) => `${i + 1}. ${c}`).join("\n")}\n`;
  const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "pm", 0, summary, fullContent);

  const result = {
    contract,
    requirementProtocol,
    customerApprovalState,
    consensusCore,
    meetingNotes: [meetingNote],
    teamChatLog: [{ sender: agents.pm.getPersona().name, content: `我已经定义好了任务契约。` }],
  };
  await saveBoulder({ ...state, ...result }, "pm");
  return result;
}
