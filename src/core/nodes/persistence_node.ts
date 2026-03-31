import { JimClawState } from "../graph_types";
import { ShellExecuteSkill } from "../../skills/shell_exec";
import * as fs from "fs/promises";
import * as path from "path";

/**
 * Persistence 节点：负责资源清理和最终状态持久化
 */
export async function persistenceNode(
  state: JimClawState,
  agents: any,
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  if (state.executionBackend === "host") {
    const pidPath = path.join(WORKSPACE, ".jimclaw", "server.pid");
    if (state.deploymentStatus?.status === "running") {
      console.log(`[Persistence] 服务已部署，保留宿主机进程`);
    } else {
      const pidText = await fs.readFile(pidPath, "utf-8").catch(() => "");
      const pid = Number(String(pidText).trim());
      if (pid > 0) {
        try {
          process.kill(pid);
        } catch {}
      }
    }
  }
  if (state.containerId) {
    // 如果部署成功且服务正在运行，则不要删除容器
    if (state.deploymentStatus?.status === 'running') {
      console.log(`[Persistence] 服务已部署，保留容器: ${state.containerId}`);
    } else {
      await ShellExecuteSkill.config.run({ command: `docker rm -f ${state.containerId} 2>/dev/null || true` });
    }
  }
  const result = { isDone: true };
  await saveBoulder({ ...state, ...result }, "persistence");
  return result;
}
