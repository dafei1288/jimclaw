import { JimClawState } from "../graph_types";
import { buildRepairPlan, buildValidationReport, execInContainer, extractFailureEvidence, writeMeetingNote } from "../logic_utils";
import { AuditLogger } from "../../utils/audit";
import { createCommandExecutor } from "../../executor/command_executor";
import { classifyExecutorFailure, mapExecutorFailureToValidationFailure } from "../../executor/result_classifier";
import { ExecutorResult } from "../../executor/types";
import { createLocalShellAdapter } from "../../skills/shell_exec";

function isRetryableTerminalExecFailure(output: string): boolean {
  return /OCI runtime exec failed|container .* is not running|No such container/i.test(String(output || ""));
}

function isCommandFailureOutput(raw: string): boolean {
  return /^Command failed with (exit code\s+\d+|error:)/i.test(String(raw || "").trim());
}

function createDockerTestAdapter(containerId: string) {
  return {
    async execute(intent: { command?: string }): Promise<ExecutorResult> {
      if (!containerId) {
        return {
          ok: false,
          backend: null,
          stdout: "",
          stderr: "container not ready",
          retryable: false,
          requiresApproval: false,
          blocked: true,
          blockedReason: "container not ready",
          failureType: "executor_unavailable",
        };
      }
      let raw = "";
      try {
        raw = await execInContainer(containerId, intent.command || "", { timeout: 90000 });
      } catch (error: any) {
        raw = String(error?.message || error || "");
      }
      return {
        ok: !isCommandFailureOutput(raw),
        backend: "docker",
        stdout: raw,
        stderr: isCommandFailureOutput(raw) ? raw : "",
        retryable: isRetryableTerminalExecFailure(raw),
        requiresApproval: false,
        blocked: false,
        failureType: isCommandFailureOutput(raw) ? classifyExecutorFailure({ raw }) : undefined,
      };
    },
  };
}

function createTerminalExecutor(state: JimClawState) {
  const preferredBackend = state.executionBackend === "host" ? "local_shell" : "docker";
  return createCommandExecutor({
    resolveBackend: async (_intent, snapshot) => {
      if (preferredBackend === "local_shell") {
        return {
          selected: snapshot.localShell.available ? "local_shell" : null,
          candidates: snapshot.localShell.available ? ["local_shell"] : [],
          blocked: !snapshot.localShell.available,
          blockedReason: snapshot.localShell.available ? undefined : (snapshot.localShell.reason || "local shell unavailable"),
          requiresApproval: false,
        };
      }
      return {
        selected: snapshot.docker.cliAvailable && snapshot.docker.daemonReachable ? "docker" : null,
        candidates: snapshot.docker.cliAvailable && snapshot.docker.daemonReachable ? ["docker"] : [],
        blocked: !(snapshot.docker.cliAvailable && snapshot.docker.daemonReachable),
        blockedReason:
          snapshot.docker.cliAvailable && snapshot.docker.daemonReachable
            ? undefined
            : (snapshot.docker.reason || "docker unavailable"),
        requiresApproval: false,
      };
    },
    adapters: {
      local_shell: createLocalShellAdapter(),
      docker: createDockerTestAdapter(state.containerId || ""),
    },
  });
}

