import { JimClawState } from "../graph_types";
import { execInContainer, writeMeetingNote } from "../logic_utils";
import { GetServerIPSkill } from "../../skills/get_server_ip";
import { ShellExecuteSkill } from "../../skills/shell_exec";
import { AuditLogger } from "../../utils/audit";

function isRetryableDeployLaunchFailure(output: string): boolean {
  return /OCI runtime exec failed|container .* is not running|No such container/i.test(String(output || ""));
}

function isCommandFailureOutput(output: string): boolean {
  return /^Command failed with exit code\s+\d+/i.test(String(output || "").trim());
}

async function launchServiceWithRetry(
  workspace: string,
  containerId: string,
  launchCommand: string
): Promise<string> {
  let lastOutput = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      lastOutput = await execInContainer(containerId, launchCommand, { background: true });
    } catch (error: any) {
      lastOutput = String(error?.message || error || "");
    }

    if (attempt === 0 && isRetryableDeployLaunchFailure(lastOutput)) {
      await AuditLogger.log(
        workspace,
        "Infrastructure",
        `**Retry:** 服务启动命令遇到瞬时容器执行错误，正在重试一次\n${lastOutput}`
      );
      continue;
    }

    if (isCommandFailureOutput(lastOutput)) {
      throw new Error(`服务启动失败：${lastOutput}`);
    }

    return lastOutput;
  }

  throw new Error(`服务启动失败：${lastOutput}`);
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

export function getDeployPreconditionFailure(state: JimClawState): string | null {
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

export function buildDeployLaunchCommand(runCmd: string) {
  const escapedRunCmd = runCmd.replace(/"/g, '\\"');
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
  saveBoulder: any
) {
  startSpan("deploy");
  emit("phase-change", "System", "deployment");
  const round = state.retryCount || 0;
  
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
  const healthCheckTarget = `${healthCheckUrl}${healthCheckPath === "/" ? "" : healthCheckPath}`;
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
    `### [Deployment Start]\n**Public URL:** ${publicUrl}\n**Health Check URL:** ${healthCheckTarget}\n**Command:** ${runCmd}`
  );

  // 2. 启动服务
  const launchCommand = buildDeployLaunchCommand(runCmd);
  try {
    await launchServiceWithRetry(WORKSPACE, state.containerId, launchCommand);
  } catch (error: any) {
    const errorMsg = `[部署启动失败] ${error.message || error}`;
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

  // 3. 核心改进：真实连通性校验 (Health Check)
  emit("thinking", "System", `正在验证服务连通性: ${healthCheckTarget} ...`);
  let isAccessible = false;
  let lastError = "";

  for (let i = 0; i < 10; i++) { // 尝试 10 次，每次间隔 3s
    try {
      // 在宿主机执行 curl 探测
      const curlOut = await ShellExecuteSkill.config.run({ 
        command: `curl -s -o /dev/null -w "%{http_code}" --max-time 2 ${healthCheckTarget}`,
        timeout: 5000
      });
      const codeMatch = curlOut.match(/\b(200|201|204|301|302|404)\b/);
      if (codeMatch) {
        isAccessible = true;
        break;
      }
      lastError = `HTTP Code: ${curlOut}`;
    } catch (e: any) {
      lastError = e.message || String(e);
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  if (isAccessible) {
    const msg = `🚀 服务部署成功并已通过连通性校验！访问地址: ${publicUrl}`;
    console.log(`[System] ${msg}`);
    await AuditLogger.log(WORKSPACE, "Infrastructure", `**Result:** Deployment Verified Success`);
    const note = await writeMeetingNote(
      WORKSPACE,
      `note-deploy-r${round}`,
      "deploy",
      round,
      `Deploy 第${round}轮：部署成功`,
      `# Deploy 第${round}轮\n\n## 部署结论\n- 状态：成功\n- URL：${publicUrl}\n- 健康检查：${healthCheckTarget}\n- 宿主机端口：${hostPort}\n- 容器端口：${targetInternalPort}\n- 命令：${runCmd}\n`
    );
    const result = {
      deploymentStatus: { url: publicUrl, status: "running" as const },
      meetingNotes: [note],
      lastFailedNode: "",
      lastFailureSummary: "",
    };
    await saveBoulder({ ...state, ...result }, "deploy");
    return result;
  } else {
    // 【终极审计逻辑】：如果不通，深挖容器内部监听状态
    const internalAudit = await ShellExecuteSkill.config.run({ 
      command: `docker exec ${state.containerId} sh -c "netstat -tlnp || ss -tlnp || lsof -i -P -n" 2>/dev/null || echo "无法获取容器内监听状态"` 
    });
    
    const processLog = await ShellExecuteSkill.config.run({
      command: `docker exec ${state.containerId} sh -c "cat /tmp/jimclaw/server.log 2>/dev/null || true"`,
    });
    const pidInfo = await ShellExecuteSkill.config.run({
      command: `docker exec ${state.containerId} sh -c "cat /tmp/jimclaw/server.pid 2>/dev/null || true"`,
    });
    const logs = await ShellExecuteSkill.config.run({ command: `docker logs ${state.containerId} --tail 200` });
    
    let diagnosis = `[部署验证失败] 无法访问 ${healthCheckTarget}（对外地址 ${publicUrl}）。`;
    if (internalAudit.includes(String(targetInternalPort))) {
      diagnosis += `\n[审计结果]: 容器内部确实在监听端口 ${targetInternalPort}，但外部无法访问。可能是宿主机防火墙、Docker 映射延迟或网络隔离问题。`;
    } else {
      const actualPortMatch = internalAudit.match(/:(\d+)\s/);
      const actualPort = actualPortMatch ? actualPortMatch[1] : "未知";
      diagnosis += `\n[审计结果]: 端口错配！系统预期监听 ${targetInternalPort}，但容器内实际似乎在监听 ${actualPort}。`;
      diagnosis += `\n[决策建议]: Coder 必须检查源码中的 listen() 调用，确保其严格使用了端口 ${targetInternalPort}。`;
    }

    const errorMsg = `${diagnosis}\n[错误信息]: ${lastError}\n[服务进程PID]:\n${pidInfo}\n[服务启动日志]:\n${processLog}\n[容器运行日志]:\n${logs}`;
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
      deploymentStatus: { url: publicUrl, status: "failed" as const },
      testResults: (state.testResults || "") + "\n" + errorMsg,
      isDone: false,
      meetingNotes: [note],
      lastFailedNode: "deploy",
      lastFailureSummary: diagnosis,
    };
    await saveBoulder({ ...state, ...result }, "deploy");
    return result;
  }
}
