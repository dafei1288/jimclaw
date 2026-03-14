import * as fs from "fs/promises";
import * as path from "path";
import { JimClawState } from "../graph_types";
import { ShellExecuteSkill } from "../../skills/shell_exec";
import { FindFreePortSkill } from "../../skills/find_free_port";
import { execInContainer } from "../logic_utils";
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

/**
 * Infra 节点：负责构建运行和测试所需的基础设施
 */
export async function infraNode(
  state: JimClawState,
  agents: any,
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("infra_setup");
  const lang = state.spec?.language?.toLowerCase() ?? "javascript";
  const image = lang.includes("python") ? "python:3.11-slim" : "node:20-alpine";
  const containerName = `jimclaw_${path.basename(WORKSPACE)}`;
  
  // 1. 获取宿主机空闲端口
  let hostPortOut = await FindFreePortSkill.config.run({ start_port: 4000, end_port: 5000 });
  let hostPort = parseInt(hostPortOut.replace(/\D/g, ""), 10) || 4000;
  
  // 强力审计：严禁占用系统保留端口 (如 3000)
  const SYSTEM_RESERVED_PORTS = [3000, 3001, 3306, 5432, 6379];
  if (SYSTEM_RESERVED_PORTS.includes(hostPort)) {
    console.warn(`[System] 检测到端口冲突: ${hostPort} 是系统保留端口，正在重新分配...`);
    hostPort += 1000; // 强制偏移到安全区域
  }
  const containerPort = state.manifest?.services?.[0]?.port || 8080;

  await AuditLogger.log(WORKSPACE, "Infrastructure", `### [Infrastructure Setup]\n\n**Host Port Allocated:** ${hostPort}\n**Container Port Target:** ${containerPort}`);

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
    
    // 关键修正：确保 docker-compose.yml 暴露的端口与 manifest 中锁定的端口一致
    try {
      let composeContent = await fs.readFile(composePath, "utf-8");
      const portRegex = /(\s+ports:\s+\n\s+- ["']?)(\d+):(\d+)(["']?)/g;
      const updatedCompose = composeContent.replace(portRegex, (match, p1, p2, p3, p4) => {
        // p2 是宿主机端口，p3 是容器内部端口
        // 强制 p3 为 containerPort
        return `${p1}${p2}:${containerPort}${p4}`;
      });
      if (updatedCompose !== composeContent) {
        await fs.writeFile(composePath, updatedCompose);
        await AuditLogger.log(WORKSPACE, "Infrastructure", `**Hotfix:** Corrected container port in docker-compose.yml to ${containerPort}`);
      }
    } catch (err) {}

    await ShellExecuteSkill.config.run({ command: `cd ${WORKSPACE} && docker-compose down 2>/dev/null || true` });
    const composeOut = await ShellExecuteSkill.config.run({ command: `cd ${WORKSPACE} && docker-compose up -d` });
    await AuditLogger.log(WORKSPACE, "Infrastructure", `**Compose Output:**\n${composeOut}`);

    // 构建失败（exit code != 0）立即返回，错误写入 testResults 供 QA 分析
    if (composeOut.includes("Command failed") || composeOut.includes("failed to solve") || composeOut.includes("dockerfile parse error") || composeOut.includes("ERROR:")) {
      const errMsg = `[基础设施构建失败] docker-compose 构建错误，请检查 Dockerfile 和 docker-compose.yml：\n${parseSkillOutput(composeOut)}`;
      await AuditLogger.log(WORKSPACE, "Infrastructure", `**Build Failed:** ${errMsg}`);
      console.error(`[System] ${errMsg}`);
      return { containerId: "", testResults: errMsg, allocatedHostPort: hostPort };
    }
    
    // 核心修正：对于 Compose，我们不能盲目使用预设名字。
    // 因为应用容器必定绑定了我们分配的 hostPort，所以通过 publish 过滤器精准捕获容器 ID
    await new Promise(r => setTimeout(r, 2000)); // 等待容器就绪
    const psOut = await ShellExecuteSkill.config.run({ command: `docker ps -q --filter "publish=${hostPort}"` });
    // ShellExecuteSkill 返回格式为 "Output:\n<内容>" — 必须跳过该前缀行提取真实 ID
    containerId = parseSkillOutput(psOut).split('\n')[0].trim();

    if (!containerId) {
      console.warn(`[System] 无法通过端口 ${hostPort} 找到容器，尝试回退到 Compose 默认服务...`);
      const fallbackPs = await ShellExecuteSkill.config.run({ command: `cd ${WORKSPACE} && docker-compose ps -q | head -n 1` });
      containerId = parseSkillOutput(fallbackPs).split('\n')[0].trim();
    }

    if (!containerId) {
      const composeLog = await ShellExecuteSkill.config.run({ command: `cd ${WORKSPACE} && docker-compose logs --tail=30 2>&1` });
      const errMsg = `[基础设施致命错误] docker-compose 启动后未能找到运行中的容器（端口 ${hostPort}）。\n容器日志：\n${parseSkillOutput(composeLog)}`;
      await AuditLogger.log(WORKSPACE, "Infrastructure", `**Fatal:** ${errMsg}`);
      console.error(`[System] ${errMsg}`);
      return { containerId: "", testResults: errMsg, allocatedHostPort: hostPort };
    }
  } else {
    // 3. 安全清理并启动单容器 (带端口映射)
    await ShellExecuteSkill.config.run({ command: `docker rm -f ${containerName} 2>/dev/null || true` });
    const startOut = await ShellExecuteSkill.config.run({
      command: `docker run -d --name ${containerName} -p ${hostPort}:${containerPort} -v "${WORKSPACE}:/app" -w /app ${image} tail -f /dev/null`,
      timeout: 60000,
    });
    containerId = startOut.trim().split('\n').pop() || "";
  }

  let hasPackageJson = false;
  try {
    await fs.access(path.join(WORKSPACE, "package.json"));
    hasPackageJson = true;
  } catch {}

  try {
    if (hasPackageJson) {
      await AuditLogger.log(WORKSPACE, "Infrastructure", `**Action:** Installing dependencies (npm install)`);
      const installOut = await execInContainer(containerId, "npm install --silent", { timeout: 300000 });
      await AuditLogger.log(WORKSPACE, "Infrastructure", `**Install Output:**\n${installOut}`);
    }
  } catch (e: any) {
    const errorMsg = `[基础设施异常] npm install 失败: ${e.message || e}`;
    await AuditLogger.log(WORKSPACE, "Infrastructure", `**Critical Error:** ${errorMsg}`);
    return { containerId, testResults: errorMsg, retryCount: (state.retryCount || 0) + 1, allocatedHostPort: hostPort };
  }

  return { containerId, allocatedHostPort: hostPort };
}
