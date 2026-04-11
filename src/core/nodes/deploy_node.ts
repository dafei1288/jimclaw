import { JimClawState } from "../graph_types";
import { buildRepairPlan, buildValidationReport, execInContainer, writeMeetingNote } from "../logic_utils";
import { createCommandExecutor } from "../../executor/command_executor";
import { resolvePreferredBackend } from "../../executor/backend_resolver";
import { classifyExecutorFailure, mapExecutorFailureToValidationFailure } from "../../executor/result_classifier";
import { ExecutorResult } from "../../executor/types";
import { GetServerIPSkill } from "../../skills/get_server_ip";
import { createLocalShellAdapter, ShellExecuteSkill } from "../../skills/shell_exec";
import { AuditLogger } from "../../utils/audit";
import * as fs from "fs/promises";
import * as path from "path";
import { runWithHeartbeat } from "../node_heartbeat";

function isRetryableDeployLaunchFailure(output: string): boolean {
  return /OCI runtime exec failed|container .* is not running|No such container/i.test(String(output || ""));
}

function isCommandFailureOutput(output: string): boolean {
  return /^Command failed with (exit code\s+\d+|error:)/i.test(String(output || "").trim());
}

function createDockerRuntimeAdapter(containerId: string) {
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
      let lastOutput = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          lastOutput = await execInContainer(containerId, intent.command || "", { background: true });
        } catch (error: any) {
          lastOutput = String(error?.message || error || "");
        }
        if (attempt === 0 && isRetryableDeployLaunchFailure(lastOutput)) {
          continue;
        }
        break;
      }
      return {
        ok: !isCommandFailureOutput(lastOutput),
        backend: "docker",
        stdout: lastOutput,
        stderr: isCommandFailureOutput(lastOutput) ? lastOutput : "",
        retryable: false,
        requiresApproval: false,
        blocked: false,
        failureType: isCommandFailureOutput(lastOutput) ? classifyExecutorFailure({ raw: lastOutput }) : undefined,
      };
    },
  };
}

function createDeployExecutor(state: JimClawState) {
  const preferredBackend = state.executionBackend === "host" ? "local_shell" : "docker";
  return createCommandExecutor({
    resolveBackend: async (_intent, snapshot) =>
      resolvePreferredBackend(
        state.executorState?.selectedBackend === "external_executor" ? "local_shell" : preferredBackend,
        snapshot
      ),
    adapters: {
      local_shell: createLocalShellAdapter(),
      docker: createDockerRuntimeAdapter(state.containerId || ""),
    },
  });
}

function buildDeployExecutorState(state: JimClawState, result: ExecutorResult): NonNullable<JimClawState["executorState"]> {
  const approvalTickets = [...(state.executorState?.approvalTickets || [])];
  if (result.requiresApproval && result.approvalTicketId && !approvalTickets.some((ticket) => ticket.id === result.approvalTicketId)) {
    approvalTickets.push({
      id: result.approvalTicketId,
      stage: "background_runtime",
      required: true,
      status: "pending",
      reason: result.blockedReason || "approval required for start_runtime",
      requestedAt: new Date().toISOString(),
    });
  }
  return {
    version: "v1",
    capabilitySnapshot: state.executorState?.capabilitySnapshot,
    selectedBackend: result.backend,
    approvalTickets,
    runtimeHandles: state.executorState?.runtimeHandles || [],
    lastExecutorResult: result,
  };
}

export function buildDeploymentUrls(ip: string, hostPort: string) {
  return {
    publicUrl: `http://${ip}:${hostPort}`,
    healthCheckUrl: `http://127.0.0.1:${hostPort}`,
  };
}

export function getHealthCheckPath(state: JimClawState): string {
  const protocolPath = state.executionProtocol?.runtime?.healthCheckPath;
  if (protocolPath) return protocolPath;
  const apiHealthPath = state.apiContract?.endpoints?.find(
    (item) => item.method?.toUpperCase() === "GET" && /^\/api\/health\/?$/i.test(String(item.path || ""))
  )?.path;
  if (apiHealthPath) return apiHealthPath;
  const healthPath = state.apiContract?.endpoints?.find(
    (item) => item.method?.toUpperCase() === "GET" && /^\/health\/?$/i.test(String(item.path || ""))
  )?.path;
  if (healthPath) return healthPath;
  return "/";
}

function getHealthCheckCandidatePaths(state: JimClawState): string[] {
  const preferred = getHealthCheckPath(state);
  const candidates = [
    preferred,
    "/api/health",
    "/health",
    "/",
  ];
  return Array.from(new Set(candidates.filter(Boolean)));
}

