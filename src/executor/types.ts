export type ExecutorBackend = "local_shell" | "docker" | "remote_runner" | "external_executor";

export const EXECUTION_INTENT_KINDS = [
  "install_deps",
  "build_workspace",
  "prepare_runtime",
  "run_tests",
  "start_runtime",
  "exec_shell",
] as const;
export type ExecutionIntentKind = (typeof EXECUTION_INTENT_KINDS)[number];

export type ApprovalTicketStatus = "pending" | "approved" | "rejected" | "auto_approved";

export const APPROVAL_STAGES = ["network_install", "docker_start", "background_runtime", "deployment_publish"] as const;
export type ApprovalStage = (typeof APPROVAL_STAGES)[number];

export interface ApprovalTicket {
  id: string;
  stage: ApprovalStage;
  required: boolean;
  status: ApprovalTicketStatus;
  reason: string;
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: "customer" | "default-authorization";
}

export interface CapabilitySnapshot {
  version: "v1";
  localShell: { available: boolean; reason?: string };
  docker: { cliAvailable: boolean; daemonReachable: boolean; reason?: string };
  network: { outboundAllowed: boolean; reason?: string };
  backgroundProcess: { available: boolean; reason?: string };
}

export const EXECUTOR_FAILURE_TYPES = [
  "executor_unavailable",
  "permission_required",
  "docker_daemon_unreachable",
  "command_not_found",
  "process_spawn_denied",
  "network_unavailable",
  "timeout",
  "port_conflict",
  "runtime_start_failed",
] as const;
export type ExecutorFailureType = (typeof EXECUTOR_FAILURE_TYPES)[number];

export interface ExecutorResult {
  ok: boolean;
  backend: ExecutorBackend | null;
  stdout: string;
  stderr: string;
  exitCode?: number;
  failureType?: ExecutorFailureType;
  retryable: boolean;
  requiresApproval: boolean;
  approvalTicketId?: string;
  blocked: boolean;
  blockedReason?: string;
  artifacts?: {
    pidPath?: string;
    stdoutLogPath?: string;
    stderrLogPath?: string;
  };
}

export interface ExecutionIntent {
  kind: ExecutionIntentKind;
  workspace: string;
  command?: string;
  background?: boolean;
  port?: number;
  host?: string;
  requiresNetwork?: boolean;
}

export interface BackendResolution {
  selected: ExecutorBackend | null;
  candidates: ExecutorBackend[];
  blocked: boolean;
  blockedReason?: string;
  requiresApproval: boolean;
  approvalScope?: string;
}

export interface RuntimeHandle {
  id: string;
  backend: ExecutorBackend;
  kind: "process" | "container" | "job";
  workspace: string;
  startedAt: string;
  status: "starting" | "running" | "stopped" | "failed";
}

export interface ExecutorState {
  version: "v1";
  capabilitySnapshot?: CapabilitySnapshot;
  selectedBackend?: ExecutorBackend | null;
  approvalTickets: ApprovalTicket[];
  runtimeHandles: RuntimeHandle[];
  lastExecutorResult?: ExecutorResult;
}
