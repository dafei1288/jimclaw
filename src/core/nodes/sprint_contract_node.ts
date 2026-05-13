import { EvaluationCheck, JimClawState, SprintContract, SprintPlan } from "../graph_types";
import { getNextRunnableSprintPlan, writeMeetingNote } from "../logic_utils";
import { appendSessionEvent } from "../../utils/session_events";

function findActiveSprint(state: JimClawState): SprintPlan | null {
  return getNextRunnableSprintPlan(state);
}

function normalizeScopePath(value: string): string {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function scopeAllowsFile(fileTarget: string, scopeEntry: string): boolean {
  const file = normalizeScopePath(fileTarget);
  const scope = normalizeScopePath(scopeEntry);
  if (!scope) return false;
  return scope.endsWith("/") ? file.startsWith(scope) : file === scope;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean).map(normalizeScopePath)));
}

function normalizeAllowedFiles(state: JimClawState, sprint: SprintPlan): string[] {
  const subTasks = state.subTasks || [];
  const filesToCreate = state.spec?.filesToCreate || [];
  const candidateFiles = unique([
    ...filesToCreate,
    ...subTasks.map((task) => task.fileTarget),
  ]);
  const sprintScope = sprint.allowedScope || [];
  const taskByFile = new Map(subTasks.map((task) => [normalizeScopePath(task.fileTarget), task]));
  const allowed = new Set(
    candidateFiles.filter((file) => sprintScope.some((scope) => scopeAllowsFile(file, scope)))
  );

  const queue = Array.from(allowed);
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const task = taskByFile.get(file);
    for (const dependency of task?.dependencies || []) {
      const normalized = normalizeScopePath(dependency);
      if (!normalized || allowed.has(normalized)) continue;
      if (candidateFiles.includes(normalized) || taskByFile.has(normalized)) {
        allowed.add(normalized);
        queue.push(normalized);
      }
    }
  }

  if (allowed.size > 0) return Array.from(allowed);
  if (filesToCreate.length > 0) return unique(filesToCreate);
  return unique(sprint.allowedScope || []);
}

function buildDefaultEvaluationChecks(state: JimClawState, sprint: SprintPlan): EvaluationCheck[] {
  const checks: EvaluationCheck[] = [];

  for (const endpoint of state.apiContract?.endpoints || []) {
    const method = String(endpoint.method || "").toUpperCase();
    if (method !== "GET") continue;
    checks.push({
      id: `CHK-HTTP-${checks.length + 1}`,
      kind: "http",
      description: `验证 ${method} ${endpoint.path}`,
      method,
      url: endpoint.path,
      expectedStatus: [200, 201, 204],
    });
  }

  if (!checks.length && state.spec?.testCommand) {
    checks.push({
      id: "CHK-CMD-1",
      kind: "command",
      description: "运行项目测试命令",
      command: state.spec.testCommand,
    });
  }

  if (!checks.length) {
    for (const item of sprint.doneWhen || []) {
      checks.push({
        id: `CHK-MANUAL-${checks.length + 1}`,
        kind: "file",
        description: item,
      });
    }
  }

  return checks;
}

function buildSprintContract(state: JimClawState, sprint: SprintPlan): SprintContract {
  const checks = buildDefaultEvaluationChecks(state, sprint);
  const selfChecks = [state.spec?.testCommand || ""].filter(Boolean);
  const allowedFiles = normalizeAllowedFiles(state, sprint);

  return {
    version: "v1",
    sprintId: sprint.id,
    builderPlan: {
      intent: sprint.goal,
      filesLikelyTouched: allowedFiles,
      implementationSteps: sprint.deliverables,
      selfChecks,
      assumptions: [],
    },
    evaluatorPlan: {
      checks,
      requiredEvidence: checks.map((check) => check.description),
      passThreshold: "all",
      concerns: [],
    },
    agreedScope: {
      allowedFiles,
      forbiddenFiles: ["node_modules/", "dist/", ".git/"],
      maxNewFiles: 8,
    },
    status: checks.length > 0 ? "agreed" : "rejected",
  };
}

export async function sprintContractNode(
  state: JimClawState,
  agents: any,
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("sprint_contract");
  emit("phase-change", "System", "sprint_contract");

  const sprint = findActiveSprint(state);
  const existingContracts = state.sprintContracts || [];
  if (!sprint) {
    const note = await writeMeetingNote(
      WORKSPACE,
      `note-sprint-contract-r${state.retryCount || 0}`,
      "sprint_contract",
      state.retryCount || 0,
      "未找到可用 Sprint，无法生成契约",
      "# Sprint Contract\n\n未找到可用 Sprint，保持现有状态。\n"
    );
    const result = {
      sprintContracts: existingContracts,
      meetingNotes: [note],
    };
    await saveBoulder({ ...state, ...result }, "sprint_contract");
    return result;
  }

  const contract = buildSprintContract(state, sprint);
  const sprintContracts = [
    ...existingContracts.filter((item) => item.sprintId !== contract.sprintId),
    contract,
  ];

  const note = await writeMeetingNote(
    WORKSPACE,
    `note-sprint-contract-r${state.retryCount || 0}`,
    "sprint_contract",
    state.retryCount || 0,
    `${sprint.id} 契约${contract.status === "agreed" ? "已确认" : "未通过"}`,
    `# Sprint Contract

## 当前 Sprint
- ${sprint.id}: ${sprint.title}

## 契约
\`\`\`json
${JSON.stringify(contract, null, 2)}
\`\`\`
`
  );

  emit("thinking", "System", `[SprintContract] ${sprint.id} 生成 ${contract.evaluatorPlan.checks.length} 个验收检查，状态：${contract.status}`, {});
  await appendSessionEvent(WORKSPACE, {
    type: "sprint_contract_agreed",
    node: "sprint_contract",
    summary: `${sprint.id} 契约${contract.status === "agreed" ? "已确认" : "未通过"}`,
    payload: { contract },
  });

  const result = {
    activeSprintId: sprint.id,
    sprintContracts,
    meetingNotes: [note],
  };
  await saveBoulder({ ...state, ...result }, "sprint_contract");
  return result;
}
