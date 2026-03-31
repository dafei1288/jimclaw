import { CapabilitySnapshot, ExecutorBackend, BackendResolution, ExecutionIntent } from "./types";

export async function resolveBackendForIntent(
  intent: Pick<ExecutionIntent, "kind" | "requiresNetwork">,
  snapshot: CapabilitySnapshot
): Promise<BackendResolution> {
  const dockerCandidate: ExecutorBackend = "docker";
  const shellCandidate: ExecutorBackend = "local_shell";
  const candidates: ExecutorBackend[] = [];

  if (snapshot.docker.cliAvailable && snapshot.docker.daemonReachable) {
    candidates.push(dockerCandidate);
  }
  if (snapshot.localShell.available) {
    candidates.push(shellCandidate);
  }

  const needsNetwork = intent.requiresNetwork ?? false;
  const canResolveBackend = candidates.length > 0;
  const requiresApproval = canResolveBackend && needsNetwork && !snapshot.network.outboundAllowed;

  if (!canResolveBackend) {
    return {
      selected: null,
      candidates,
      blocked: true,
      blockedReason: "no backend available",
      requiresApproval,
      approvalScope: requiresApproval ? "network_install" : undefined,
    };
  }

  const selected = candidates.includes(dockerCandidate)
    ? dockerCandidate
    : candidates.includes(shellCandidate)
    ? shellCandidate
    : null;

  return {
    selected,
    candidates,
    blocked: selected === null,
    blockedReason: selected === null ? "no backend available" : undefined,
    requiresApproval,
    approvalScope: requiresApproval ? "network_install" : undefined,
  };
}
