import { buildCustomerApprovalState } from "./core/logic_utils";

export type ApprovalAutoApprove = Partial<{
  requirements: boolean;
  solution: boolean;
  deploy: boolean;
}>;

export function buildServerAutoApprove(autoApprove?: ApprovalAutoApprove) {
  return {
    requirements: autoApprove?.requirements ?? true,
    solution: autoApprove?.solution ?? true,
    deploy: autoApprove?.deploy ?? true,
  };
}

export function createBaseGraphState(
  userGoal: string,
  maxRetries: number,
  autoApprove?: ApprovalAutoApprove,
  executionTuning?: { coderMaxParallel?: number; coderExperimentalModelParallel?: boolean }
) {
  const coderMaxParallel = Number(executionTuning?.coderMaxParallel || 1);
  return {
    userGoal,
    messages: [],
    teamChatLog: [],
    retryCount: 0,
    maxRetries,
    isDone: false,
    contract: null,
    contractSource: "model",
    spec: null,
    designSource: "model",
    manifest: null,
    subTasks: [],
    orchestrationSource: "model",
    code: "",
    testResults: "",
    qaFailures: null,
    issueTracker: [],
    mediationDirectives: null,
    fixPlan: null,
    projectBrief: [],
    codeLog: [],
    packageJsonHash: "",
    executionProtocol: null,
    protocolFailures: [],
    protocolPatches: [],
    customerApprovalState: buildCustomerApprovalState({
      autoApprove: buildServerAutoApprove(autoApprove),
    }),
    executorState: null,
    coderMaxParallel: Number.isFinite(coderMaxParallel) ? Math.max(1, Math.min(4, Math.floor(coderMaxParallel))) : 1,
    coderExperimentalModelParallel: Boolean(executionTuning?.coderExperimentalModelParallel),
    requiresApproval: false,
    pendingApprovalStage: null,
    pendingApprovalTicketId: "",
    approvalNextNode: "",
  };
}

export function createServerInitialSession(
  userGoal: string,
  maxRetries: number,
  autoApprove?: ApprovalAutoApprove,
  executionTuning?: { coderMaxParallel?: number; coderExperimentalModelParallel?: boolean }
) {
  const coderMaxParallel = Number(executionTuning?.coderMaxParallel || 1);
  return {
    userGoal,
    status: "Running",
    currentPhase: "requirement",
    phaseData: {
      requirement: { startTime: Date.now(), status: "active" },
    },
    currentNode: "-",
    retryCount: 0,
    maxRetries,
    logs: [],
    events: [],
    deployment: { status: "none", url: null },
    contract: null,
    contractSource: "model",
    spec: null,
    designSource: "model",
    subTasks: [],
    orchestrationSource: "model",
    testResults: "",
    qaFailures: null,
    issueTracker: [],
    mediationDirectives: null,
    fixPlan: null,
    projectBrief: [],
    codeLog: [],
    consensusCore: null,
    consensusProgress: null,
    meetingNotes: [],
    lastFailedNode: "",
    lastFailureSummary: "",
    executionProtocol: null,
    protocolFailures: [],
    protocolPatches: [],
    customerApprovalState: buildCustomerApprovalState({
      autoApprove: buildServerAutoApprove(autoApprove),
    }),
    executorState: null,
    coderMaxParallel: Number.isFinite(coderMaxParallel) ? Math.max(1, Math.min(4, Math.floor(coderMaxParallel))) : 1,
    coderExperimentalModelParallel: Boolean(executionTuning?.coderExperimentalModelParallel),
    requiresApproval: false,
    pendingApprovalStage: null,
    pendingApprovalTicketId: "",
    approvalNextNode: "",
    agentRecoveryPending: false,
    agentRecoveryNode: "",
    agentRecoveryReason: "",
    workspacePath: null,
  };
}
