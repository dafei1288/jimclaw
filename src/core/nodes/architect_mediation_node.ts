import { JimClawState, ConsensusCore } from "../graph_types";
import { BaseAgent } from "../agent";
import { extractText, parseJsonFromResponse } from "../../utils/common";
import { buildSystemContext, writeMeetingNote } from "../logic_utils";

/**
 * ArchitectMediation 节点：负责在冲突发生时进行仲裁
 */
export async function architectMediationNode(
  state: JimClawState,
  agents: { architect: BaseAgent },
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("architect_mediation");

  const round = state.retryCount || 0;
  const mediationCount = Math.floor((round - 2) / 3) + 1; // 第几次仲裁

  // 核心：让架构师看到缺陷追踪的历史记忆
  const openIssues = (state.issueTracker || []).filter(i => i.status === 'open');
  const resolvedIssues = (state.issueTracker || []).filter(i => i.status === 'resolved');

  // 停滞检测：同一 Issue 出现在多轮仍未解决
  const stagnantIssues = openIssues.filter(i => (round - (i.detectedRound || 0)) >= 3);

  const issueHistory = `
  [未解决的缺陷工单]：
  ${openIssues.map(i => `- [${i.id}] ${i.title} (${i.severity}): ${i.description} (影响文件: ${i.relatedFiles.join(", ")}) [已存在 ${round - (i.detectedRound || 0)} 轮]`).join("\n") || "暂无"}

  [停滞工单（连续3轮以上未解决，极可能是根因误判）]：
  ${stagnantIssues.map(i => `- [${i.id}] ${i.title} - 已持续 ${round - (i.detectedRound || 0)} 轮未修复`).join("\n") || "暂无"}

  [已解决的缺陷工单]：
  ${resolvedIssues.map(i => `- [${i.id}] ${i.title}`).join("\n") || "暂无"}
  `;

  // 上次的仲裁指令（如有），让架构师看到上次指令是否有效
  const previousDirectives = state.mediationDirectives && state.mediationDirectives.length > 0
    ? `\n  [上次仲裁指令（已执行但仍未解决）]：\n  ${state.mediationDirectives.map(d => `- ${d.file}: ${d.action} → ${d.detail}`).join("\n")}`
    : "";

  // 最新的测试失败输出
  const latestTestOutput = state.testResults
    ? `\n  [最新测试失败输出]：\n${state.testResults.slice(-1500)}`
    : "";

  const currentSpec = state.spec ? JSON.stringify({
    framework: state.spec.framework,
    dependencies: state.spec.dependencies,
    devDependencies: state.spec.devDependencies,
    architecture: state.spec.architecture,
  }, null, 2) : "暂无";

  const prompt = `开发已陷入循环，第 ${round} 轮仍未通过测试，这是第 ${mediationCount} 次仲裁介入。请你作为首席架构师进行深度分析。

  [当前架构设计]：
  ${currentSpec}

  [缺陷工单历史]：
  ${issueHistory}
  ${previousDirectives}
  ${latestTestOutput}

  [你的任务]：
  1. 判断失败根因类型：
     - **测试文件 bug**：测试代码本身有误（如 mock 污染、未使用的 import、断言逻辑错误），应指示 Coder 修正测试文件
     - **代码实现问题**：Coder 写错了源文件，给出修复指令
     - **设计问题**：当前架构/框架/依赖选型不合理导致的，需要修改设计
     - **契约冲突**：跨文件接口不一致，给出统一规范指令
  2. 对于**停滞工单**，优先质疑之前的根因判断是否正确，重新分析。
  3. 如果上次仲裁指令已下达但未解决，说明方向有误，必须给出不同的修复策略。
  4. 给出具体的 [仲裁指令] (mediationDirectives)，每条指令必须指向具体文件和具体修改内容，不能模糊。
  5. 如果需要修改 spec 中的 dependencies 或 devDependencies，在 directive 的 detail 中明确写出新的依赖结构。

  请仅输出 JSON 格式：{"directives": [{"file": "文件名或*", "action": "动作类型", "detail": "详细指令"}]}
  请确保内容使用中文。`;

  const response = await agents.architect.chat([{ role: "user", content: prompt }], (ev) => emit(ev.type, ev.sender, "正在分析冲突进行仲裁", ev), {
    workspaceDir: WORKSPACE,
    brief: buildSystemContext(state)
  });

  const parsed = parseJsonFromResponse(extractText(response.content), { directives: [] });
  const newDirectives = parsed.directives || [];

  const newDecisions = newDirectives.map((d: any) => `${d.file}: ${d.action}`);
  const updatedCore: ConsensusCore = {
    ...(state.consensusCore || { projectTitle: "", requirements: [], architectureSummary: "", techStack: "", framework: "", port: 0, coreDependencies: {}, coreDevDependencies: {}, criticalDecisions: [] }),
    criticalDecisions: [...(state.consensusCore?.criticalDecisions || []), ...newDecisions],
  };

  const noteId = `note-mediation-r${round}`;
  const summary = `架构仲裁第${round}轮：${newDirectives.length}条指令`;
  const fullContent = `# 架构仲裁纪要 - 第${round}轮\n\n## 仲裁指令\n\`\`\`json\n${JSON.stringify(newDirectives, null, 2)}\n\`\`\`\n\n## 缺陷历史\n${issueHistory}\n`;
  const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "mediation", round, summary, fullContent);

  return {
    mediationDirectives: newDirectives,
    consensusCore: updatedCore,
    meetingNotes: [meetingNote],
  };
}
