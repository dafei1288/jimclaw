import { JimClawState } from "../graph_types";
import { buildProductSpec, buildSprintPlans, writeMeetingNote } from "../logic_utils";
import { appendSessionEvent } from "../../utils/session_events";

export async function sprintPlannerNode(
  state: JimClawState,
  agents: any,
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("sprint_planner");
  emit("phase-change", "System", "sprint_planning");

  const productSpec = state.productSpec || buildProductSpec(state.userGoal || "", state.contract);
  const sprintPlans = buildSprintPlans({
    productSpec,
    apiContract: state.apiContract,
    spec: state.spec,
  });
  const knownSprintIds = new Set(sprintPlans.map((sprint) => sprint.id));
  const activeSprintId = state.activeSprintId && knownSprintIds.has(state.activeSprintId)
    ? state.activeSprintId
    : sprintPlans[0]?.id || "";

  const note = await writeMeetingNote(
    WORKSPACE,
    "note-sprint-planner-r0",
    "sprint_planner",
    0,
    `拆分为 ${sprintPlans.length} 个 Sprint`,
    `# Sprint Planner

\`\`\`json
${JSON.stringify(sprintPlans, null, 2)}
\`\`\`
`
  );

  emit("thinking", "System", `[SprintPlanner] 已拆分为 ${sprintPlans.length} 个 Sprint，当前 Sprint：${activeSprintId || "无"}`, {});
  await appendSessionEvent(WORKSPACE, {
    type: "sprint_planned",
    node: "sprint_planner",
    summary: `拆分为 ${sprintPlans.length} 个 Sprint`,
    payload: { activeSprintId, sprintPlans },
  });

  const result = {
    productSpec,
    sprintPlans,
    activeSprintId,
    meetingNotes: [note],
  };
  await saveBoulder({ ...state, ...result }, "sprint_planner");
  return result;
}
