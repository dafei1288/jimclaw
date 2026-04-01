import * as fs from "fs/promises";
import * as path from "path";
import { JimClawState } from "../graph_types";
import { createCommandExecutor } from "../../executor/command_executor";
import { resolvePreferredBackend } from "../../executor/backend_resolver";
import { classifyExecutorFailure, mapExecutorFailureToValidationFailure } from "../../executor/result_classifier";
import { ExecutorResult } from "../../executor/types";
import { createLocalShellAdapter, ShellExecuteSkill } from "../../skills/shell_exec";
import { FindFreePortSkill } from "../../skills/find_free_port";
import { buildRepairPlan, buildValidationReport, execInContainer, writeMeetingNote } from "../logic_utils";
import { AuditLogger } from "../../utils/audit";

/**
 * 从 ShellExecuteSkill 返回值中提取纯 stdout 内容。
 * ShellExecuteSkill 固定将输出包装为 "Output:\n<stdout>\nErrors:\n<stderr>"，
 * 直接使用原始字符串会导致容器 ID 被解析成 "Output:"。
 */
function parseSkillOutput(raw: string): string {
  const match = raw.match(/^(?:Command failed[^\n]*\n)?Output:\n([\s\S]*?)(?:\nErrors:|$)/);
  return match ? match[1].trim() : raw.trim();
}

export function rewriteComposePortBindings(composeContent: string, hostPort: number, containerPort: number): string {
  const portRegex = /(\s+-\s*["']?)(\d+):(\d+)(["']?)/g;
  return composeContent.replace(portRegex, (_match, prefix, _host, _container, suffix) => {
    return `${prefix}${hostPort}:${containerPort}${suffix}`;
  });
}

export function extractComposePrimaryServiceName(composeContent: string): string | null {
  const lines = composeContent.split(/\r?\n/);
  let inServices = false;

  for (const line of lines) {
    if (!inServices) {
      if (/^\s*services:\s*$/.test(line)) {
        inServices = true;
      }
      continue;
    }

    if (/^\S/.test(line) && !/^\s/.test(line)) {
      break;
    }

    const match = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*$/);
    if (match) {
      return match[1];
    }
  }

  return null;
}

export function hasBuildScript(packageJsonContent: string): boolean {
  try {
    const parsed = JSON.parse(packageJsonContent);
    return Boolean(parsed?.scripts?.build);
  } catch {
    return false;
  }
}

function isDockerPortConflict(raw: string): boolean {
  return /port is already allocated|bind .* failed/i.test(raw);
}

function isRetryableDockerStartupFailure(raw: string): boolean {
  return /Conflict\. The container name|container name .* already in use|already in use by container/i.test(raw || "");
}

function isRetryableContainerExecFailure(raw: string): boolean {
  return /OCI runtime exec failed|container .* is not running|No such container/i.test(raw || "");
}

function isCommandFailureOutput(raw: string): boolean {
  return /^Command failed with (exit code\s+\d+|error:)/i.test(String(raw || "").trim());
}

function extractContainerId(raw: string): string {
  const candidates = [
    ...parseSkillOutput(raw).split(/\r?\n/),
    ...String(raw || "").split(/\r?\n/),
  ];
  for (const line of candidates) {
    const trimmed = line.trim();
    if (/^[a-f0-9]{12,64}$/i.test(trimmed)) {
      return trimmed;
    }
  }
  return "";
}

function isHostExecutionBackend(state: JimClawState): boolean {
  return state.executionBackend === "host";
}

function isDockerUnavailableOutput(raw: string): boolean {
  return /(spawn EPERM|spawn ENOENT|docker(\.exe)? .*not found|failed to connect to the docker api|docker desktop is not running|permission denied while trying to connect to the docker daemon|无法连接 Docker)/i.test(String(raw || ""));
}

function readRuntimeRepairEvidence(state: JimClawState): string {
  return [
    state.lastFailureSummary || "",
    ...(state.repairPlan?.expectedEvidence || []),
    ...(state.validationReport?.findings || []).flatMap((finding: any) => [
      finding?.summary || "",
      ...(finding?.evidence || []),
    ]),
  ].filter(Boolean).join("\n");
}

function shouldReuseAllocatedHostPort(state: JimClawState): boolean {
  return state.repairPlan?.repairType === "runtime" && Number(state.allocatedHostPort || 0) > 0;
}

function shouldCleanRuntimeProcess(state: JimClawState): boolean {
  return /EADDRINUSE/i.test(readRuntimeRepairEvidence(state));
}

function buildRuntimeCleanupCommand(): string {
  return [
    "if [ -f /tmp/jimclaw/server.pid ]; then kill $(cat /tmp/jimclaw/server.pid) 2>/dev/null || true; fi",
    "rm -f /tmp/jimclaw/server.pid",
    "pkill -f \"node|npm|tsx|ts-node\" 2>/dev/null || true",
  ].join("; ");
}

async function runInfraContainerCommand(
  workspace: string,
  containerId: string,
  command: string,
  label: string,
  timeout: number
): Promise<string> {
  let lastOutput = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      lastOutput = await execInContainer(containerId, command, { timeout });
    } catch (error: any) {
      lastOutput = String(error?.message || error || "");
    }

    if (attempt === 0 && isRetryableContainerExecFailure(lastOutput)) {
      await AuditLogger.log(
        workspace,
        "Infrastructure",
        `**Retry:** ${label} 遇到瞬时容器执行错误，正在重试一次\n${lastOutput}`
      );
      continue;
    }

    if (isCommandFailureOutput(lastOutput)) {
      throw new Error(`${label}失败：${parseSkillOutput(lastOutput) || lastOutput}`);
    }

    return lastOutput;
  }

  throw new Error(`${label}失败：${parseSkillOutput(lastOutput) || lastOutput}`);
}

