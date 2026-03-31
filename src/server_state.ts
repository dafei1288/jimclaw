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
  autoApprove?: ApprovalAutoApprove
) {
  return {
    userGoal,
    messages: [],
    teamChatLog: [],
    retryCount: 0,
    maxRetries,
    isDone: false,
    contract: null,
    spec: null,
    manifest: null,
    subTasks: [],
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
    requiresApproval: false,
    pendingApprovalStage: null,
    approvalNextNode: "",
  };
}

export function createServerInitialSession(
  userGoal: string,
  maxRetries: number,
  autoApprove?: ApprovalAutoApprove
) {
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
    spec: null,
    subTasks: [],
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
    requiresApproval: false,
    pendingApprovalStage: null,
    approvalNextNode: "",
    agentRecoveryPending: false,
    agentRecoveryNode: "",
    agentRecoveryReason: "",
    workspacePath: null,
  };
}
