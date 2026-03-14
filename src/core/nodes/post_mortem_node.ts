import { JimClawState } from "../graph_types";
import { BaseAgent } from "../agent";

/**
 * PostMortem 节点：负责项目完成后的复盘和总结
 */
export async function postMortemNode(
  state: JimClawState,
  agents: { pm: BaseAgent },
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  emit("phase-change", "System", "review");
  return { teamChatLog: [{ sender: agents.pm.getPersona().name, content: "复盘完成。" }] };
}