export function getDeployPreconditionFailure(state: JimClawState): string | null {
  if (state.executionBackend === "host") {
    if (String(state.lastFailedNode || "") === "infra_setup") {
      return String(state.lastFailureSummary || "") || "宿主机基础设施尚未成功，禁止继续进入部署验证。";
    }
    return null;
  }
  const currentFailureNode = String(state.lastFailedNode || "");
  const currentFailureSummary = String(state.lastFailureSummary || "");
  if (currentFailureNode === "infra_setup") {
    if (/docker api|docker 守护进程|failed to connect to the docker api/i.test(currentFailureSummary)) {
      return "Docker 守护进程不可用，禁止继续进入部署验证。";
    }
    return currentFailureSummary || "基础设施构建尚未成功，禁止继续进入部署验证。";
  }
  if (!state.containerId) {
    return "未获得可用容器，禁止继续进入部署验证。";
  }
  return null;
}

function getHostRuntimeArtifactPaths(workspace: string) {
  return {
    runtimeDir: path.join(workspace, ".jimclaw"),
    pidPath: path.join(workspace, ".jimclaw", "server.pid"),
    logPath: path.join(workspace, ".jimclaw", "server.log"),
    stdoutLogPath: path.join(workspace, ".jimclaw", "server.stdout.log"),
    stderrLogPath: path.join(workspace, ".jimclaw", "server.stderr.log"),
  };
}

