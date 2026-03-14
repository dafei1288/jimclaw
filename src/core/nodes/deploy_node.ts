import { JimClawState } from "../graph_types";
import { execInContainer } from "../logic_utils";
import { GetServerIPSkill } from "../../skills/get_server_ip";
import { ShellExecuteSkill } from "../../skills/shell_exec";
import { AuditLogger } from "../../utils/audit";

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
  
  const dynamicUrl = `http://${ip}:${hostPort}`;
  const runCmd = state.spec?.runCommand || "npm start";
  
  await AuditLogger.log(WORKSPACE, "Infrastructure", `### [Deployment Start]\n**URL:** ${dynamicUrl}\n**Command:** ${runCmd}`);

  // 2. 启动服务
  await execInContainer(state.containerId, runCmd, { background: true });

  // 3. 核心改进：真实连通性校验 (Health Check)
  emit("thinking", "System", `正在验证服务连通性: ${dynamicUrl} ...`);
  let isAccessible = false;
  let lastError = "";

  for (let i = 0; i < 10; i++) { // 尝试 10 次，每次间隔 3s
    try {
      // 在宿主机执行 curl 探测
      const curlOut = await ShellExecuteSkill.config.run({ 
        command: `curl -s -o /dev/null -w "%{http_code}" --max-time 2 ${dynamicUrl}`,
        timeout: 5000
      });
      if (curlOut.trim() === "200" || curlOut.trim() === "301" || curlOut.trim() === "302" || curlOut.trim() === "404") {
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
    const msg = `🚀 服务部署成功并已通过连通性校验！访问地址: ${dynamicUrl}`;
    console.log(`[System] ${msg}`);
    await AuditLogger.log(WORKSPACE, "Infrastructure", `**Result:** Deployment Verified Success`);
    return { deploymentStatus: { url: dynamicUrl, status: "running" as const } };
  } else {
    // 【终极审计逻辑】：如果不通，深挖容器内部监听状态
    const internalAudit = await ShellExecuteSkill.config.run({ 
      command: `docker exec ${state.containerId} sh -c "netstat -tlnp || ss -tlnp || lsof -i -P -n" 2>/dev/null || echo "无法获取容器内监听状态"` 
    });
    
    // 抓取容器日志
    const logs = await ShellExecuteSkill.config.run({ command: `docker logs ${state.containerId} --tail 50` });
    
    let diagnosis = `[部署验证失败] 无法访问 ${dynamicUrl}。`;
    if (internalAudit.includes(String(targetInternalPort))) {
      diagnosis += `\n[审计结果]: 容器内部确实在监听端口 ${targetInternalPort}，但外部无法访问。可能是宿主机防火墙、Docker 映射延迟或网络隔离问题。`;
    } else {
      const actualPortMatch = internalAudit.match(/:(\d+)\s/);
      const actualPort = actualPortMatch ? actualPortMatch[1] : "未知";
      diagnosis += `\n[审计结果]: 端口错配！系统预期监听 ${targetInternalPort}，但容器内实际似乎在监听 ${actualPort}。`;
      diagnosis += `\n[决策建议]: Coder 必须检查源码中的 listen() 调用，确保其严格使用了端口 ${targetInternalPort}。`;
    }

    const errorMsg = `${diagnosis}\n[错误信息]: ${lastError}\n[容器运行日志]:\n${logs}`;
    console.error(`[System] ${errorMsg}`);
    await AuditLogger.log(WORKSPACE, "Infrastructure", `**Result:** Deployment Failed Verification\n${errorMsg}`);
    
    return { 
      deploymentStatus: { url: dynamicUrl, status: "failed" as const },
      testResults: (state.testResults || "") + "\n" + errorMsg,
      isDone: false
    };
  }
}
