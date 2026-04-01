import { createApprovalTicket } from "./approval_tickets";
import { probeExecutionCapabilities } from "./capability_probe";
import { resolveBackendForIntent } from "./backend_resolver";
import { createExternalExecutorAdapter } from "./external_executor";
import {
  ApprovalStage,
  ApprovalTicket,
  BackendResolution,
  CapabilitySnapshot,
  ExecutionIntent,
  ExecutorBackend,
  ExecutorResult,
} from "./types";

type BackendAdapter = {
  execute: (intent: ExecutionIntent, context: { capabilitySnapshot: CapabilitySnapshot }) => Promise<ExecutorResult>;
};

type CommandExecutorDeps = {
  probeCapabilities?: (workspace: string) => Promise<CapabilitySnapshot>;
  resolveBackend?: (
    intent: Pick<ExecutionIntent, "kind" | "requiresNetwork">,
    snapshot: CapabilitySnapshot
  ) => Promise<BackendResolution>;
  createApprovalTicket?: (input: {
    stage: ApprovalStage;
    reason: string;
  }) => ApprovalTicket;
  adapters?: Partial<Record<ExecutorBackend, BackendAdapter>>;
};

export type ResolvedExecutionIntent = {
  capabilitySnapshot: CapabilitySnapshot;
  resolution: BackendResolution;
  approvalTicket?: ApprovalTicket;
};

function mapApprovalScopeToStage(scope?: string): ApprovalStage {
  if (scope === "docker_start") return "docker_start";
  if (scope === "background_runtime") return "background_runtime";
  if (scope === "deployment_publish") return "deployment_publish";
  return "network_install";
}

export function createCommandExecutor(deps: CommandExecutorDeps = {}) {
  const probeCapabilities = deps.probeCapabilities || probeExecutionCapabilities;
  const resolveBackend = deps.resolveBackend || resolveBackendForIntent;
  const approvalTicketFactory = deps.createApprovalTicket || createApprovalTicket;
  const adapters = {
    external_executor: createExternalExecutorAdapter(),
    ...(deps.adapters || {}),
  };

  return {
    async probeCapabilities(workspace: string) {
      return probeCapabilities(workspace);
    },

    async resolveIntent(
      intent: ExecutionIntent,
      providedSnapshot?: CapabilitySnapshot
    ): Promise<ResolvedExecutionIntent> {
      const capabilitySnapshot = providedSnapshot || await probeCapabilities(intent.workspace);
      const resolution = await resolveBackend(intent, capabilitySnapshot);
      const approvalTicket = resolution.blocked || !resolution.selected || !resolution.requiresApproval
        ? undefined
        : approvalTicketFactory({
            stage: mapApprovalScopeToStage(resolution.approvalScope),
            reason: `approval required for ${intent.kind}`,
          });

      return {
        capabilitySnapshot,
        resolution,
        approvalTicket,
      };
    },

    async executeIntent(intent: ExecutionIntent): Promise<ExecutorResult> {
      const { capabilitySnapshot, resolution, approvalTicket } = await this.resolveIntent(intent);

      if (resolution.blocked || !resolution.selected) {
        return {
          ok: false,
          backend: null,
          stdout: "",
          stderr: "",
          retryable: false,
          requiresApproval: false,
          blocked: true,
          blockedReason: resolution.blockedReason || "no backend available",
        };
      }

      if (resolution.requiresApproval) {
        return {
          ok: false,
          backend: resolution.selected,
          stdout: "",
          stderr: "",
          retryable: false,
          requiresApproval: true,
          approvalTicketId: approvalTicket?.id,
          blocked: true,
          blockedReason: resolution.blockedReason || "approval required",
        };
      }

      const adapter = adapters[resolution.selected];
      if (!adapter) {
        return {
          ok: false,
          backend: resolution.selected,
          stdout: "",
          stderr: "",
          retryable: false,
          requiresApproval: false,
          blocked: true,
          blockedReason: `missing adapter for backend ${resolution.selected}`,
        };
      }

      return adapter.execute(intent, { capabilitySnapshot });
    },
  };
}