function escapePowerShellSingleQuoted(text: string): string {
  return String(text || "").replace(/'/g, "''");
}

function buildHostDeployLaunchCommand(workspace: string, runCmd: string, port: number) {
  const { pidPath, stdoutLogPath, stderrLogPath } = getHostRuntimeArtifactPaths(workspace);
  if (process.platform === "win32") {
    const escapedCmd = escapePowerShellSingleQuoted(runCmd);
    const escapedPid = escapePowerShellSingleQuoted(pidPath);
    const escapedStdoutLog = escapePowerShellSingleQuoted(stdoutLogPath);
    const escapedStderrLog = escapePowerShellSingleQuoted(stderrLogPath);
    const escapedWorkspace = escapePowerShellSingleQuoted(workspace);
    return [
      "powershell -NoProfile -Command ",
      `"`,
      `$pidPath='${escapedPid}'; `,
      `$stdoutLogPath='${escapedStdoutLog}'; `,
      `$stderrLogPath='${escapedStderrLog}'; `,
      `New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($pidPath)) | Out-Null; `,
      `if (Test-Path $pidPath) { $oldPid = Get-Content $pidPath -ErrorAction SilentlyContinue; if ($oldPid) { Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue } } `,
      `$env:PORT='${port}'; $env:HOST='0.0.0.0'; `,
      `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','${escapedCmd}' -WorkingDirectory '${escapedWorkspace}' -RedirectStandardOutput $stdoutLogPath -RedirectStandardError $stderrLogPath -PassThru; `,
      `Set-Content -Path $pidPath -Value $p.Id; Write-Output $p.Id`,
      `"`
    ].join("");
  }
  return [
    "mkdir -p .jimclaw",
    "if [ -f .jimclaw/server.pid ]; then kill $(cat .jimclaw/server.pid) 2>/dev/null || true; fi",
    `PORT=${port} HOST=0.0.0.0 nohup sh -c ${JSON.stringify(runCmd)} > .jimclaw/server.log 2>&1 & echo $! > .jimclaw/server.pid`,
    "cat .jimclaw/server.pid",
  ].join("; ");
}

function unwrapShellOutput(raw: string): string {
  const text = String(raw || "");
  const match = text.match(/Output:\n([\s\S]*?)(?:\nErrors:|$)/);
  return (match ? match[1] : text).trim();
}

function extractShellErrors(raw: string): string {
  const text = String(raw || "");
  const match = text.match(/\nErrors:\n([\s\S]*)$/);
  return (match ? match[1] : "").trim();
}

function parseHostLaunchResult(raw: string): { pid: number; errors: string; text: string } {
  const text = unwrapShellOutput(raw);
  const errors = extractShellErrors(raw);
  const pidMatch = text.match(/\b(\d+)\b/g);
  const pid = pidMatch?.length ? Number(pidMatch[pidMatch.length - 1]) : 0;
  return { pid, errors, text };
}

function buildDeployRuntimeFailureArtifacts(
  state: JimClawState,
  summary: string,
  evidence: string[]
) {
  const targetFile =
    state.spec?.entryPoint ||
    state.executionProtocol?.project?.workspaceLayout?.entryFiles?.[0] ||
    undefined;
  const validationReport = buildValidationReport(
    [
      {
        summary,
        file: targetFile,
        evidence,
      },
    ],
    { failureType: "runtime_gap", blocking: true }
  );

  return {
    validationReport,
    repairPlan: buildRepairPlan(validationReport),
    protocolFailures: [
      {
        type: "runtime_mismatch" as const,
        node: "deploy",
        file: targetFile,
        summary,
        evidence,
        blocking: true,
      },
    ],
  };
}

function buildDeployExecutorFailure(
  state: JimClawState,
  result: ExecutorResult,
  summary: string
) {
  const targetFile =
    state.spec?.entryPoint ||
    state.executionProtocol?.project?.workspaceLayout?.entryFiles?.[0] ||
    undefined;
  const evidence = [result.blockedReason || "", result.stderr || "", result.stdout || ""].filter(Boolean);
  const failureType = result.failureType || classifyExecutorFailure({
    raw: result.blockedReason || summary,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  const validationFailureType = mapExecutorFailureToValidationFailure(failureType);
  const validationReport = buildValidationReport(
    [
      {
        summary,
        file: targetFile,
        evidence,
      },
    ],
    {
      failureType: validationFailureType,
      blocking: true,
    }
  );

  return {
    validationReport,
    repairPlan: buildRepairPlan(validationReport),
    protocolFailures: [
      {
        type: validationFailureType === "environment_gap" ? "tooling_unavailable" as const : "runtime_mismatch" as const,
        node: "deploy",
        file: targetFile,
        summary,
        evidence,
        blocking: true,
      },
    ],
  };
}

function classifyDeploymentVerificationFailure(args: {
  state: JimClawState;
  targetInternalPort: number;
  publicUrl: string;
  healthCheckTarget: string;
  lastError: string;
  internalAudit: string;
  processLog: string;
  pidInfo: string;
  logs: string;
}) {
  const internalAuditText = unwrapShellOutput(args.internalAudit);
  const processLogText = unwrapShellOutput(args.processLog);
  const pidInfoText = unwrapShellOutput(args.pidInfo);
  const logsText = unwrapShellOutput(args.logs);
  const runtimeText = [processLogText, logsText].filter(Boolean).join("\n");
  const actualPortMatch = internalAuditText.match(/:(\d+)\b/);
  const actualPort = actualPortMatch ? actualPortMatch[1] : "";

  let summary = `部署验证失败：无法访问 ${args.healthCheckTarget}`;
  let diagnosis = `[部署验证失败] 无法访问 ${args.healthCheckTarget}（对外地址 ${args.publicUrl}）。`;

  if (/EADDRNOTAVAIL/i.test(runtimeText)) {
    summary = "服务启动崩溃：监听地址不可用（EADDRNOTAVAIL）";
    diagnosis += `\n[审计结果]: 服务进程在容器内启动失败，日志显示监听地址不可用（EADDRNOTAVAIL）。`;
  } else if (/EADDRINUSE/i.test(runtimeText)) {
    summary = "服务启动崩溃：监听端口已被占用（EADDRINUSE）";
    diagnosis += `\n[审计结果]: 服务进程在容器内启动失败，日志显示监听端口已被占用（EADDRINUSE）。`;
  } else if (internalAuditText.includes(String(args.targetInternalPort))) {
    summary = `容器内已监听目标端口 ${args.targetInternalPort}，但健康检查仍不可达`;
    diagnosis += `\n[审计结果]: 容器内部确实在监听端口 ${args.targetInternalPort}，但外部仍不可访问。可能是端口映射、宿主网络或健康检查路径问题。`;
  } else if (actualPort) {
    summary = `端口错配：预期监听 ${args.targetInternalPort}，实际监听 ${actualPort}`;
    diagnosis += `\n[审计结果]: 端口错配。系统预期监听 ${args.targetInternalPort}，但容器内实际似乎在监听 ${actualPort}。`;
  } else {
    summary = `服务未成功监听目标端口 ${args.targetInternalPort}`;
    diagnosis += `\n[审计结果]: 未发现容器内对目标端口 ${args.targetInternalPort} 的有效监听，服务大概率尚未成功启动。`;
  }

  const errorMsg = `${diagnosis}\n[错误信息]: ${args.lastError}\n[服务进程PID]:\n${args.pidInfo}\n[服务启动日志]:\n${args.processLog}\n[容器运行日志]:\n${args.logs}`;
  const evidence = [
    summary,
    `healthCheck=${args.healthCheckTarget}`,
    args.lastError,
    internalAuditText,
    processLogText,
    pidInfoText,
    logsText,
  ].filter(Boolean);

  return { summary, diagnosis, errorMsg, evidence };
}

export function buildDeployLaunchCommand(
  runCmd: string,
  options: { port?: number; host?: string } = {}
) {
  const runtimeHost = options.host || "0.0.0.0";
  const runtimePrefix = [
    options.port ? `PORT=${options.port}` : "",
    runtimeHost ? `HOST=${runtimeHost}` : "",
  ].filter(Boolean).join(" ");
  const effectiveRunCmd = runtimePrefix ? `${runtimePrefix} ${runCmd}` : runCmd;
  const escapedRunCmd = effectiveRunCmd.replace(/"/g, '\\"');
  return [
    "mkdir -p /tmp/jimclaw",
    "if [ -f /tmp/jimclaw/server.pid ]; then kill $(cat /tmp/jimclaw/server.pid) 2>/dev/null || true; fi",
    ": > /tmp/jimclaw/server.log",
    `nohup sh -c "${escapedRunCmd}" >/tmp/jimclaw/server.log 2>&1 & echo $! >/tmp/jimclaw/server.pid`,
  ].join("; ");
}

/**
 * Deploy 节点：负责将应用程序部署到运行环境并验证连通性
 */
export async function deployNode(
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
  startSpan("deploy");
  emit("phase-change", "System", "deployment");
  const round = state.retryCount || 0;
  const executionBackend = state.executionBackend || "docker";
  const commandExecutor = deps?.commandExecutor || createDeployExecutor(state);
  const buildHeartbeatState = (stage: string) => ({
    ...state,
    executionBackend,
    blockedReason: stage,
    runtimeStateSnapshot: {
      version: "v1" as const,
      envReady: Boolean(state.envReady),
      hostDepsReady: Boolean(state.envReady),
      testRuntimeReady: Boolean(state.containerId || executionBackend === "host"),
      deployRuntimeReady: Boolean(state.containerId || executionBackend === "host"),
      executionBackend: executionBackend as "docker" | "host",
      containerId: state.containerId || undefined,
      hostPort: state.allocatedHostPort || undefined,
      containerPort: state.manifest?.services?.[0]?.port,
      deploymentUrl: state.deploymentStatus?.url,
      startupLogPath: state.hostRuntimeLogPath || undefined,
      runtimePid: state.hostRuntimePid || undefined,
      tokenUsage: state.runtimeStateSnapshot?.tokenUsage,
    },
  });
  
  // 1. 获取宿主机真实 IP 和端口映射
  const ip = await GetServerIPSkill.config.run({});
  const targetInternalPort = state.manifest?.services?.[0]?.port || 8080;
  
  // 核心：优先使用基础设施节点分配好的宿主机端口，这是唯一真理来源
  let hostPort = state.allocatedHostPort ? String(state.allocatedHostPort) : "";

  if (!hostPort && state.containerId) {
    const portOut = await ShellExecuteSkill.config.run({ 
      command: `docker port ${state.containerId} ${targetInternalPort}/tcp || docker port ${state.containerId} ${targetInternalPort} || echo ""` 
    });
    
    const portMatch = portOut.match(/:(\d+)\s*$/m);
    if (portMatch) {
      hostPort = portMatch[1];
    }
  }

  // 最终校验
  if (!hostPort || parseInt(hostPort) > 65535 || parseInt(hostPort) === 0) {
    console.warn(`[System] 无法获取有效宿主机端口，回退到内部端口: ${targetInternalPort}`);
    hostPort = String(targetInternalPort);
  }
  
  const { publicUrl, healthCheckUrl } = buildDeploymentUrls(ip, hostPort);
  const healthCheckPath = getHealthCheckPath(state);
  let healthCheckTarget = `${healthCheckUrl}${healthCheckPath === "/" ? "" : healthCheckPath}`;
  const healthCheckCandidates = getHealthCheckCandidatePaths(state).map((candidatePath) => ({
    path: candidatePath,
    target: `${healthCheckUrl}${candidatePath === "/" ? "" : candidatePath}`,
  }));
  const runCmd = state.spec?.runCommand || "npm start";
  const preconditionFailure = getDeployPreconditionFailure(state);

  if (preconditionFailure) {
    const errorMsg = `[部署前置校验失败] ${preconditionFailure}`;
    await AuditLogger.log(WORKSPACE, "Infrastructure", `**Result:** Deployment Skipped\n${errorMsg}`);
    const note = await writeMeetingNote(
      WORKSPACE,
      `note-deploy-r${round}`,
      "deploy",
      round,
      `Deploy 第${round}轮：前置校验失败`,
      `# Deploy 第${round}轮\n\n## 部署结论\n- 状态：跳过\n- URL：${publicUrl}\n- 健康检查：${healthCheckTarget}\n- 宿主机端口：${hostPort}\n- 容器端口：${targetInternalPort}\n- 命令：${runCmd}\n\n## 错误详情\n\`\`\`text\n${errorMsg}\n\`\`\`\n`
    );
    const result = {
      executionBackend,
      deploymentStatus: { url: publicUrl, status: "failed" as const },
      testResults: `${state.testResults || ""}\n${errorMsg}`.trim(),
      isDone: false,
      meetingNotes: [note],
      lastFailedNode: "deploy",
      lastFailureSummary: errorMsg,
    };
    await saveBoulder({ ...state, ...result }, "deploy");
    return result;
  }
  
  await AuditLogger.log(
    WORKSPACE,
    "Infrastructure",
    `### [Deployment Start]\n**Backend:** ${executionBackend}\n**Public URL:** ${publicUrl}\n**Health Check URL:** ${healthCheckTarget}\n**Command:** ${runCmd}`
  );

  // 2. 启动服务
  const launchCommand = executionBackend === "host"
    ? buildHostDeployLaunchCommand(WORKSPACE, runCmd, parseInt(hostPort, 10))
    : buildDeployLaunchCommand(runCmd, { port: targetInternalPort, host: "0.0.0.0" });
  try {
    let launchResult: ExecutorResult = {
      ok: false,
      backend: executionBackend === "host" ? "local_shell" : "docker",
      stdout: "",
      stderr: "",
      retryable: false,
      requiresApproval: false,
      blocked: false,
    };
    await saveBoulder(buildHeartbeatState("deploy_launching_runtime"), "deploy_stage_launching");
    for (let attempt = 0; attempt < 2; attempt++) {
      launchResult = await runWithHeartbeat({
        run: async () =>
          commandExecutor.executeIntent({
            kind: "start_runtime",
            workspace: WORKSPACE,
            command: launchCommand,
            background: true,
            port: executionBackend === "host" ? parseInt(hostPort, 10) : targetInternalPort,
            host: "0.0.0.0",
          }),
        onHeartbeat: async () => {
          await saveBoulder(buildHeartbeatState("deploy_launching_runtime"), "deploy_heartbeat_launching");
        },
      });

      if (launchResult.requiresApproval) {
        break;
      }

      if (attempt === 0 && (launchResult.retryable || isRetryableDeployLaunchFailure(launchResult.stderr || launchResult.stdout))) {
        await AuditLogger.log(
          WORKSPACE,
          "Infrastructure",
          `**Retry:** 服务启动命令遇到瞬时执行错误，正在重试一次\n${launchResult.stderr || launchResult.stdout}`
        );
        continue;
      }
      break;
    }

    if (launchResult.requiresApproval) {
      const approvalReason = launchResult.blockedReason || "approval required for start_runtime";
      const note = await writeMeetingNote(
        WORKSPACE,
        `note-deploy-r${round}`,
        "deploy",
        round,
        `Deploy 第${round}轮：等待运行时启动授权`,
        `# Deploy 第${round}轮\n\n## 部署结论\n- 状态：等待授权\n- URL：${publicUrl}\n- 健康检查：${healthCheckTarget}\n- 原因：${approvalReason}\n`
      );
      const result = {
        executionBackend,
        deploymentStatus: { url: publicUrl, status: "failed" as const },
        testResults: `${state.testResults || ""}\n${approvalReason}`.trim(),
        isDone: false,
        meetingNotes: [note],
        blockedReason: approvalReason,
        agentRecoveryPending: true,
        agentRecoveryNode: "deploy",
        agentRecoveryReason: approvalReason,
        pendingApprovalTicketId: launchResult.approvalTicketId || "",
        executorState: buildDeployExecutorState(state, launchResult),
        lastFailedNode: "deploy",
        lastFailureSummary: approvalReason,
      };
      await saveBoulder({ ...state, ...result }, "deploy");
      return result;
    }

    if (!launchResult.ok || launchResult.blocked) {
      const summary = `[部署启动失败] ${launchResult.blockedReason || launchResult.stderr || launchResult.stdout || "start_runtime failed"}`;
      const executorFailureArtifacts = buildDeployExecutorFailure(state, launchResult, summary);
      const note = await writeMeetingNote(
        WORKSPACE,
        `note-deploy-r${round}`,
        "deploy",
        round,
        `Deploy 第${round}轮：启动失败`,
        `# Deploy 第${round}轮\n\n## 部署结论\n- 状态：失败\n- URL：${publicUrl}\n- 健康检查：${healthCheckTarget}\n- 原因：${summary}\n`
      );
      const result = {
        executionBackend,
        deploymentStatus: { url: publicUrl, status: "failed" as const },
        testResults: `${state.testResults || ""}\n${summary}`.trim(),
        isDone: false,
        ...executorFailureArtifacts,
        meetingNotes: [note],
        executorState: buildDeployExecutorState(state, launchResult),
        lastFailedNode: "deploy",
        lastFailureSummary: summary,
      };
      await saveBoulder({ ...state, ...result }, "deploy");
      return result;
    }

    if (executionBackend === "host") {
      const parsedLaunch = parseHostLaunchResult(`Output:\n${launchResult.stdout}\nErrors:\n${launchResult.stderr || ""}`);
      if (parsedLaunch.pid <= 0) {
        const evidence = [parsedLaunch.text, parsedLaunch.errors].filter(Boolean).join("\n");
        throw new Error(`服务启动失败：未获得有效进程 PID${evidence ? `\n${evidence}` : ""}`);
      }
      const pid = parsedLaunch.pid;
      const hostArtifacts = getHostRuntimeArtifactPaths(WORKSPACE);
      await fs.mkdir(hostArtifacts.runtimeDir, { recursive: true });
      if (pid > 0) {
        await fs.writeFile(hostArtifacts.pidPath, String(pid), "utf-8");
      }
    }
  } catch (error: any) {
    const errorMsg = `[部署启动失败] ${error.message || error}`;
    const runtimeArtifacts = buildDeployRuntimeFailureArtifacts(
      state,
      "部署启动失败：容器内服务进程未成功拉起",
      [String(error.message || error)]
    );
    await AuditLogger.log(WORKSPACE, "Infrastructure", `**Result:** Deployment Launch Failed\n${errorMsg}`);
    const note = await writeMeetingNote(
      WORKSPACE,
      `note-deploy-r${round}`,
      "deploy",
      round,
      `Deploy 第${round}轮：启动失败`,
      `# Deploy 第${round}轮\n\n## 部署结论\n- 状态：失败\n- URL：${publicUrl}\n- 健康检查：${healthCheckTarget}\n- 宿主机端口：${hostPort}\n- 容器端口：${targetInternalPort}\n- 命令：${runCmd}\n\n## 错误详情\n\`\`\`text\n${errorMsg}\n\`\`\`\n`
    );
    const result = {
      executionBackend,
      deploymentStatus: { url: publicUrl, status: "failed" as const },
      testResults: `${state.testResults || ""}\n${errorMsg}`.trim(),
      isDone: false,
      ...runtimeArtifacts,
      meetingNotes: [note],
      lastFailedNode: "deploy",
      lastFailureSummary: errorMsg,
    };
    await saveBoulder({ ...state, ...result }, "deploy");
    return result;
  }

  // 3. 核心改进：真实连通性校验 (Health Check)
  emit("thinking", "System", `正在验证服务连通性: ${healthCheckTarget} ...`);
  let isAccessible = false;
  let lastError = "";
  await saveBoulder(buildHeartbeatState("deploy_healthcheck_loop"), "deploy_stage_healthcheck");

  for (let i = 0; i < 10; i++) { // 尝试 10 次，每次间隔 3s
    await saveBoulder(buildHeartbeatState(`deploy_healthcheck_attempt_${i + 1}`), "deploy_heartbeat_healthcheck");
    for (const candidate of healthCheckCandidates) {
      try {
        const curlOut = await ShellExecuteSkill.config.run({ 
          command: `curl -s -o /dev/null -w "%{http_code}" --max-time 2 ${candidate.target}`,
          timeout: 5000
        });
        const codeMatch = curlOut.match(/\b(200|201|204|301|302|404)\b/);
        if (codeMatch) {
          isAccessible = true;
          if (candidate.target !== healthCheckTarget) {
            await AuditLogger.log(
              WORKSPACE,
              "Infrastructure",
              `**Health Check Fallback:** 主检查路径不可达，改用 ${candidate.path} 成功通过`
            );
            healthCheckTarget = candidate.target;
          }
          break;
        }
        lastError = `HTTP Code: ${curlOut}`;
      } catch (e: any) {
        lastError = e.message || String(e);
      }
    }
    if (isAccessible) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  if (isAccessible) {
    // ── FP-008: Post-deploy 验证 — 不只检查 health check，验证所有公开端点 ──
    const verificationResults: string[] = [];
    let allEndpointsOk = true;

    // 1) 验证所有 API 端点（GET 请求）
    const apiEndpoints = (state.apiContract?.endpoints || []).filter(
      (ep: any) => String(ep.method || "").toUpperCase() === "GET"
    );
    for (const ep of apiEndpoints.slice(0, 10)) {
      const epPath = String(ep.path || "").replace(/:([^/]+)/g, "1"); // 替换路径参数
      try {
        // FP-0016: 避免 curl -o /dev/null 在 MSYS 下 exit 23，改用 -D- 获取状态行
        const epOut = await ShellExecuteSkill.config.run({
          command: `curl -s -D- -o /dev/null --max-time 3 http://127.0.0.1:${hostPort}${epPath} 2>/dev/null | head -1`,
          workDir: WORKSPACE,
          timeout: 8000,
        });
        const rawOut = String(epOut).replace(/[\s\S]*Output:\n?/, "").replace(/[\s\S]*Errors:\n?/, "").trim();
        const httpMatch = rawOut.match(/HTTP\/\S+\s+(\d+)/);
        const code = httpMatch ? httpMatch[1] : rawOut.split("\n").pop()?.trim() || "";
        const ok = /^[23]\d\d$/.test(code);
        verificationResults.push(`  ${epPath} → HTTP ${code} ${ok ? "✅" : "❌"}`);
        if (!ok) allEndpointsOk = false;
      } catch {
        verificationResults.push(`  ${epPath} → ERROR ❌`);
        allEndpointsOk = false;
      }
    }

    // 2) 混合项目：验证前端页面可访问
    const frontendSpec = (state.spec as any)?.frontend;
    let frontendAccessible = false;
    if (frontendSpec) {
      try {
        // 先检查 /index.html（SPA 入口），如果成功则前端可访问
        const feOut = await ShellExecuteSkill.config.run({
          command: `curl -s --max-time 3 http://127.0.0.1:${hostPort}/index.html`,
          workDir: WORKSPACE,
          timeout: 5000,
        });
        const html = String(feOut).replace(/[\s\S]*Output:\n?/, "").replace(/[\s\S]*Errors:\n?/, "");
        frontendAccessible = /<html|<div|<!doctype/i.test(html) && html.length > 100;
        verificationResults.push(`  /index.html (前端页面) → ${frontendAccessible ? "HTML ✅" : "非 HTML ❌ (" + html.slice(0, 60) + ")"}`);
        if (!frontendAccessible) allEndpointsOk = false;
      } catch {
        verificationResults.push(`  / (前端页面) → ERROR ❌`);
        allEndpointsOk = false;
      }
    }

    // 输出验证报告
    if (verificationResults.length > 0) {
      const report = `部署后端点验证:\n${verificationResults.join("\n")}`;
      console.log(`[System] ${report}`);
      await AuditLogger.log(WORKSPACE, "Infrastructure", `**Post-deploy Verification:**\n${report}`);
    }

    // 前端不可达 → 报告失败（但不回退，只是记录，让 QA/下一轮能处理）
    const frontendWarning = (frontendSpec && !frontendAccessible)
      ? `⚠️ 前端页面 http://127.0.0.1:${hostPort}/index.html 不可访问（非 HTML 响应）。后端 API 已部署成功。`
      : "";

    const msg = allEndpointsOk
      ? `🚀 服务部署成功并已通过连通性校验！访问地址: ${publicUrl}`
      : `⚠️ 服务已部署，但部分端点验证失败。访问地址: ${publicUrl}\n${frontendWarning}`;
    console.log(`[System] ${msg}`);
    await AuditLogger.log(WORKSPACE, "Infrastructure", `**Result:** ${allEndpointsOk ? "Deployment Verified Success" : "Deployment Partial Success — " + verificationResults.filter(r => r.includes("❌")).join("; ")}`);
    const note = await writeMeetingNote(
      WORKSPACE,
      `note-deploy-r${round}`,
      "deploy",
      round,
      allEndpointsOk
        ? `Deploy 第${round}轮：部署成功（所有端点验证通过）`
        : `Deploy 第${round}轮：部分端点验证失败`,
      `# Deploy 第${round}轮\n\n## 部署结论\n- 状态：${allEndpointsOk ? "成功" : "部分失败"}\n- URL：${publicUrl}\n- 健康检查：${healthCheckTarget}\n- 宿主机端口：${hostPort}\n- 容器端口：${targetInternalPort}\n- 命令：${runCmd}\n${verificationResults.length > 0 ? "\n## 端点验证\n" + verificationResults.join("\n") : ""}\n`
    );
    const result = {
      executionBackend,
      deploymentStatus: { url: publicUrl, status: "running" as const },
      // FP-008: 前端不可达时标记为未完成
      ...(frontendSpec ? { postDeployVerification: { frontendAccessible, frontendUrl: `http://127.0.0.1:${hostPort}/index.html` } } : {}),
      meetingNotes: [note],
      lastFailedNode: allEndpointsOk ? "" : (frontendAccessible ? "" : "deploy"),
      lastFailureSummary: allEndpointsOk ? "" : frontendWarning,
    };
    await saveBoulder({ ...state, ...result }, "deploy");
    return result;
  } else {
    // 【终极审计逻辑】：如果不通，深挖容器内部监听状态
    let internalAudit = "";
    let processLog = "";
    let pidInfo = "";
    let logs = "";

    if (executionBackend === "host") {
      const hostArtifacts = getHostRuntimeArtifactPaths(WORKSPACE);
      internalAudit = await ShellExecuteSkill.config.run({
        command: process.platform === "win32"
          ? `powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess | Format-Table -AutoSize"`
          : `sh -c "ss -tlnp || netstat -tlnp || lsof -i -P -n"`,
        workDir: WORKSPACE,
        timeout: 10000,
      }).catch((error: any) => String(error?.message || error || ""));
      const stdoutLog = await fs.readFile(hostArtifacts.stdoutLogPath, "utf-8").catch(() => "");
      const stderrLog = await fs.readFile(hostArtifacts.stderrLogPath, "utf-8").catch(() => "");
      processLog = [stdoutLog, stderrLog].filter(Boolean).join("\n");
      if (!processLog) {
        processLog = await fs.readFile(hostArtifacts.logPath, "utf-8").catch(() => "");
      }
      pidInfo = await fs.readFile(hostArtifacts.pidPath, "utf-8").catch(() => "");
      logs = processLog;
    } else {
      internalAudit = await ShellExecuteSkill.config.run({ 
        command: `docker exec ${state.containerId} sh -c "netstat -tlnp || ss -tlnp || lsof -i -P -n" 2>/dev/null || echo "无法获取容器内监听状态"` 
      });
      
      processLog = await ShellExecuteSkill.config.run({
        command: `docker exec ${state.containerId} sh -c "cat /tmp/jimclaw/server.log 2>/dev/null || true"`,
      });
      pidInfo = await ShellExecuteSkill.config.run({
        command: `docker exec ${state.containerId} sh -c "cat /tmp/jimclaw/server.pid 2>/dev/null || true"`,
      });
      logs = await ShellExecuteSkill.config.run({ command: `docker logs ${state.containerId} --tail 200` });
    }
    
    const classifiedFailure = classifyDeploymentVerificationFailure({
      state,
      targetInternalPort,
      publicUrl,
      healthCheckTarget,
      lastError,
      internalAudit,
      processLog,
      pidInfo,
      logs,
    });
    const runtimeArtifacts = buildDeployRuntimeFailureArtifacts(
      state,
      classifiedFailure.summary,
      classifiedFailure.evidence
    );
    const errorMsg = classifiedFailure.errorMsg;
    console.error(`[System] ${errorMsg}`);
    await AuditLogger.log(WORKSPACE, "Infrastructure", `**Result:** Deployment Failed Verification\n${errorMsg}`);

    const note = await writeMeetingNote(
      WORKSPACE,
      `note-deploy-r${round}`,
      "deploy",
      round,
      `Deploy 第${round}轮：部署验证失败`,
      `# Deploy 第${round}轮\n\n## 部署结论\n- 状态：失败\n- URL：${publicUrl}\n- 健康检查：${healthCheckTarget}\n- 宿主机端口：${hostPort}\n- 容器端口：${targetInternalPort}\n- 命令：${runCmd}\n\n## 错误详情\n\`\`\`text\n${errorMsg}\n\`\`\`\n`
    );
    const result = {
      executionBackend,
      deploymentStatus: { url: publicUrl, status: "failed" as const },
      testResults: (state.testResults || "") + "\n" + errorMsg,
      isDone: false,
      ...runtimeArtifacts,
      meetingNotes: [note],
      lastFailedNode: "deploy",
      lastFailureSummary: classifiedFailure.summary,
    };
    await saveBoulder({ ...state, ...result }, "deploy");
    return result;
  }
}
