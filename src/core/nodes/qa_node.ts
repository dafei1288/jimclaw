import { JimClawState, Issue, ConsensusProgress } from "../graph_types";
import { BaseAgent } from "../agent";
import {
  buildSystemContext,
  writeMeetingNote
} from "../logic_utils";
import { extractText, parseJsonFromResponse } from "../../utils/common";

/**
 * QA 节点：负责测试结果分析、定级并更新 IssueTracker
 */
export async function qaNode(
  state: JimClawState,
  agents: { qa: BaseAgent },
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("qa");
  emit("phase-change", "System", "verification");

  const round = state.retryCount || 0;
  const rawUnitOutput = state.testResults || "";
  const unitTestFail = /fail|error|✖/i.test(rawUnitOutput);
  const deploymentFail = state.deploymentStatus?.status === 'failed';

  // P0-D：拆分单元测试输出与部署错误，避免 QA 标签混乱
  const unitTestSection = rawUnitOutput.split("[部署验证失败]")[0].trim() || rawUnitOutput;
  const deployErrorSection = rawUnitOutput.includes("[部署验证失败]")
    ? rawUnitOutput.split("[部署验证失败]").slice(1).join("[部署验证失败]").trim()
    : (deploymentFail ? "部署健康检查失败，无详细日志" : "无");

  // 1. 如果完全没有错误，且之前的 Issue 都已解决，则直接通过
  const openIssues = (state.issueTracker || []).filter(i => i.status === 'open');
  if (!unitTestFail && !deploymentFail && openIssues.length === 0) {
    return { isDone: true };
  }

  // 静态提取失败的测试文件（比 LLM 更可靠）
  const failingTestFiles: string[] = [];
  const failPattern = /^FAIL\s+([\w/.+-]+\.(?:test|spec)\.[tj]s)/gm;
  let m;
  while ((m = failPattern.exec(rawUnitOutput)) !== null) {
    failingTestFiles.push(m[1]);
  }

  // 2. 唤醒 QA (清扬) 进行深度分析
  const prompt = `你现在是首席测试审计员。请根据以下信息分析系统质量并提交/更新 [缺陷工单 (Issues)]。

[项目需求与契约]：
- 任务契约：${JSON.stringify(state.contract)}
- 接口契约：${JSON.stringify(state.apiContract)}

[当前运行实测数据]：
- 单元测试结果：\n${unitTestSection}
- 部署连通性状态：${state.deploymentStatus?.status}
- 部署错误详情：${deployErrorSection}

[当前存量工单]：
${JSON.stringify(state.issueTracker || [])}

[你的任务]：
1. 识别新的 Bug，并为每个 Bug 创建唯一的 ID（如 BUG-001）。
2. 定级严重程度：
   - critical: 容器崩溃、服务不通、核心功能完全失效。
   - major: 业务逻辑错误、测试用例不通过。
   - minor: 格式问题、警告信息、不影响主流程的小瑕疵。
3. 验证 [存量工单]：只有在单元测试输出中能看到该具体错误已消失时，才将工单标记为 "resolved"。
   **铁律**：如果单元测试结果中仍然显示 "FAIL tests/xxx.test.ts"，则该测试文件相关的工单绝对不能标记为 resolved。
4. 提炼修复建议：不要只给报错，要告诉 Coder 应该改哪里。
5. **文件归因铁律**：
   - 如果错误信息显示 "FAIL tests/foo.test.ts" 或测试断言失败（如 expect(...).toBeDefined()），则 relatedFiles 必须首先包含 "tests/foo.test.ts"。
   - 如果是 TypeScript 编译错误（如 TS6133: 'X' is declared but never read），relatedFiles 必须包含报错的测试文件。
   - 只有当错误明确来自 src/ 的源文件（如接口不匹配、方法不存在），才将源文件列入 relatedFiles。
   - 常见陷阱：测试断言失败（mock.calls[0][0] 为 undefined）很可能是测试文件的 mock 状态污染（beforeEach 调用了 mock 导致 calls 数组非空），应修复测试文件，而非源文件。
6. **Jest mock 污染检测**：如果测试中使用了 mock.calls[0][0] 但 beforeEach 中调用了 mock 函数（如 register/setup），则问题根因是测试文件需要在 beforeEach 末尾添加 mockClear()，relatedFiles 应为测试文件。

请严格输出 JSON 数组格式：{"issues": [{"id": "...", "title": "...", "description": "...", "severity": "...", "status": "...", "relatedFiles": ["..."], "rawErrorSnippet": "...", "detectedRound": ${round}}]}
请确保内容使用中文。`;

  const response = await agents.qa.chat([{ role: "user", content: prompt }], (ev) => emit(ev.type, ev.sender, "正在深度审计质量问题", ev), {
    workspaceDir: WORKSPACE,
    brief: buildSystemContext(state)
  });

  const parsed = parseJsonFromResponse(extractText(response.content), { issues: [] });
  let issues: Issue[] = parsed.issues || [];

  // 安全网：如果 LLM 解析失败返回空数组，但测试仍在失败，保留上轮存量工单（防止 failedFiles 为空导致死循环）
  if (issues.length === 0 && (unitTestFail || deploymentFail)) {
    const existingOpen = (state.issueTracker || []).filter(i => i.status === 'open');
    if (existingOpen.length > 0) {
      issues = existingOpen;
    } else if (failingTestFiles.length > 0) {
      // 最后兜底：从静态检测到的失败测试文件生成工单
      issues = failingTestFiles.map((f, idx) => ({
        id: `BUG-AUTO-${idx + 1}`,
        title: `${f} 测试失败`,
        description: `测试文件 ${f} 在本轮测试中失败，请检查并修复。`,
        severity: 'major' as const,
        status: 'open' as const,
        relatedFiles: [f],
        rawErrorSnippet: '',
        detectedRound: round,
      }));
    }
  }

  // 3. 决策路由逻辑
  const activeCriticalIssues = issues.filter(i => i.status === 'open' && (i.severity === 'critical' || i.severity === 'major'));
  const isDone = activeCriticalIssues.length === 0 && !unitTestFail && !deploymentFail;

  // 更新 consensusProgress.openIssues
  const stillOpenIssues = issues.filter(i => i.status === 'open');
  const openIssueSummaries = stillOpenIssues.map(i => `${i.id} ${i.title}`);
  const consensusProgress: ConsensusProgress = {
    completedFiles: state.consensusProgress?.completedFiles || [],
    pendingFiles: state.consensusProgress?.pendingFiles || [],
    currentRound: round,
    openIssues: openIssueSummaries,
  };

  const critical = issues.filter(i => i.status === 'open' && i.severity === 'critical').length;
  const major = issues.filter(i => i.status === 'open' && i.severity === 'major').length;
  const noteId = `note-qa-r${round}`;
  const summary = `QA 第${round}轮：${critical}个严重，${major}个主要问题`;
  const fullContent = `# QA 第${round}轮审计纪要\n\n## 缺陷工单\n\`\`\`json\n${JSON.stringify(issues, null, 2)}\n\`\`\`\n`;
  const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "qa", round, summary, fullContent);

  // P1-B：QA 决策重试时统一增加 retryCount（语义：已完成 QA 判断并决定重试的次数）
  const result = {
    issueTracker: issues,
    isDone,
    retryCount: isDone ? (state.retryCount || 0) : (state.retryCount || 0) + 1,
    qaFailures: {
      // 合并 LLM 识别的文件 + 静态从测试输出提取的失败测试文件（双保险）
      failedFiles: Array.from(new Set([
        ...issues.filter(i => i.status === 'open').flatMap(i => i.relatedFiles),
        ...failingTestFiles,
      ])),
      testErrors: issues.filter(i => i.status === 'open').map(i => `${i.title}: ${i.description}`),
      failedTestNames: []
    },
    consensusProgress,
    meetingNotes: [meetingNote],
  };

  await saveBoulder({ ...state, ...result }, "qa");
  return result;
}