async function runInfraHostCommand(
  workspace: string,
  command: string,
  label: string,
  timeout: number
): Promise<string> {
  const output = await ShellExecuteSkill.config.run({
    command,
    workDir: workspace,
    timeout,
  });
  if (isCommandFailureOutput(output)) {
    throw new Error(`${label}失败：${parseSkillOutput(output) || output}`);
  }
  return output;
}

function unwrapSkillOutput(raw: string): string {
  const text = String(raw || "");
  const match = text.match(/Output:\n([\s\S]*?)(?:\nErrors:|$)/);
  return (match ? match[1] : text).trim();
}

function extractSkillErrors(raw: string): string {
  const text = String(raw || "");
  const match = text.match(/\nErrors:\n([\s\S]*)$/);
  return (match ? match[1] : "").trim();
}

function createDockerCliAdapter() {
  return {
    async execute(intent: { command?: string; workspace: string }): Promise<ExecutorResult> {
      const raw = await ShellExecuteSkill.config.run({
        command: intent.command || "",
        workDir: intent.workspace,
        timeout: 300000,
      });
      const failed = /^Command failed/i.test(String(raw || "").trim());
      const failureType = failed
        ? classifyExecutorFailure({
            raw,
            stdout: unwrapSkillOutput(raw),
            stderr: extractSkillErrors(raw),
          })
        : undefined;
      return {
        ok: !failed,
        backend: "docker",
        stdout: unwrapSkillOutput(raw),
        stderr: extractSkillErrors(raw),
        retryable: false,
        requiresApproval: false,
        blocked: false,
        failureType,
      };
    },
  };
}

function createInfraExecutor(preferredBackend: "local_shell" | "docker") {
  return createCommandExecutor({
    resolveBackend: async (_intent, snapshot) => resolvePreferredBackend(preferredBackend, snapshot),
    adapters: {
      local_shell: createLocalShellAdapter(),
      docker: createDockerCliAdapter(),
    },
  });
}

