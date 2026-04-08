import * as fs from "fs/promises";
import * as path from "path";
import { JimClawState, FixPlanItem, ProtocolPatch } from "../graph_types";
import { AgentResourceExhaustedError, AgentServiceUnavailableError, AgentTimeoutError, BaseAgent } from "../agent";
import { applyProtocolPatches, buildProtocolPatchesForFixPlan, buildSystemContext, writeMeetingNote } from "../logic_utils";
import { extractText, parseJsonFromResponse } from "../../utils/common";

const FIX_PLAN_CODER_TIMEOUT_MS = 120000;
const FIX_PLAN_QA_TIMEOUT_MS = 90000;

function isRecoverableFixPlanError(error: any): boolean {
  if (
    error instanceof AgentTimeoutError ||
    error instanceof AgentServiceUnavailableError ||
    error instanceof AgentResourceExhaustedError
  ) {
    return true;
  }
  const status = error?.status || error?.response?.status;
  if (status === 429) return true;
  const message = (error?.message || "").toLowerCase();
  return message.includes("429")
    || message.includes("余额不足")
    || message.includes("rate limit")
    || message.includes("quota")
    || message.includes("resource");
}

function buildDeterministicFixPlan(
  failingFiles: string[],
  openIssues: any[],
  state: JimClawState,
  coderPlan?: any
): FixPlanItem[] {
  const plan: FixPlanItem[] = [];

  for (const item of (coderPlan?.items || [])) {
    if (!item?.file) continue;
    plan.push({
      fileTarget: item.file,
      diagnosis: item.my_understanding || "模型降级后沿用开发工程师已有诊断。",
      proposedChange: item.proposed_change || `优先修复 ${item.file} 的当前阻塞错误，确保输出为纯代码且满足现有契约。`,
      qaApproval: "approved",
    });
  }

  for (const file of failingFiles) {
    if (plan.some((p) => p.fileTarget === file)) continue;
    const issue = openIssues.find((i: any) => i.relatedFiles?.includes(file));
    const matchingError = (state.qaFailures?.testErrors || []).find((msg: string) => msg.includes(file));
    plan.push({
      fileTarget: file,
      diagnosis: issue?.description || matchingError || `${file} 当前存在阻塞错误，需要先恢复最小正确实现。`,
      proposedChange: `聚焦修复 ${file} 的阻塞问题，保持改动最小化，输出必须为纯代码，且不要扩散到仍处于 pending 的文件。`,
      qaApproval: "approved",
    });
  }

  return plan;
}

function buildSyntheticOpenIssuesFromProtocolFailures(state: JimClawState) {
  return (state.protocolFailures || [])
    .filter((failure) => failure?.blocking)
    .map((failure, index) => ({
      id: `BUG-PROTOCOL-${index + 1}`,
      title: `${failure.file || failure.node} 协议未通过`,
      description: failure.summary,
      severity: "major" as const,
      status: "open" as const,
      relatedFiles: failure.file ? [failure.file] : [],
      rawErrorSnippet: failure.evidence?.join(" | ") || failure.summary,
      detectedRound: state.retryCount || 0,
    }));
}

function summarizeBlock(text: string | undefined, limit = 1200): string {
  const normalized = String(text || "").trim();
  if (!normalized) return "（无）";
  if (normalized.length <= limit) return normalized;
  const head = normalized.slice(0, Math.floor(limit * 0.65));
  const tail = normalized.slice(-Math.floor(limit * 0.25));
  return `${head}\n...\n[已截断 ${normalized.length - head.length - tail.length} 字符]\n...\n${tail}`;
}

function summarizeIssues(openIssues: any[], limit = 6): string {
  if (!openIssues.length) return "（无）";
  return openIssues.slice(0, limit).map((i) =>
    `- [${i.id}] ${i.title} (${i.severity})\n  描述：${summarizeBlock(i.description, 180)}\n  影响文件：${(i.relatedFiles || []).slice(0, 4).join(", ")}`
  ).join("\n\n");
}

function summarizeFailingFiles(fileContents: Record<string, string>, limit = 4): string {
  const entries = Object.entries(fileContents).slice(0, limit);
  if (!entries.length) return "（无）";
  return entries.map(([f, c]) =>
    `### ${f}\n\`\`\`\n${summarizeBlock(c, 900)}\n\`\`\``
  ).join("\n\n");
}

function summarizeCoderPlan(coderPlan: any): string {
  const items = Array.isArray(coderPlan?.items) ? coderPlan.items.slice(0, 6) : [];
  const compact = {
    overall_diagnosis: summarizeBlock(coderPlan?.overall_diagnosis || "（无）", 240),
    items: items.map((item: any) => ({
      file: item?.file,
      issue_id: item?.issue_id,
      my_understanding: summarizeBlock(item?.my_understanding || "", 180),
      proposed_change: summarizeBlock(item?.proposed_change || "", 220),
      confidence: item?.confidence,
    })),
  };
  return JSON.stringify(compact, null, 2);
}

