import { JimClawState } from "../graph_types";
import { execInContainer, extractFailureEvidence, writeMeetingNote } from "../logic_utils";
import { AuditLogger } from "../../utils/audit";
import { ShellExecuteSkill } from "../../skills/shell_exec";

function isRetryableTerminalExecFailure(output: string): boolean {
  return /OCI runtime exec failed|container .* is not running|No such container/i.test(String(output || ""));
}

/**
 * Terminal 节点：负责在容器中执行测试命令
 */
export async function terminalNode(
  state: JimClawState,
  agents: any,
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("terminal");
  emit("phase-change", "System", "verification");
  const testCmd = state.spec?.testCommand || "npm test";
  const executionBackend = state.executionBackend || "docker";
  
  await AuditLogger.log(
    WORKSPACE,
    "Terminal",
    `### [Test Execution]\n\n**Command:** ${testCmd}\n**Backend:** ${executionBackend}\n**Container:** ${state.containerId}`
  );

  if (executionBackend === "host") {
    const hostResult = await ShellExecuteSkill.config.run({
      command: testCmd,
      workDir: WORKSPACE,
      timeout: 90000,
    });
    await AuditLogger.log(WORKSPACE, "Terminal", `**Host Test Output:**\n${hostResult}`);
    const evidence = extractFailureEvidence(hostResult, state.deploymentStatus, state.blockedReason);
    const note = await writeMeetingNote(
      WORKSPACE,
      `note-terminal-r${state.retryCount || 0}`,
      "terminal",
      state.retryCount || 0,
      evidence.hasBlockingFailure ? `Terminal 第${state.retryCount || 0}轮：宿主机测试失败` : `Terminal 第${state.retryCount || 0}轮：宿主机测试通过`,
      `# Terminal 第${state.retryCount || 0}轮\n\n## 执行信息\n- 命令：${testCmd}\n- 后端：host\n- 结论：${evidence.hasBlockingFailure ? "失败" : "通过"}\n\n## 原始输出\n\`\`\`text\n${hostResult}\n\`\`\`\n`
    );
    return {
      testResults: hostResult,
      meetingNotes: [note],
      blockedReason: "",
      lastFailedNode: evidence.hasBlockingFailure ? state.lastFailedNode : "",
      lastFailureSummary: evidence.hasBlockingFailure ? state.lastFailureSummary : "",
    };
  }
  
  if (!state.containerId) {
    // 保留 infra_node 写入的构建错误（如 Dockerfile 错误），不用通用信息覆盖
    const errMsg = state.testResults?.includes("基础设施")
      ? state.testResults
      : "[Terminal] 容器 ID 为空，跳过测试执行。请检查 infra_setup 是否成功启动容器。";
    await AuditLogger.log(WORKSPACE, "Terminal", `**Skipped:** ${errMsg}`);
    const note = await writeMeetingNote(
      WORKSPACE,
      `note-terminal-r${state.retryCount || 0}`,
      "terminal",
      state.retryCount || 0,
      `Terminal 第${state.retryCount || 0}轮：跳过测试，容器未就绪`,
      `# Terminal 第${state.retryCount || 0}轮\n\n## 执行结论\n- 状态：跳过\n- 原因：${errMsg}\n`
    );
    return { testResults: errMsg, meetingNotes: [note] };
  }

  let result = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      result = await execInContainer(state.containerId, `NODE_ENV=test ${testCmd}`, { timeout: 90000 });
    } catch (error: any) {
      result = String(error?.message || error || "");
    }

    if (attempt === 0 && isRetryableTerminalExecFailure(result)) {
      await AuditLogger.log(
        WORKSPACE,
        "Terminal",
        `**Retry:** 测试容器执行出现瞬时错误，正在重试一次\n${result}`
      );
      continue;
    }
    break;
  }
  
  await AuditLogger.log(WORKSPACE, "Terminal", `**Test Output:**\n${result}`);
  const evidence = extractFailureEvidence(result, state.deploymentStatus, state.blockedReason);
  const summary = evidence.hasBlockingFailure
    ? `Terminal 第${state.retryCount || 0}轮：测试失败`
    : `Terminal 第${state.retryCount || 0}轮：测试通过`;
  const note = await writeMeetingNote(
    WORKSPACE,
    `note-terminal-r${state.retryCount || 0}`,
    "terminal",
    state.retryCount || 0,
    summary,
    `# Terminal 第${state.retryCount || 0}轮\n\n## 执行信息\n- 命令：${testCmd}\n- 容器：${state.containerId}\n- 结论：${evidence.hasBlockingFailure ? "失败" : "通过"}\n\n## 原始输出\n\`\`\`text\n${result}\n\`\`\`\n`
  );

  return {
    testResults: result,
    meetingNotes: [note],
    blockedReason: "",
    lastFailedNode: evidence.hasBlockingFailure ? state.lastFailedNode : "",
    lastFailureSummary: evidence.hasBlockingFailure ? state.lastFailureSummary : "",
  };
}
