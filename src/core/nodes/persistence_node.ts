import { JimClawState } from "../graph_types";
import { ShellExecuteSkill } from "../../skills/shell_exec";

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
  if (state.containerId) {
    // 如果部署成功且服务正在运行，则不要删除容器
    if (state.deploymentStatus?.status === 'running') {
      console.log(`[Persistence] 服务已部署，保留容器: ${state.containerId}`);
    } else {
      await ShellExecuteSkill.config.run({ command: `docker rm -f ${state.containerId} 2>/dev/null || true` });
    }
  }
  return { isDone: true };
}
