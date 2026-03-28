import { JimClawState, Issue, ConsensusProgress, ProtocolFailure, RepairLedgerEntry } from "../graph_types";
import { BaseAgent } from "../agent";
import {
  analyzeTestProblem,
  buildFailureFingerprint,
  buildRepairPlan,
  buildValidationReport,
  buildSystemContext,
  extractFailureEvidence,
  tryFixEnvironmentProblem,
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
  function buildIssuesFromProtocolFailures(protocolFailures: ProtocolFailure[], detectedRound: number): Issue[] {
    return protocolFailures.map((failure, index) => ({
      id: `BUG-PROTOCOL-${index + 1}`,
      title: `${failure.file || failure.node} 协议未通过`,
      description: failure.summary,
      severity: failure.blocking ? "major" as const : "minor" as const,
      status: "open" as const,
      relatedFiles: failure.file ? [failure.file] : [],
      rawErrorSnippet: failure.evidence?.join(" | ") || failure.summary,
      detectedRound,
    }));
  }

  function buildVerifierFallbackIssues(output: string, detectedRound: number): Issue[] {
    const verifierLines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("[Verifier 预检失败]"));

    return verifierLines.map((line, index) => {
      const fileMatch = line.match(/(?:文件|服务文件|测试文件)\s+([^\s:，,]+)/);
      const relatedFile = fileMatch?.[1] || "Verifier";
      return {
        id: `BUG-VERIFIER-${index + 1}`,
        title: `${relatedFile} 预检未通过`,
        description: line,
        severity: "major" as const,
        status: "open" as const,
        relatedFiles: fileMatch?.[1] ? [fileMatch[1]] : [],
        rawErrorSnippet: line,
        detectedRound,
      };
    });
  }

  function mapProtocolFailureType(
    failures: ProtocolFailure[]
  ): "planning_gap" | "implementation_bug" | "environment_gap" | "runtime_gap" {
    if (failures.some((failure) => failure.type === "tooling_unavailable")) return "environment_gap";
    if (failures.some((failure) => failure.type === "runtime_mismatch")) return "runtime_gap";
    if (failures.some((failure) => failure.type === "contract_drift")) return "implementation_bug";
    return "planning_gap";
  }

  function inferQaFailureType(
    issues: Issue[],
    opts: {
      verifierFailed: boolean;
      deploymentFail: boolean;
      environmentProblem: boolean;
    }
  ): "planning_gap" | "implementation_bug" | "environment_gap" | "runtime_gap" {
    if (opts.environmentProblem) return "environment_gap";
    if (opts.deploymentFail) return "runtime_gap";
    if (issues.some((issue) => /契约漂移|导出|语法|类型|阻塞/.test(`${issue.title} ${issue.description}`))) {
      return "implementation_bug";
    }
    if (opts.verifierFailed) return "planning_gap";
    return "implementation_bug";
  }

  startSpan("qa");
  emit("phase-change", "System", "verification");

  const round = state.retryCount || 0;
  const rawUnitOutput = state.testResults || "";
  const failureEvidence = extractFailureEvidence(rawUnitOutput, state.deploymentStatus, state.blockedReason);
  const unitTestFail = failureEvidence.hasBlockingFailure && !failureEvidence.deploymentFailed;
  const deploymentFail = failureEvidence.deploymentFailed;
  const failureFingerprint = buildFailureFingerprint(rawUnitOutput);
  const sameFailureCount = failureFingerprint && state.failureFingerprint === failureFingerprint
    ? (state.sameFailureCount || 0) + 1
    : (failureFingerprint ? 1 : 0);

  // P0-D：拆分单元测试输出与部署错误，避免 QA 标签混乱
  const unitTestSection = rawUnitOutput.split("[部署验证失败]")[0].trim() || rawUnitOutput;
  const deployErrorSection = rawUnitOutput.includes("[部署验证失败]")
    ? rawUnitOutput.split("[部署验证失败]").slice(1).join("[部署验证失败]").trim()
    : (deploymentFail ? "部署健康检查失败，无详细日志" : "无");

  // 1. 如果完全没有错误，且之前的 Issue 都已解决，则直接通过
  const openIssues = (state.issueTracker || []).filter(i => i.status === 'open');
  if (!failureEvidence.hasBlockingFailure && openIssues.length === 0) {
    const validationReport = buildValidationReport([], { status: "pass", blocking: false });
    return {
      isDone: true,
      qaFailures: null,
      recoveredEnvironment: false,
      failureFingerprint: "",
      sameFailureCount: 0,
      validationReport,
      repairPlan: null,
    };
  }

  // 1.0 如果当前没有任何失败证据，但还残留历史 open issues，
  // 说明这些工单已经失去现时性，不能再阻塞流程。
  if (!failureEvidence.hasBlockingFailure && openIssues.length > 0) {
    const resolvedIssues = (state.issueTracker || []).map((issue) =>
      issue.status === "open"
        ? {
            ...issue,
            status: "resolved" as const,
          }
        : issue
    );
    const consensusProgress: ConsensusProgress = {
      completedFiles: state.consensusProgress?.completedFiles || [],
      pendingFiles: state.consensusProgress?.pendingFiles || [],
      currentRound: round,
      openIssues: [],
    };
    const noteId = `note-qa-r${round}`;
    const summary = `QA 第${round}轮：放行，自动关闭 ${openIssues.length} 个历史工单`;
    const fullContent = `# QA 第${round}轮审计纪要

## 判定结论
- 结论：放行
- 是否存在失败证据：否
- 自动关闭的历史工单数：${openIssues.length}

## 说明
当前 terminal/verifier/deploy/coder 均未提供新的失败证据，因此历史遗留工单不再阻塞流程，已统一标记为 resolved。

## 已关闭工单
\`\`\`json
${JSON.stringify(resolvedIssues.filter((issue) => issue.status === "resolved"), null, 2)}
\`\`\`
`;
    const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "qa", round, summary, fullContent);
    const validationReport = buildValidationReport([], { status: "pass", blocking: false });
    const result = {
      issueTracker: resolvedIssues,
      isDone: true,
      retryCount: state.retryCount || 0,
      recoveredEnvironment: false,
      failureFingerprint: "",
      sameFailureCount: 0,
      qaFailures: null,
      protocolFailures: [],
      blockedReason: "",
      consensusProgress,
      meetingNotes: [meetingNote],
      validationReport,
      repairPlan: null,
      lastFailedNode: "",
      lastFailureSummary: "",
    };
    await saveBoulder({ ...state, ...result }, "qa");
    return result;
  }

  // 1.1 环境问题优先自动修复，避免把依赖缺失误判为代码缺陷反复返工
  const problem = analyzeTestProblem(rawUnitOutput, round, Boolean(state.mediationDirectives?.length));
  if (problem.type === "environment_problem") {
    emit("thinking", "System", `检测到环境类故障，尝试自动修复：${problem.reason}`, {});
    const fixed = await tryFixEnvironmentProblem(rawUnitOutput, state, WORKSPACE);
    if (fixed.fixed) {
      const ledger: RepairLedgerEntry[] = [{
        round,
        phase: "qa",
        action: fixed.action || "环境自动修复",
        result: "success",
        fingerprint: failureFingerprint || undefined,
      }];
      const validationReport = buildValidationReport(
        [{
          summary: fixed.action || "环境问题已自动修复",
          evidence: [problem.reason || fixed.action || "environment repaired"],
        }],
        { failureType: "environment_gap", blocking: true }
      );
      const result = {
        isDone: false,
        // 环境修复成功后不消耗重试次数，直接进入下一轮验证链路
        retryCount: state.retryCount || 0,
        recoveredEnvironment: true,
        failureFingerprint,
        sameFailureCount,
        qaFailures: { failedFiles: [], testErrors: [fixed.action || "环境修复成功"], failedTestNames: [] },
        testResults: `${rawUnitOutput}\n[环境自动修复] ${fixed.action || "已完成"}`,
        repairLedger: ledger,
        validationReport,
        repairPlan: buildRepairPlan(validationReport),
      };
      await saveBoulder({ ...state, ...result }, "qa_env_fix");
      return result;
    }
  }

  // 静态提取失败的测试文件（比 LLM 更可靠）
  const failingTestFiles: string[] = [];
  const failPattern = /^FAIL\s+([\w/.+-]+\.(?:test|spec)\.[tj]s)/gm;
  let m;
  while ((m = failPattern.exec(rawUnitOutput)) !== null) {
    failingTestFiles.push(m[1]);
  }

  const isCoderBlockedFailure = failureEvidence.coderBlocked;
  if (isCoderBlockedFailure) {
    const blockedFiles = Array.from(new Set(state.qaFailures?.failedFiles || []));
    const blockedErrors = state.qaFailures?.testErrors?.length
      ? state.qaFailures.testErrors
      : [state.blockedReason].filter(Boolean) as string[];
    const issues: Issue[] = blockedFiles.map((file, index) => ({
      id: `BUG-CODER-BLOCK-${index + 1}`,
      title: `${file} 阻塞了本轮生成`,
      description: `Coder 在生成 ${file} 时遇到阻塞错误，必须先修复该文件后才能继续后续文件生成。请优先处理这一个阻塞点，暂不要扩散到仍处于 pending 的文件。`,
      severity: "major",
      status: "open",
      relatedFiles: [file],
      rawErrorSnippet: blockedErrors[index] || blockedErrors[0] || state.blockedReason,
      detectedRound: round,
    }));

    const consensusProgress: ConsensusProgress = {
      completedFiles: state.consensusProgress?.completedFiles || [],
      pendingFiles: state.consensusProgress?.pendingFiles || [],
      currentRound: round,
      openIssues: issues.map((i) => `${i.id} ${i.title}`),
    };

    const noteId = `note-qa-r${round}`;
    const summary = `QA 第${round}轮：聚焦 Coder 阻塞文件 ${blockedFiles.join(", ")}`;
    const fullContent = `# QA 第${round}轮阻塞审计纪要\n\n## 阻塞原因\n${state.blockedReason}\n\n## 聚焦工单\n\`\`\`json\n${JSON.stringify(issues, null, 2)}\n\`\`\`\n`;
    const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "qa", round, summary, fullContent);
    const validationReport = buildValidationReport(
      blockedErrors.map((error, index) => ({
        summary: error,
        file: blockedFiles[index] || blockedFiles[0],
        evidence: [error],
      })),
      { failureType: "implementation_bug", blocking: true }
    );

    const result = {
      issueTracker: issues,
      isDone: false,
      retryCount: (state.retryCount || 0) + 1,
      recoveredEnvironment: false,
      failureFingerprint,
      sameFailureCount,
      qaFailures: {
        failedFiles: blockedFiles,
        testErrors: blockedErrors,
        failedTestNames: []
      },
      validationReport,
      repairPlan: buildRepairPlan(validationReport),
      consensusProgress,
      meetingNotes: [meetingNote],
      lastFailedNode: "coder",
      lastFailureSummary: state.blockedReason || blockedErrors[0] || "Coder 阻塞失败",
    };

    await saveBoulder({ ...state, ...result }, "qa");
    return result;
  }

  const blockingProtocolFailures = (state.protocolFailures || []).filter((item) => item?.blocking);
  if (blockingProtocolFailures.length > 0) {
    const issues = buildIssuesFromProtocolFailures(blockingProtocolFailures, round);
    const consensusProgress: ConsensusProgress = {
      completedFiles: state.consensusProgress?.completedFiles || [],
      pendingFiles: state.consensusProgress?.pendingFiles || [],
      currentRound: round,
      openIssues: issues.map((issue) => `${issue.id} ${issue.title}`),
    };
    const primaryFailure = blockingProtocolFailures[0];
    const failureType = mapProtocolFailureType(blockingProtocolFailures);
    const noteId = `note-qa-r${round}`;
    const summary = `QA 第${round}轮：协议阻塞 ${blockingProtocolFailures.length} 项`;
    const fullContent = `# QA 第${round}轮协议审计纪要

## 判定结论
- 结论：阻塞
- QA 是否调用 LLM：否
- 协议阻塞项数：${blockingProtocolFailures.length}

## 协议失败
\`\`\`json
${JSON.stringify(blockingProtocolFailures, null, 2)}
\`\`\`

## 生成工单
\`\`\`json
${JSON.stringify(issues, null, 2)}
\`\`\`
`;
    const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "qa", round, summary, fullContent);
    const validationReport = buildValidationReport(
      blockingProtocolFailures.map((failure) => ({
        summary: failure.summary,
        file: failure.file,
        evidence: failure.evidence || [failure.summary],
      })),
      { failureType, blocking: true }
    );
    const result = {
      issueTracker: issues,
      isDone: false,
      retryCount: (state.retryCount || 0) + 1,
      recoveredEnvironment: false,
      failureFingerprint,
      sameFailureCount,
      qaFailures: {
        failedFiles: Array.from(new Set(issues.flatMap((issue) => issue.relatedFiles))),
        testErrors: issues.map((issue) => `${issue.title}: ${issue.description}`),
        failedTestNames: [],
      },
      validationReport,
      repairPlan: buildRepairPlan(validationReport),
      consensusProgress,
      meetingNotes: [meetingNote],
      lastFailedNode: primaryFailure.node || "qa",
      lastFailureSummary: primaryFailure.summary || "执行协议未通过",
    };

    await saveBoulder({ ...state, ...result }, "qa");
    return result;
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
    mode: "coding",
    workspaceDir: WORKSPACE,
    brief: buildSystemContext(state)
  });

  const parsed = parseJsonFromResponse(extractText(response.content), { issues: [] });
  let issues: Issue[] = parsed.issues || [];

  // 安全网：如果 LLM 解析失败返回空数组，但验证仍未通过，必须生成兜底工单，禁止 QA 歧义放行
  if (issues.length === 0 && failureEvidence.hasBlockingFailure) {
    const existingOpen = (state.issueTracker || []).filter(i => i.status === 'open');
    if (existingOpen.length > 0) {
      issues = existingOpen;
    } else if (failingTestFiles.length > 0) {
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
    } else if (failureEvidence.verifierFailed) {
      issues = buildVerifierFallbackIssues(rawUnitOutput, round);
    } else if (deploymentFail) {
      issues = [{
        id: "BUG-DEPLOY-001",
        title: "部署连通性验证失败",
        description: deployErrorSection || "部署健康检查失败，请检查启动日志、监听端口和容器映射。",
        severity: "critical",
        status: "open",
        relatedFiles: [],
        rawErrorSnippet: rawUnitOutput.slice(0, 400),
        detectedRound: round,
      }];
    } else {
      issues = [{
        id: "BUG-QA-FALLBACK-001",
        title: "测试验证未通过",
        description: "测试输出中存在明确失败证据，但未能自动归因到具体工单，请优先检查最新失败日志。",
        severity: "major",
        status: "open",
        relatedFiles: [],
        rawErrorSnippet: rawUnitOutput.slice(0, 400),
        detectedRound: round,
      }];
    }
  }

  // 3. 决策路由逻辑
  const activeOpenIssues = issues.filter(i => i.status === 'open');
  const isDone = activeOpenIssues.length === 0 && !failureEvidence.hasBlockingFailure;

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
  const failureType = isDone
    ? undefined
    : inferQaFailureType(issues, {
        verifierFailed: failureEvidence.verifierFailed,
        deploymentFail,
        environmentProblem: problem.type === "environment_problem",
      });
  const noteId = `note-qa-r${round}`;
  const decisionLabel = isDone ? "放行" : "阻塞";
  const summary = `QA 第${round}轮：${decisionLabel}，${critical}个严重，${major}个主要问题`;
  const fullContent = `# QA 第${round}轮审计纪要

## 判定结论
- 结论：${decisionLabel}
- 是否存在失败证据：${failureEvidence.hasBlockingFailure ? "是" : "否"}
- Verifier 预检失败：${failureEvidence.verifierFailed ? "是" : "否"}
- 单元/编译失败：${unitTestFail ? "是" : "否"}
- 部署失败：${deploymentFail ? "是" : "否"}
- 当前未关闭工单数：${activeOpenIssues.length}

## 缺陷工单
\`\`\`json
${JSON.stringify(issues, null, 2)}
\`\`\`
  `;
  const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "qa", round, summary, fullContent);
  const validationReport = isDone
    ? buildValidationReport([], { status: "pass", blocking: false })
    : buildValidationReport(
        issues
          .filter((issue) => issue.status === "open")
          .map((issue) => ({
            summary: issue.title,
            file: issue.relatedFiles?.[0],
            evidence: [issue.description || issue.rawErrorSnippet || issue.title].filter(Boolean),
          })),
        { failureType, blocking: true }
      );

  // P1-B：QA 决策重试时统一增加 retryCount（语义：已完成 QA 判断并决定重试的次数）
  const result = {
    issueTracker: issues,
    isDone,
    retryCount: isDone ? (state.retryCount || 0) : (state.retryCount || 0) + 1,
    recoveredEnvironment: false,
    failureFingerprint: isDone ? "" : failureFingerprint,
    sameFailureCount: isDone ? 0 : sameFailureCount,
    qaFailures: isDone ? null : {
      // 合并 LLM 识别的文件 + 静态从测试输出提取的失败测试文件（双保险）
      failedFiles: Array.from(new Set([
        ...issues.filter(i => i.status === 'open').flatMap(i => i.relatedFiles),
        ...failingTestFiles,
      ])),
      testErrors: issues.filter(i => i.status === 'open').map(i => `${i.title}: ${i.description}`),
      failedTestNames: []
    },
    validationReport,
    repairPlan: isDone ? null : buildRepairPlan(validationReport),
    consensusProgress,
    meetingNotes: [meetingNote],
    lastFailedNode: isDone ? "" : (deploymentFail ? "deploy" : failureEvidence.verifierFailed ? "verifier" : "qa"),
    lastFailureSummary: isDone
      ? ""
      : (issues[0]?.title ? `${decisionLabel}：${issues[0].title}` : `${decisionLabel}：测试验证未通过`),
  };

  await saveBoulder({ ...state, ...result }, "qa");
  return result;
}