function buildTerminalExecutorFailure(state: JimClawState, result: ExecutorResult, summary: string): Partial<JimClawState> {
  const failureType = result.failureType || classifyExecutorFailure({
    stdout: result.stdout,
    stderr: result.stderr,
    raw: result.blockedReason || summary,
  });
  const validationReport = buildValidationReport(
    [{
      summary,
      evidence: [result.blockedReason || "", result.stderr || "", result.stdout || ""].filter(Boolean),
    }],
    {
      failureType: mapExecutorFailureToValidationFailure(failureType),
      blocking: true,
    }
  );
  return {
    validationReport,
    repairPlan: buildRepairPlan(validationReport),
    blockedReason: summary,
    lastFailedNode: "terminal",
    lastFailureSummary: summary,
    executorState: {
      version: "v1",
      capabilitySnapshot: state.executorState?.capabilitySnapshot,
      selectedBackend: result.backend,
      approvalTickets: state.executorState?.approvalTickets || [],
      runtimeHandles: state.executorState?.runtimeHandles || [],
      lastExecutorResult: result,
    },
  };
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
  saveBoulder: any,
  deps?: {
    commandExecutor?: Pick<ReturnType<typeof createCommandExecutor>, "executeIntent">;
  }
) {
  startSpan("terminal");
  emit("phase-change", "System", "verification");
  const testCmd = state.spec?.testCommand || "npm test";
  const executionBackend = state.executionBackend || "docker";
  const commandExecutor = deps?.commandExecutor || createTerminalExecutor(state);
  
  await AuditLogger.log(
    WORKSPACE,
    "Terminal",
    `### [Test Execution]\n\n**Command:** ${testCmd}\n**Backend:** ${executionBackend}\n**Container:** ${state.containerId}`
  );
  
  if (executionBackend !== "host" && !state.containerId) {
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

  let result: ExecutorResult = {
    ok: false,
    backend: executionBackend === "host" ? "local_shell" : "docker",
    stdout: "",
    stderr: "",
    retryable: false,
    requiresApproval: false,
    blocked: false,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    result = await commandExecutor.executeIntent({
      kind: "run_tests",
      workspace: WORKSPACE,
      command: executionBackend === "host" ? testCmd : `NODE_ENV=test ${testCmd}`,
    });

    if (attempt === 0 && (result.retryable || isRetryableTerminalExecFailure(result.stderr || result.stdout))) {
      await AuditLogger.log(
        WORKSPACE,
        "Terminal",
        `**Retry:** 测试执行出现瞬时错误，正在重试一次\n${result.stderr || result.stdout}`
      );
      continue;
    }
    break;
  }

  if ((result.blocked || result.failureType) && mapExecutorFailureToValidationFailure(
    result.failureType || classifyExecutorFailure({ raw: result.blockedReason || result.stderr || result.stdout })
  ) === "environment_gap") {
    const summary = `[Terminal] 测试执行环境不可用：${result.blockedReason || result.stderr || result.stdout || "run_tests failed"}`;
    const note = await writeMeetingNote(
      WORKSPACE,
      `note-terminal-r${state.retryCount || 0}`,
      "terminal",
      state.retryCount || 0,
      `Terminal 第${state.retryCount || 0}轮：测试执行环境失败`,
      `# Terminal 第${state.retryCount || 0}轮\n\n## 执行结论\n- 状态：环境失败\n- 原因：${summary}\n`
    );
    return {
      testResults: result.stderr || result.stdout || summary,
      meetingNotes: [note],
      ...buildTerminalExecutorFailure(state, result, summary),
    };
  }

  const rawOutput = result.stdout || result.stderr || "";
  await AuditLogger.log(WORKSPACE, "Terminal", `**Test Output:**\n${rawOutput}`);
  const evidence = extractFailureEvidence(rawOutput, state.deploymentStatus, state.blockedReason);
  const summary = evidence.hasBlockingFailure
    ? `Terminal 第${state.retryCount || 0}轮：测试失败`
    : `Terminal 第${state.retryCount || 0}轮：测试通过`;
  const note = await writeMeetingNote(
    WORKSPACE,
    `note-terminal-r${state.retryCount || 0}`,
    "terminal",
    state.retryCount || 0,
    summary,
    `# Terminal 第${state.retryCount || 0}轮\n\n## 执行信息\n- 命令：${testCmd}\n- 容器：${state.containerId}\n- 结论：${evidence.hasBlockingFailure ? "失败" : "通过"}\n\n## 原始输出\n\`\`\`text\n${rawOutput}\n\`\`\`\n`
  );

  return {
    testResults: rawOutput,
    meetingNotes: [note],
    blockedReason: "",
    lastFailedNode: evidence.hasBlockingFailure ? state.lastFailedNode : "",
    lastFailureSummary: evidence.hasBlockingFailure ? state.lastFailureSummary : "",
  };
}
