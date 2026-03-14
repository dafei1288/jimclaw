import { JimClawState } from "../graph_types";

/**
 * Approval 节点：负责获取用户对于方案设计的审批
 */
export async function approvalNode(
  state: JimClawState,
  agents: any,
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  emit("phase-change", "System", "approval");
  emit("approval_required", "系统", "方案设计已就绪，请审阅。", { spec: state.spec, manifest: state.manifest });
  return { requiresApproval: true };
}
