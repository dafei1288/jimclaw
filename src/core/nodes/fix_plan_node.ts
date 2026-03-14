import * as fs from "fs/promises";
import * as path from "path";
import { JimClawState, FixPlanItem } from "../graph_types";
import { BaseAgent } from "../agent";
import { buildSystemContext, writeMeetingNote } from "../logic_utils";
import { extractText, parseJsonFromResponse } from "../../utils/common";

/**
 * FixPlan 节点：QA 与 Coder 在编写代码前进行协商
 *
 * 流程：
 *  1. Coder 读取失败文件，说出自己的根因理解和修复方案
 *  2. QA 审查计划：批准 or 纠正
 *  3. 把达成共识的修复计划存入 state.fixPlan
 *  4. Coder 节点按计划执行，不再靠自己猜
 */
export async function fixPlanNode(
  state: JimClawState,
  agents: { coder: BaseAgent; qa: BaseAgent },
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("fix_plan");

  const round = state.retryCount || 0;
  const openIssues = (state.issueTracker || []).filter(i => i.status === "open");
  const failingFiles = Array.from(new Set([
    ...(state.qaFailures?.failedFiles || []),
    ...openIssues.flatMap(i => i.relatedFiles),
  ]));

  // 若无失败工单，直接跳过
  if (openIssues.length === 0 && failingFiles.length === 0) {
    return {};
  }

  emit("phase-change", "System", "fix_planning");
  emit("thinking", "System", `第 ${round} 轮：QA 与 Coder 正在协商修复计划（${failingFiles.length} 个文件）`, {});

  // === 读取失败文件的当前内容 ===
  const fileContents: Record<string, string> = {};
  for (const file of failingFiles.slice(0, 6)) {
    try {
      const content = await fs.readFile(path.join(WORKSPACE, file), "utf-8");
      fileContents[file] = content;
    } catch {}
  }

  // === Step 1：Coder 分析并提出修复计划 ===
  const coderPrompt = `你是星河（全栈开发工程师）。在动手写代码之前，请先仔细分析失败原因，制定修复计划。

[本轮测试失败输出]：
${(state.testResults || "").slice(-2500)}

[QA 提交的缺陷工单]：
${openIssues.map(i =>
  `- [${i.id}] ${i.title} (${i.severity})\n  描述：${i.description}\n  影响文件：${i.relatedFiles.join(", ")}`
).join("\n\n")}

[失败文件的当前内容]：
${Object.entries(fileContents).map(([f, c]) =>
  `### ${f}\n\`\`\`\n${c.slice(0, 2000)}\n\`\`\``
).join("\n\n")}

请认真阅读以上内容，输出你的修复计划（JSON格式）：
{
  "overall_diagnosis": "对所有失败问题的整体根因判断",
  "items": [
    {
      "file": "需要修改的文件路径",
      "issue_id": "关联的 Issue ID",
      "my_understanding": "我对这个问题根因的理解是...",
      "proposed_change": "我计划做的具体修改（越精确越好，如：第X行删除Y，在Z处添加W）",
      "confidence": "high/medium/low"
    }
  ]
}

注意：confidence=low 说明你自己也不确定，QA 会重点审查这些项。`;

  emit("thinking", agents.coder.getPersona().name, "正在分析失败原因，制定修复计划...", {});

  const coderResponse = await agents.coder.chat(
    [{ role: "user", content: coderPrompt }],
    (ev) => emit(ev.type, ev.sender, "制定修复计划中", ev),
    { brief: buildSystemContext(state), workspaceDir: WORKSPACE }
  );

  const coderPlan = parseJsonFromResponse(extractText(coderResponse.content), {
    overall_diagnosis: "（解析失败）",
    items: [],
  });

  // === Step 2：QA 审查计划 ===
  const qaPrompt = `你是清扬（测试工程师）。请审查开发工程师的修复计划，判断他的理解是否正确。

[原始测试失败输出]：
${(state.testResults || "").slice(-2500)}

[缺陷工单列表]：
${openIssues.map(i => `- [${i.id}] ${i.title}: ${i.description}`).join("\n")}