function buildExecutorState(state: JimClawState, result: ExecutorResult): NonNullable<JimClawState["executorState"]> {
  const approvalTickets = [...(state.executorState?.approvalTickets || [])];
  if (result.requiresApproval && result.approvalTicketId && !approvalTickets.some((ticket) => ticket.id === result.approvalTicketId)) {
    approvalTickets.push({
      id: result.approvalTicketId,
      stage: "network_install",
      required: true,
      status: "pending",
      reason: result.blockedReason || "approval required for install_deps",
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

function buildInfraExecutorFailurePatch(
  state: JimClawState,
  result: ExecutorResult,
  summary: string
): Partial<JimClawState> {
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
    lastFailedNode: "infra_setup",
    lastFailureSummary: summary,
    executorState: buildExecutorState(state, result),
  };
}

/**
 * Infra 节点：负责构建运行和测试所需的基础设施
 */
export async function infraNode(
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
  startSpan("infra_setup");
  const round = state.retryCount || 0;
  const lang = state.spec?.language?.toLowerCase() ?? "javascript";
  const image = lang.includes("python") ? "python:3.11-slim" : "node:20-alpine";
  const containerName = `jimclaw_${path.basename(WORKSPACE)}`;
  const commandExecutor =
    deps?.commandExecutor ||
    createInfraExecutor(
      state.executorState?.selectedBackend === "external_executor"
        ? "local_shell"
        : (state.executionBackend === "host" ? "local_shell" : "docker")
    );
  
  // 1. 获取宿主机空闲端口
  let hostPort = 0;
  if (shouldReuseAllocatedHostPort(state)) {
    hostPort = Number(state.allocatedHostPort || 0);
    await AuditLogger.log(
      WORKSPACE,
      "Infrastructure",
      `**Runtime Recovery:** 复用上一轮宿主机端口 ${hostPort}，避免 runtime 修复阶段端口漂移`
    );
  } else {
    const hostPortOut = await FindFreePortSkill.config.run({ start_port: 4000, end_port: 5000 });
    hostPort = parseInt(hostPortOut.replace(/\D/g, ""), 10) || 4000;
  }
  
  // 强力审计：严禁占用系统保留端口 (如 3000)
  const SYSTEM_RESERVED_PORTS = [3000, 3001, 3306, 5432, 6379];
  if (SYSTEM_RESERVED_PORTS.includes(hostPort)) {
    console.warn(`[System] 检测到端口冲突: ${hostPort} 是系统保留端口，正在重新分配...`);
    hostPort += 1000; // 强制偏移到安全区域
  }
  const containerPort = state.manifest?.services?.[0]?.port || 8080;
  const executionBackend = state.executionBackend || "docker";

  await AuditLogger.log(WORKSPACE, "Infrastructure", `### [Infrastructure Setup]\n\n**Host Port Allocated:** ${hostPort}\n**Container Port Target:** ${containerPort}`);

  const finalizeHostBackend = async () => {
    let hasPackageJson = false;
    let packageJsonContent = "";
    try {
      packageJsonContent = await fs.readFile(path.join(WORKSPACE, "package.json"), "utf-8");
      hasPackageJson = true;
    } catch {}

    try {
      if (hasPackageJson) {
        await AuditLogger.log(WORKSPACE, "Infrastructure", `**Action:** Installing dependencies on host via executor`);
        const installResult = await commandExecutor.executeIntent({
          kind: "install_deps",
          workspace: WORKSPACE,
          command: "npm install --silent",
          requiresNetwork: true,
        });
        if (installResult.requiresApproval) {
          return {
            executionBackend: "host" as const,
            containerId: "",
            allocatedHostPort: hostPort,
            blockedReason: installResult.blockedReason || "approval required for install_deps",
            requiresApproval: true,
            agentRecoveryPending: true,
            agentRecoveryNode: "infra_setup",
            agentRecoveryReason: installResult.blockedReason || "approval required for install_deps",
            pendingApprovalTicketId: installResult.approvalTicketId || "",
            executorState: buildExecutorState(state, installResult),
            testResults: installResult.blockedReason || "approval required for install_deps",
            lastFailedNode: "infra_setup",
            lastFailureSummary: installResult.blockedReason || "approval required for install_deps",
          };
        }
        if (!installResult.ok || installResult.blocked) {
          const summary = `[基础设施异常] ${installResult.blockedReason || installResult.stderr || installResult.stdout || "install_deps failed"}`;
          return {
            executionBackend: "host" as const,
            containerId: "",
            allocatedHostPort: hostPort,
            testResults: summary,
            ...buildInfraExecutorFailurePatch(state, installResult, summary),
          };
        }
        await AuditLogger.log(WORKSPACE, "Infrastructure", `**Host Install Output:**\n${installResult.stdout}`);

        if (hasBuildScript(packageJsonContent)) {
          await AuditLogger.log(WORKSPACE, "Infrastructure", `**Action:** Building workspace on host via executor`);
          const buildResult = await commandExecutor.executeIntent({
            kind: "build_workspace",
            workspace: WORKSPACE,
            command: "npm run build",
          });
          if (!buildResult.ok || buildResult.blocked) {
            const summary = `[基础设施异常] ${buildResult.blockedReason || buildResult.stderr || buildResult.stdout || "build_workspace failed"}`;
            return {
              executionBackend: "host" as const,
              containerId: "",
              allocatedHostPort: hostPort,
              testResults: summary,
              ...buildInfraExecutorFailurePatch(state, buildResult, summary),
            };
          }
          await AuditLogger.log(WORKSPACE, "Infrastructure", `**Host Build Output:**\n${buildResult.stdout}`);
        }
      }
    } catch (e: any) {
      const errorMsg = `[基础设施异常] ${e.message || e}`;
      await AuditLogger.log(WORKSPACE, "Infrastructure", `**Critical Error:** ${errorMsg}`);
      const note = await writeMeetingNote(
        WORKSPACE,
        `note-infra_setup-r${round}`,
        "infra_setup",
        round,
        `Infra 第${round}轮：宿主机依赖安装失败`,
        `# Infra 第${round}轮\n\n## 基础设施结论\n- 状态：失败\n- 后端：host\n- 宿主机端口：${hostPort}\n\n## 错误详情\n\`\`\`text\n${errorMsg}\n\`\`\`\n`
      );
      return {
        executionBackend: "host" as const,
        containerId: "",
        testResults: errorMsg,
        retryCount: (state.retryCount || 0) + 1,
        allocatedHostPort: hostPort,
        meetingNotes: [note],
        lastFailedNode: "infra_setup",
        lastFailureSummary: errorMsg.slice(0, 120),
      };
    }

    const note = await writeMeetingNote(
      WORKSPACE,
      `note-infra_setup-r${round}`,
      "infra_setup",
      round,
      `Infra 第${round}轮：宿主机环境与依赖已就绪`,
      `# Infra 第${round}轮\n\n## 基础设施结论\n- 状态：成功\n- 后端：host\n- 宿主机端口：${hostPort}\n- 运行目录：${WORKSPACE}\n`
    );

    return {
      executionBackend: "host" as const,
      containerId: "",
      allocatedHostPort: hostPort,
      meetingNotes: [note],
      testResults: "",
      blockedReason: "",
      protocolFailures: [],
      executorState: state.executorState,
      lastFailedNode: "",
      lastFailureSummary: "",
    };
  };

  if (isHostExecutionBackend(state)) {
    await AuditLogger.log(WORKSPACE, "Infrastructure", `**Backend:** host`);
    return finalizeHostBackend();
  }

  // 2. 检查是否有 docker-compose.yml
  const composePath = path.join(WORKSPACE, "docker-compose.yml");
  let hasCompose = false;
  try {
    await fs.access(composePath);
    hasCompose = true;
  } catch {}

  let containerId = "";

  if (hasCompose) {
    await AuditLogger.log(WORKSPACE, "Infrastructure", `**Action:** Using Docker Compose`);
    
    // 关键修正：确保 docker-compose.yml 的宿主机/容器端口映射与运行时口径一致
    let composeContent = "";
    let serviceName = "";
    try {
      composeContent = await fs.readFile(composePath, "utf-8");
      const updatedCompose = rewriteComposePortBindings(composeContent, hostPort, containerPort);
      if (updatedCompose !== composeContent) {
        await fs.writeFile(composePath, updatedCompose);
        await AuditLogger.log(WORKSPACE, "Infrastructure", `**Hotfix:** Corrected docker-compose port mapping to ${hostPort}:${containerPort}`);
        composeContent = updatedCompose;
      }
      serviceName = extractComposePrimaryServiceName(composeContent) || "";
    } catch (err) {}

    if (!serviceName) {
      const errMsg = `[基础设施构建失败] 无法从 docker-compose.yml 解析服务名，无法启动测试容器。`;
      const note = await writeMeetingNote(
        WORKSPACE,
        `note-infra_setup-r${round}`,
        "infra_setup",
        round,
        `Infra 第${round}轮：docker-compose 服务名解析失败`,
        `# Infra 第${round}轮\n\n## 基础设施结论\n- 状态：失败\n- 宿主机端口：${hostPort}\n- 容器端口：${containerPort}\n\n## 错误详情\n\`\`\`text\n${errMsg}\n\`\`\`\n`
      );
      return { containerId: "", testResults: errMsg, allocatedHostPort: hostPort, meetingNotes: [note], lastFailedNode: "infra_setup", lastFailureSummary: errMsg.slice(0, 120) };
    }

    await ShellExecuteSkill.config.run({ command: `cd ${WORKSPACE} && docker-compose down 2>/dev/null || true` });
    await ShellExecuteSkill.config.run({
      command: `for /f %i in ('docker ps -aq --filter "status=exited" --filter "name=run_" --filter "name=-${serviceName}-run-"') do @docker rm -f %i`,
      timeout: 30000,
    }).catch(() => {});
    await ShellExecuteSkill.config.run({ command: `cd ${WORKSPACE} && docker-compose rm -f -s -v 2>nul || exit /b 0` }).catch(() => {});
    const composeOut = await ShellExecuteSkill.config.run({ command: `cd ${WORKSPACE} && docker-compose build ${serviceName}` });
    await AuditLogger.log(WORKSPACE, "Infrastructure", `**Compose Output:**\n${composeOut}`);

    // 构建失败（exit code != 0）立即返回，错误写入 testResults 供 QA 分析
    if (composeOut.includes("Command failed") || composeOut.includes("failed to solve") || composeOut.includes("dockerfile parse error") || composeOut.includes("ERROR:")) {
      if (isDockerUnavailableOutput(composeOut)) {
        await AuditLogger.log(WORKSPACE, "Infrastructure", `**Fallback:** Docker Compose 不可用，切换到 host backend`);
        return finalizeHostBackend();
      }
      const errMsg = `[基础设施构建失败] docker-compose 构建错误，请检查 Dockerfile 和 docker-compose.yml：\n${parseSkillOutput(composeOut)}`;
      await AuditLogger.log(WORKSPACE, "Infrastructure", `**Build Failed:** ${errMsg}`);
      console.error(`[System] ${errMsg}`);
      const note = await writeMeetingNote(
        WORKSPACE,
        `note-infra_setup-r${round}`,
        "infra_setup",
        round,
        `Infra 第${round}轮：docker-compose 构建失败`,
        `# Infra 第${round}轮\n\n## 基础设施结论\n- 状态：失败\n- 宿主机端口：${hostPort}\n- 容器端口：${containerPort}\n\n## 错误详情\n\`\`\`text\n${errMsg}\n\`\`\`\n`
      );
      return { containerId: "", testResults: errMsg, allocatedHostPort: hostPort, meetingNotes: [note], lastFailedNode: "infra_setup", lastFailureSummary: errMsg.slice(0, 120) };
    }

    await AuditLogger.log(
      WORKSPACE,
      "Infrastructure",
      `**Action:** Starting compose test container for service ${serviceName} with idle command`
    );
    let runOut = "";
    containerId = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      runOut = await ShellExecuteSkill.config.run({
        command: `cd ${WORKSPACE} && docker-compose run -d --service-ports ${serviceName} sh -c "tail -f /dev/null"`,
        timeout: 60000,
      });

      containerId = extractContainerId(runOut);
      if (containerId) {
        break;
      }

      if (isRetryableDockerStartupFailure(runOut)) {
        await AuditLogger.log(
          WORKSPACE,
          "Infrastructure",
          `**Retry:** 检测到 compose 容器名冲突，重新拉起测试容器（第 ${attempt + 1} 次重试）`
        );
        continue;
      }

      if (!isDockerPortConflict(runOut)) {
        break;
      }

      hostPort += 1;
      const updatedCompose = rewriteComposePortBindings(composeContent, hostPort, containerPort);
      composeContent = updatedCompose;
      await fs.writeFile(composePath, updatedCompose);
      await AuditLogger.log(
        WORKSPACE,
        "Infrastructure",
        `**Retry:** 检测到宿主机端口冲突，改用 ${hostPort}:${containerPort} 后重试 compose run`
      );
    }

    if (isDockerPortConflict(runOut)) {
      const errMsg = `[基础设施构建失败] docker-compose run 遇到宿主机端口冲突，连续重试后仍无法绑定端口 ${hostPort}:${containerPort}。`;
      const note = await writeMeetingNote(
        WORKSPACE,
        `note-infra_setup-r${round}`,
        "infra_setup",
        round,
        `Infra 第${round}轮：compose 端口冲突`,
        `# Infra 第${round}轮\n\n## 基础设施结论\n- 状态：失败\n- 宿主机端口：${hostPort}\n- 容器端口：${containerPort}\n\n## 错误详情\n\`\`\`text\n${runOut}\n\`\`\`\n`
      );
      return { containerId: "", testResults: errMsg, allocatedHostPort: hostPort, meetingNotes: [note], lastFailedNode: "infra_setup", lastFailureSummary: errMsg.slice(0, 120) };
    }

    if (!containerId) {
      if (isDockerUnavailableOutput(runOut)) {
        await AuditLogger.log(WORKSPACE, "Infrastructure", `**Fallback:** Docker Compose 启动不可用，切换到 host backend`);
        return finalizeHostBackend();
      }
      console.warn(`[System] 无法直接获取 compose run 产生的容器 ID，尝试回退查询服务容器...`);
      const fallbackPs = await ShellExecuteSkill.config.run({ command: `cd ${WORKSPACE} && docker-compose ps -q ${serviceName}` });
      containerId = extractContainerId(fallbackPs);
    }

    if (!containerId) {
      const composeLog = await ShellExecuteSkill.config.run({ command: `cd ${WORKSPACE} && docker-compose logs --tail=30 2>&1` });
      const errMsg = `[基础设施致命错误] docker-compose 启动后未能找到运行中的容器（端口 ${hostPort}）。\n容器日志：\n${parseSkillOutput(composeLog)}`;
      await AuditLogger.log(WORKSPACE, "Infrastructure", `**Fatal:** ${errMsg}`);
      console.error(`[System] ${errMsg}`);
      const note = await writeMeetingNote(
        WORKSPACE,
        `note-infra_setup-r${round}`,
        "infra_setup",
        round,
        `Infra 第${round}轮：容器未成功启动`,
        `# Infra 第${round}轮\n\n## 基础设施结论\n- 状态：失败\n- 宿主机端口：${hostPort}\n- 容器端口：${containerPort}\n\n## 错误详情\n\`\`\`text\n${errMsg}\n\`\`\`\n`
      );
      return { containerId: "", testResults: errMsg, allocatedHostPort: hostPort, meetingNotes: [note], lastFailedNode: "infra_setup", lastFailureSummary: errMsg.slice(0, 120) };
    }
  } else {
    // 3. 安全清理并启动单容器 (带端口映射)
    await ShellExecuteSkill.config.run({ command: `docker rm -f ${containerName}` }).catch(() => {});
    let startOut = "";
    containerId = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      startOut = await ShellExecuteSkill.config.run({
        command: `docker run -d --name ${containerName} -p ${hostPort}:${containerPort} -v "${WORKSPACE}:/app" -w /app ${image} tail -f /dev/null`,
        timeout: 60000,
      });
      containerId = extractContainerId(startOut);
      if (containerId) {
        break;
      }
      if (!isDockerPortConflict(startOut)) {
        if (isRetryableDockerStartupFailure(startOut)) {
          await ShellExecuteSkill.config.run({ command: `docker rm -f ${containerName}` }).catch(() => {});
          await AuditLogger.log(
            WORKSPACE,
            "Infrastructure",
            `**Retry:** 检测到 docker run 容器名冲突，清理同名容器后重试（第 ${attempt + 1} 次重试）`
          );
          continue;
        }
        break;
      }
      hostPort += 1;
      await AuditLogger.log(
        WORKSPACE,
        "Infrastructure",
        `**Retry:** 检测到 docker run 宿主机端口冲突，改用 ${hostPort}:${containerPort} 后重试`
      );
    }
    if (isDockerPortConflict(startOut)) {
      const errMsg = `[基础设施构建失败] docker run 遇到宿主机端口冲突，连续重试后仍无法绑定端口 ${hostPort}:${containerPort}。`;
      const note = await writeMeetingNote(
        WORKSPACE,
        `note-infra_setup-r${round}`,
        "infra_setup",
        round,
        `Infra 第${round}轮：docker 端口冲突`,
        `# Infra 第${round}轮\n\n## 基础设施结论\n- 状态：失败\n- 宿主机端口：${hostPort}\n- 容器端口：${containerPort}\n\n## 错误详情\n\`\`\`text\n${startOut}\n\`\`\`\n`
      );
      return { containerId: "", testResults: errMsg, allocatedHostPort: hostPort, meetingNotes: [note], lastFailedNode: "infra_setup", lastFailureSummary: errMsg.slice(0, 120) };
    }
    if (!containerId) {
      if (isDockerUnavailableOutput(startOut)) {
        await AuditLogger.log(WORKSPACE, "Infrastructure", `**Fallback:** Docker 不可用，切换到 host backend`);
        return finalizeHostBackend();
      }
      const errMsg = `[基础设施致命错误] docker run 启动后未能获取有效容器 ID，请检查 Docker 输出：\n${parseSkillOutput(startOut) || startOut}`;
      const note = await writeMeetingNote(
        WORKSPACE,
        `note-infra_setup-r${round}`,
        "infra_setup",
        round,
        `Infra 第${round}轮：容器启动失败`,
        `# Infra 第${round}轮\n\n## 基础设施结论\n- 状态：失败\n- 宿主机端口：${hostPort}\n- 容器端口：${containerPort}\n\n## 错误详情\n\`\`\`text\n${errMsg}\n\`\`\`\n`
      );
      return { containerId: "", testResults: errMsg, allocatedHostPort: hostPort, meetingNotes: [note], lastFailedNode: "infra_setup", lastFailureSummary: errMsg.slice(0, 120) };
    }
  }

  let hasPackageJson = false;
  let packageJsonContent = "";
  try {
    packageJsonContent = await fs.readFile(path.join(WORKSPACE, "package.json"), "utf-8");
    hasPackageJson = true;
  } catch {}

  try {
    if (shouldCleanRuntimeProcess(state)) {
      await AuditLogger.log(
        WORKSPACE,
        "Infrastructure",
        `**Runtime Recovery:** 检测到 EADDRINUSE，先清理容器内残留服务进程`
      );
      await runInfraContainerCommand(
        WORKSPACE,
        containerId,
        buildRuntimeCleanupCommand(),
        "runtime cleanup",
        30000
      ).catch(async (error: any) => {
        await AuditLogger.log(
          WORKSPACE,
          "Infrastructure",
          `**Runtime Recovery Warning:** 清理残留进程失败，继续后续流程\n${String(error?.message || error || "")}`
        );
      });
    }

    if (hasPackageJson) {
      await AuditLogger.log(WORKSPACE, "Infrastructure", `**Action:** Installing dependencies (npm install)`);
      const installOut = hasCompose
        ? await runInfraContainerCommand(
            WORKSPACE,
            containerId,
            "NODE_ENV=development npm install --include=dev --silent",
            "npm install",
            300000
          )
        : await runInfraContainerCommand(WORKSPACE, containerId, "npm install --silent", "npm install", 300000);
      await AuditLogger.log(WORKSPACE, "Infrastructure", `**Install Output:**\n${installOut}`);

      if (hasBuildScript(packageJsonContent)) {
        await AuditLogger.log(WORKSPACE, "Infrastructure", `**Action:** Building workspace (npm run build)`);
        const buildOut = await runInfraContainerCommand(WORKSPACE, containerId, "npm run build", "npm run build", 300000);
        await AuditLogger.log(WORKSPACE, "Infrastructure", `**Build Output:**\n${buildOut}`);
      }
    }
  } catch (e: any) {
    const errorMsg = `[基础设施异常] ${e.message || e}`;
    await AuditLogger.log(WORKSPACE, "Infrastructure", `**Critical Error:** ${errorMsg}`);
    const note = await writeMeetingNote(
      WORKSPACE,
      `note-infra_setup-r${round}`,
      "infra_setup",
      round,
      `Infra 第${round}轮：依赖安装失败`,
      `# Infra 第${round}轮\n\n## 基础设施结论\n- 状态：失败\n- 宿主机端口：${hostPort}\n- 容器端口：${containerPort}\n- 容器：${containerId || "未获取"}\n\n## 错误详情\n\`\`\`text\n${errorMsg}\n\`\`\`\n`
    );
    return { containerId, testResults: errorMsg, retryCount: (state.retryCount || 0) + 1, allocatedHostPort: hostPort, meetingNotes: [note], lastFailedNode: "infra_setup", lastFailureSummary: errorMsg.slice(0, 120) };
  }

  const note = await writeMeetingNote(
    WORKSPACE,
    `note-infra_setup-r${round}`,
    "infra_setup",
    round,
    `Infra 第${round}轮：容器与依赖已就绪`,
    `# Infra 第${round}轮\n\n## 基础设施结论\n- 状态：成功\n- 宿主机端口：${hostPort}\n- 容器端口：${containerPort}\n- 容器：${containerId}\n- 镜像：${image}\n`
  );

  return {
    containerId,
    allocatedHostPort: hostPort,
    meetingNotes: [note],
    testResults: "",
    blockedReason: "",
    protocolFailures: [],
    lastFailedNode: "",
    lastFailureSummary: "",
  };
}