function shouldBypassLlmCollaboration(
  failingFiles: string[],
  openIssues: any[],
  state: JimClawState
): { bypass: boolean; reason: string } {
  if (failingFiles.length === 0) return { bypass: false, reason: "" };
  const hasQaFailedFiles = (state.qaFailures?.failedFiles || []).length > 0;
  if (!hasQaFailedFiles) return { bypass: false, reason: "" };

  const staticIssueIdPattern = /^(BUG-COMPILE-|BUG-AUTO-|BUG-VERIFIER-|BUG-DEPLOY-|BUG-QA-FALLBACK-)/;
  const staticIssueSignals = openIssues.filter((issue: any) =>
    staticIssueIdPattern.test(String(issue?.id || "")) ||
    /静态兜底|模型不可用|模型降级/.test(`${issue?.description || ""} ${issue?.title || ""}`)
  );
  const allStatic = openIssues.length > 0 && staticIssueSignals.length === openIssues.length;
  if (!allStatic) return { bypass: false, reason: "" };

  return {
    bypass: true,
    reason: "QA 侧已进入静态归因兜底，直接生成确定性 fixPlan，跳过模型协商超时风险。",
  };
}

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
  const issueOpenIssues = (state.issueTracker || []).filter(i => i.status === "open");
  const protocolOpenIssues = buildSyntheticOpenIssuesFromProtocolFailures(state);
  const openIssues = protocolOpenIssues.length > 0 ? protocolOpenIssues : issueOpenIssues;
  const failingFiles = Array.from(new Set([
    ...(state.qaFailures?.failedFiles || []),
    ...openIssues.flatMap(i => i.relatedFiles),
  ]));

  // 若无失败工单，直接跳过
  if (openIssues.length === 0 && failingFiles.length === 0) {
    return {};
  }

  if (state.repairPlan?.repairType && state.repairPlan.repairType !== "implementation") {
    const noteId = `note-fixplan-r${round}`;
    const summary = `第${round}轮修复协商：跳过实现修复，转交 ${state.repairPlan.repairType}`;
    const fullContent = `# 修复计划协商纪要 - 第${round}轮\n\n## 结论\n当前失败类型为 ${state.repairPlan.repairType}，不属于实现错误，fix_plan 不再生成代码修复计划。\n\n## RepairPlan\n\`\`\`json\n${JSON.stringify(state.repairPlan, null, 2)}\n\`\`\`\n`;
    const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "fix_plan", round, summary, fullContent);
    const result = {
      fixPlan: [],
      meetingNotes: [meetingNote],
    };
    await saveBoulder({ ...state, ...result }, "fix_plan");
    return result;
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
  const summarizedTestResults = summarizeBlock(state.testResults || "", 1800);
  const summarizedIssues = summarizeIssues(openIssues, 6);
  const summarizedFiles = summarizeFailingFiles(fileContents, 4);

  const coderPrompt = `你是星河（全栈开发工程师）。在动手写代码之前，请先仔细分析失败原因，制定修复计划。

[本轮测试失败输出]：
${summarizedTestResults}

[QA 提交的缺陷工单]：
${summarizedIssues}

[失败文件的当前内容]：
${summarizedFiles}

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
  let coderPlan: any = {
    overall_diagnosis: "（解析失败）",
    items: [],
  };
  let degradedByFallback = false;
  const bypassDecision = shouldBypassLlmCollaboration(failingFiles, openIssues, state);
  if (bypassDecision.bypass) {
    degradedByFallback = true;
    coderPlan = {
      overall_diagnosis: bypassDecision.reason,
      items: [],
    };
    emit("thinking", "System", `fix_plan 进入静态快速通道：${bypassDecision.reason}`, {});
  }

  if (!degradedByFallback) {
    try {
      const coderResponse = await agents.coder.chat(
        [{ role: "user", content: coderPrompt }],
        (ev) => emit(ev.type, ev.sender, "制定修复计划中", ev),
        {
          mode: "coding",
          brief: buildSystemContext(state),
          workspaceDir: WORKSPACE,
          timeoutMs: FIX_PLAN_CODER_TIMEOUT_MS,
        }
      );

      coderPlan = parseJsonFromResponse(extractText(coderResponse.content), {
        overall_diagnosis: "（解析失败）",
        items: [],
      });
    } catch (error: any) {
      if (!isRecoverableFixPlanError(error)) throw error;
      degradedByFallback = true;
      emit("thinking", "System", `fix_plan 模型资源不可用，切换为规则化修复计划：${error.message || error}`, {});
      coderPlan = {
        overall_diagnosis: `模型资源不足，使用规则化降级计划。原始错误：${error.message || error}`,
        items: [],
      };
    }
  }

  // === Step 2：QA 审查计划 ===
  const qaPrompt = `你是清扬（测试工程师）。请审查开发工程师的修复计划，判断他的理解是否正确。

