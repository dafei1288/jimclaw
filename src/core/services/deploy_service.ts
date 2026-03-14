import * as fs from "fs/promises";
import * as path from "path";
import { JimClawState, SystemManifest, TechSpec } from "../graph_types";
import { ShellExecuteSkill } from "../../skills/shell_exec";
import { FindFreePortSkill } from "../../skills/find_free_port";
import { GetServerIPSkill } from "../../skills/get_server_ip";
import { execInContainer } from "../logic_utils";
import { AuditLogger } from "../../utils/audit";

export interface DeployResult {
  containerId: string;
  hostPort: string;
  url: string;
  status: "running" | "failed";
  error?: string;
  logs?: string;
}

/**
 * DeployService: 环境搭建与自动化部署服务
 */
export class DeployService {
  /**
   * 执行完整的部署流程
   */
  static async execute(
    runId: string,
    workspaceDir: string,
    context: {
      spec: TechSpec,
      manifest: SystemManifest,
      onEvent?: (event: any) => void
    }
  ): Promise<DeployResult> {
    const containerName = `jimclaw_${runId}`;
    const targetInternalPort = context.manifest?.services?.[0]?.port || 8080;

    // 1. 分配端口
    const rawHostPort = await FindFreePortSkill.config.run({ start_port: 4000, end_port: 4999 });
    const hostPort = rawHostPort.replace(/Output:/g, "").trim().replace(/\D/g, "");
    
    // 2. 准备镜像
    const lang = context.spec?.language?.toLowerCase() ?? "javascript";
    const image = lang.includes("python") ? "python:3.11-slim" : "node:20-alpine";

    await AuditLogger.log(workspaceDir, "Infrastructure", `### [V2 Deployment] Starting\nHost Port: ${hostPort}\nInternal Port: ${targetInternalPort}`);

    // 3. 检查 Compose
    const composePath = path.join(workspaceDir, "docker-compose.yml");
    let hasCompose = false;
    try { await fs.access(composePath); hasCompose = true; } catch {}

    let containerId = "";
    try {
      if (hasCompose) {
        await ShellExecuteSkill.config.run({ command: `cd ${workspaceDir} && docker-compose down 2>/dev/null || true` });
        await ShellExecuteSkill.config.run({ command: `cd ${workspaceDir} && docker-compose up -d` });
        containerId = containerName;
      } else {
        await ShellExecuteSkill.config.run({ command: `docker rm -f ${containerName} 2>/dev/null || true` });
        const startOut = await ShellExecuteSkill.config.run({
          command: `docker run -d --name ${containerName} -p ${hostPort}:${targetInternalPort} -v "${workspaceDir}:/app" -w /app ${image} tail -f /dev/null`,
          timeout: 60000,
        });
        containerId = startOut.replace(/Output:/g, "").trim().split('\n').pop() || "";
      }

      // 4. 安装依赖
      let hasPackageJson = false;
      try { await fs.access(path.join(workspaceDir, "package.json")); hasPackageJson = true; } catch {}
      if (hasPackageJson) {
        await execInContainer(containerId, "npm install --silent", { timeout: 300000 });
      }

      // 5. 启动应用
      const runCmd = context.spec?.runCommand || "npm start";
      await execInContainer(containerId, runCmd, { background: true });

      // 6. 健康检查
      const ip = await GetServerIPSkill.config.run({});
      const dynamicUrl = `http://${ip}:${hostPort}`;
      
      let isAccessible = false;
      for (let i = 0; i < 10; i++) {
        try {
          const curlOut = await ShellExecuteSkill.config.run({ 
            command: `curl -s -o /dev/null -w "%{http_code}" --max-time 2 ${dynamicUrl}`,
            timeout: 5000
          });
          const code = curlOut.replace(/Output:/g, "").trim();
          if (code === "200" || code === "301" || code === "302") {
            isAccessible = true;
            break;
          }
        } catch (e) {}
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      if (isAccessible) {
        return { containerId, hostPort, url: dynamicUrl, status: "running" };
      } else {
        const logs = await ShellExecuteSkill.config.run({ command: `docker logs ${containerName} --tail 100` });
        return { 
          containerId, hostPort, url: dynamicUrl, status: "failed", 
          error: "Health check failed", logs: logs.replace(/Output:/g, "").trim() 
        };
      }

    } catch (e: any) {
      return { containerId: "", hostPort, url: "", status: "failed", error: e.message };
    }
  }
}
