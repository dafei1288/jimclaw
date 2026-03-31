import * as fs from "fs/promises";
import * as path from "path";
import { JimClawState, TaskContractSchema, ConsensusCore } from "../graph_types";
import { AgentResourceExhaustedError, AgentServiceUnavailableError, AgentTimeoutError, BaseAgent } from "../agent";
import {
  logPrefix,
  buildSystemContext,
  buildCustomerApprovalState,
  buildRequirementProtocol,
  writeMeetingNote
} from "../logic_utils";
import { extractText, parseJsonFromResponse } from "../../utils/common";

const PM_MODEL_TIMEOUT_MS = 15000;

function isRecoverableAgentError(error: unknown): error is AgentTimeoutError | AgentServiceUnavailableError | AgentResourceExhaustedError {
  return (
    error instanceof AgentTimeoutError ||
    error instanceof AgentServiceUnavailableError ||
    error instanceof AgentResourceExhaustedError
  );
}

function inferFallbackResource(goal: string): { title: string; label: string } {
  const normalized = String(goal || "").trim() || "通用管理系统";
  const title = /系统|平台|应用/.test(normalized) ? normalized : `${normalized}系统`;
  if (/图书|book/i.test(normalized)) return { title, label: "图书" };
  if (/商品|产品|电器|product|appliance/i.test(normalized)) return { title, label: "商品" };
  if (/用户|user/i.test(normalized)) return { title, label: "用户" };
  if (/订单|order/i.test(normalized)) return { title, label: "订单" };
  return { title, label: "数据" };
}

function buildDeterministicContract(goal: string) {
  const inferred = inferFallbackResource(goal);
  return condenseContractForExecution(goal, {
    title: inferred.title,
    requirements: [
      `提供${inferred.label}列表、详情、新增、修改、删除等基础管理能力，支持前端页面与后端 API 协同工作。`,
      `提供基础认证、角色权限控制与未授权访问拦截能力，确保核心写操作受保护。`,
      `提供统一错误处理、输入校验与关键写操作审计日志，避免出现脏数据和静默失败。`,
      `提供可执行验证脚本，覆盖${inferred.label}查询、写操作、认证校验与异常处理等关键流程。`,
      `提供 Docker 部署所需的基础运行说明与配置，使项目可以被启动、验证与恢复。`,
    ],
    acceptanceCriteria: [
      `用户可以通过页面或 API 查询${inferred.label}列表与详情。`,
      `已认证用户可以新增、修改、删除${inferred.label}，未授权请求返回 401 或 403。`,
      `非法输入会返回统一错误结构，不会造成服务崩溃或脏数据写入。`,
      `关键写操作会生成可查询的审计日志记录。`,
      `验证脚本执行后能输出通过/失败结果，并覆盖${inferred.label}读写与认证流程。`,
      `项目可以通过 Docker 或本地命令启动并完成基础健康检查。`,
    ],
  });
}

function isGenericUserGoal(goal: string): boolean {
  const normalized = String(goal || "").trim();
  if (!normalized) return false;
  if (normalized.length <= 20 && !/[，,。；;:\n]/.test(normalized)) return true;
  return false;
}

function scoreRequirementForMvp(item: string): number {
  const text = String(item || "");
  let score = 0;
  if (/验证脚本|测试脚本|verify/i.test(text)) score += 100;
  if (/统一错误|错误处理|输入校验|异常/i.test(text)) score += 95;
  if (/认证|权限|登录|角色/i.test(text)) score += 90;
  if (/新增|编辑|删除|详情|列表|分页|排序|检索|搜索|基础信息/i.test(text)) score += 85;
  if (/库存|副本|状态/i.test(text)) score += 80;
  if (/日志审计|审计日志|日志/i.test(text)) score += 75;
  if (/借阅|还书|续借/.test(text)) score += 30;
  if (/预约|罚金|报表|统计|导入|导出|通知|对账|配置/.test(text)) score -= 40;
  return score;
}

function selectMvpLines(lines: string[], limit: number): string[] {
  const ranked = lines
    .map((line, index) => ({ line, index, score: scoreRequirementForMvp(line) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const picked = ranked.slice(0, limit).sort((left, right) => left.index - right.index).map((item) => item.line);
  return Array.from(new Set(picked));
}

function condenseContractForExecution(goal: string, contract: { title?: string; requirements?: string[]; acceptanceCriteria?: string[] }) {
  const nextContract = {
    title: contract?.title || "待办任务",
    requirements: [...(contract?.requirements || [])],
    acceptanceCriteria: [...(contract?.acceptanceCriteria || [])],
  };
  if (!isGenericUserGoal(goal)) return nextContract;
  if ((nextContract.requirements || []).length <= 8) return nextContract;

  nextContract.requirements = selectMvpLines(nextContract.requirements, 6);
  nextContract.acceptanceCriteria = selectMvpLines(nextContract.acceptanceCriteria, 8);
  return nextContract;
}

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
  let contractSource = "model";
  let responseContent = "";
  try {
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
    ], (ev) => emit(ev.type, ev.sender, ev.type === 'llm_call_start' ? "正在分析处理" : "分析完成", ev), {
      brief: buildSystemContext(state),
      workspaceDir: WORKSPACE,
      timeoutMs: PM_MODEL_TIMEOUT_MS,
    });
    responseContent = extractText(response.content);
  } catch (error: any) {
    if (!isRecoverableAgentError(error)) throw error;
    contractSource = "deterministic-fallback";
    emit("thinking", "System", `PM 模型暂不可用，改用确定性任务契约骨架继续执行：${error.message || error}`, {});
    responseContent = JSON.stringify(buildDeterministicContract(goal));
  }

  const contract = condenseContractForExecution(
    goal,
    parseJsonFromResponse(responseContent, buildDeterministicContract(goal))
  );
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
  const summary = contractSource === "model"
    ? `PM 制定任务契约：${contract.title}，需求 ${n} 条`
    : `PM 降级契约：${contract.title}，需求 ${n} 条`;
  const fullContent = `# 任务契约 - ${contract.title}\n\n## 来源\n- ${contractSource === "model" ? "模型生成" : "确定性降级骨架"}\n\n## 需求列表\n${(contract.requirements || []).map((r: string, i: number) => `${i + 1}. ${r}`).join("\n")}\n\n## 验收标准\n${(contract.acceptanceCriteria || []).map((c: string, i: number) => `${i + 1}. ${c}`).join("\n")}\n`;
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