[星河的修复计划]：
${JSON.stringify(coderPlan, null, 2)}

请逐项审查：
1. 根因理解是否正确？（特别关注 confidence=low 的项）
2. 提出的具体修改是否能解决问题？
3. 是否有遗漏的修复点（测试还会继续失败的地方）？

输出审查结果（JSON格式）：
{
  "overall_assessment": "整体评估，一句话",
  "items": [
    {
      "file": "文件路径",
      "approved": true 或 false,
      "feedback": "如果 approved=false，写出正确的根因和具体修复方向"
    }
  ],
  "additional_fixes": [
    {
      "file": "被遗漏的文件",
      "diagnosis": "问题根因",
      "proposed_change": "具体需要的修改"
    }
  ]
}`;

  emit("thinking", agents.qa.getPersona().name, "正在审查修复计划...", {});

  const qaResponse = await agents.qa.chat(
    [{ role: "user", content: qaPrompt }],
    (ev) => emit(ev.type, ev.sender, "审查修复计划中", ev),
    { brief: buildSystemContext(state), workspaceDir: WORKSPACE }
  );

  const qaReview = parseJsonFromResponse(extractText(qaResponse.content), {
    overall_assessment: "（解析失败）",
    items: [],
    additional_fixes: [],
  });

  // === Step 3：合并为批准后的修复计划 ===
  const fixPlan: FixPlanItem[] = [];

  for (const item of (coderPlan.items || [])) {
    const review = (qaReview.items || []).find((r: any) => r.file === item.file);
    if (review && review.approved === false) {
      fixPlan.push({
        fileTarget: item.file,
        diagnosis: review.feedback || item.my_understanding,
        proposedChange: review.feedback || item.proposed_change,
        qaApproval: "corrected",
        qaFeedback: review.feedback,
      });
    } else {
      fixPlan.push({
        fileTarget: item.file,
        diagnosis: item.my_understanding,
        proposedChange: item.proposed_change,
        qaApproval: "approved",
      });
    }
  }

  // 把 QA 发现的遗漏文件也加入计划
  for (const extra of (qaReview.additional_fixes || [])) {
    if (!fixPlan.some(p => p.fileTarget === extra.file)) {
      fixPlan.push({
        fileTarget: extra.file,
        diagnosis: extra.diagnosis,
        proposedChange: extra.proposed_change,
        qaApproval: "approved",
      });
    }
  }

  // === 写入会议纪要 ===
  const approvedCount = fixPlan.filter(p => p.qaApproval === "approved").length;
  const correctedCount = fixPlan.filter(p => p.qaApproval === "corrected").length;
  const noteId = `note-fixplan-r${round}`;
  const summary = `第${round}轮修复协商：${fixPlan.length}项，批准${approvedCount}项，纠正${correctedCount}项`;
  const fullContent = [
    `# 修复计划协商纪要 - 第${round}轮\n`,
    `## 星河的整体诊断\n${coderPlan.overall_diagnosis}\n`,
    `## QA 的整体评估\n${qaReview.overall_assessment}\n`,
    `## 批准后的修复计划\n\`\`\`json\n${JSON.stringify(fixPlan, null, 2)}\n\`\`\`\n`,
    correctedCount > 0
      ? `## QA 纠正的项目（${correctedCount}项）\n${fixPlan.filter(p => p.qaApproval === "corrected").map(p => `- **${p.fileTarget}**: ${p.qaFeedback}`).join("\n")}\n`
      : "",
  ].join("\n");

  const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "fix_plan", round, summary, fullContent);

  // 同步更新 subTask 状态：把 fixPlan 涉及的文件重置为 pending（确保 coder 会处理）
  const updatedSubTasks = (state.subTasks || []).map(t => {
    if (fixPlan.some(p => p.fileTarget === t.fileTarget)) {
      return { ...t, status: "pending" as const };
    }
    return t;
  });

  await saveBoulder({ ...state, fixPlan, subTasks: updatedSubTasks }, "fix_plan");

  return {
    fixPlan,
    subTasks: updatedSubTasks,
    meetingNotes: [meetingNote],
  };
}
