import { JimClawState } from "../graph_types";
import { execInContainer } from "../logic_utils";
import { AuditLogger } from "../../utils/audit";

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
  
  await AuditLogger.log(WORKSPACE, "Terminal", `### [Test Execution]\n\n**Command:** ${testCmd}\n**Container:** ${state.containerId}`);
  
  if (!state.containerId) {
    // 保留 infra_node 写入的构建错误（如 Dockerfile 错误），不用通用信息覆盖
    const errMsg = state.testResults?.includes("基础设施")
      ? state.testResults
      : "[Terminal] 容器 ID 为空，跳过测试执行。请检查 infra_setup 是否成功启动容器。";
    await AuditLogger.log(WORKSPACE, "Terminal", `**Skipped:** ${errMsg}`);
    return { testResults: errMsg };
  }

  const result = await execInContainer(state.containerId, `NODE_ENV=test ${testCmd}`, { timeout: 90000 });
  
  await AuditLogger.log(WORKSPACE, "Terminal", `**Test Output:**\n${result}`);
  
  return { testResults: result };
}