[原始测试失败输出]：
${summarizedTestResults}

[缺陷工单列表]：
${summarizedIssues}

[星河的修复计划]：
${summarizeCoderPlan(coderPlan)}

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

  let qaReview: any = {
    overall_assessment: degradedByFallback ? "模型资源不足，已转规则化修复计划。" : "（解析失败）",
    items: [],
    additional_fixes: [],
  };

  if (!degradedByFallback) {
    emit("thinking", agents.qa.getPersona().name, "正在审查修复计划...", {});
    try {
      const qaResponse = await agents.qa.chat(
        [{ role: "user", content: qaPrompt }],
        (ev) => emit(ev.type, ev.sender, "审查修复计划中", ev),
        {
          mode: "coding",
          brief: buildSystemContext(state),
          workspaceDir: WORKSPACE,
          timeoutMs: FIX_PLAN_QA_TIMEOUT_MS,
        }
      );

      qaReview = parseJsonFromResponse(extractText(qaResponse.content), {
        overall_assessment: "（解析失败）",
        items: [],
        additional_fixes: [],
      });
    } catch (error: any) {
      if (!isRecoverableFixPlanError(error)) throw error;
      degradedByFallback = true;
      emit("thinking", "System", `fix_plan QA 审查模型资源不可用，切换为规则化修复计划：${error.message || error}`, {});
      qaReview = {
        overall_assessment: `QA 模型资源不足，自动批准规则化修复计划。原始错误：${error.message || error}`,
        items: [],
        additional_fixes: [],
      };
    }
  }

  // === Step 3：合并为批准后的修复计划 ===
  const fixPlan: FixPlanItem[] = degradedByFallback
    ? buildDeterministicFixPlan(failingFiles, openIssues, state, coderPlan)
    : [];
  let protocolPatches: ProtocolPatch[] = buildProtocolPatchesForFixPlan(
    failingFiles,
    state.executionProtocol,
    state.apiContract
  );

  if (!degradedByFallback) {
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

    protocolPatches = buildProtocolPatchesForFixPlan(
      Array.from(new Set(fixPlan.map((item) => item.fileTarget))),
      state.executionProtocol,
      state.apiContract
    );
  }

  for (const file of failingFiles) {
    if (fixPlan.some((item) => item.fileTarget === file)) continue;
    const issue = openIssues.find((item: any) => item.relatedFiles?.includes(file));
    const matchingError = (state.qaFailures?.testErrors || []).find((msg: string) => msg.includes(file));
    fixPlan.push({
      fileTarget: file,
      diagnosis: issue?.description || matchingError || `${file} 已被 QA 标记为需重开修复，但协商输出遗漏了该文件。`,
      proposedChange: issue?.description
        ? `围绕以下问题做最小修复：${issue.description}`
        : `优先修复 ${file} 当前暴露的问题，保持改动最小且不要扩散到无关文件。`,
      qaApproval: "approved",
      qaFeedback: "该文件已进入 QA 重开集合，不能因协商遗漏而跳过。",
    });
  }

  protocolPatches = buildProtocolPatchesForFixPlan(
    Array.from(new Set(fixPlan.map((item) => item.fileTarget))),
    state.executionProtocol,
    state.apiContract
  );

  // === 写入会议纪要 ===
  const approvedCount = fixPlan.filter(p => p.qaApproval === "approved").length;
  const correctedCount = fixPlan.filter(p => p.qaApproval === "corrected").length;
  const noteId = `note-fixplan-r${round}`;
  const summary = degradedByFallback
    ? `第${round}轮修复协商：模型降级，生成${fixPlan.length}项规则化修复计划`
    : `第${round}轮修复协商：${fixPlan.length}项，批准${approvedCount}项，纠正${correctedCount}项`;
  const fullContent = [
    `# 修复计划协商纪要 - 第${round}轮\n`,
    `## 星河的整体诊断\n${coderPlan.overall_diagnosis}\n`,
    `## QA 的整体评估\n${qaReview.overall_assessment}\n`,
    degradedByFallback ? `## 降级说明\n本轮因模型资源不足，改用规则化修复计划，避免修复链路整体中断。\n` : "",
    `## 批准后的修复计划\n\`\`\`json\n${JSON.stringify(fixPlan, null, 2)}\n\`\`\`\n`,
    `## 协议补丁\n\`\`\`json\n${JSON.stringify(protocolPatches, null, 2)}\n\`\`\`\n`,
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
  const nextExecutionProtocol = applyProtocolPatches(state.executionProtocol, protocolPatches);

  await saveBoulder({ ...state, fixPlan, protocolPatches, executionProtocol: nextExecutionProtocol, subTasks: updatedSubTasks }, "fix_plan");

  return {
    fixPlan,
    protocolPatches,
    executionProtocol: nextExecutionProtocol,
    subTasks: updatedSubTasks,
    meetingNotes: [meetingNote],
  };
}
