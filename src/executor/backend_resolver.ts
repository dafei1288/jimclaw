import { CapabilitySnapshot, ExecutorBackend, BackendResolution, ExecutionIntent } from "./types";

function buildResolution(
  selected: ExecutorBackend | null,
  candidates: ExecutorBackend[],
  blockedReason?: string
): BackendResolution {
  return {
    selected,
    candidates,
    blocked: selected === null,
    blockedReason: selected === null ? (blockedReason || "no backend available") : undefined,
    requiresApproval: false,
  };
}

export async function resolvePreferredBackend(
  preferredBackend: "docker" | "local_shell",
  snapshot: CapabilitySnapshot
): Promise<BackendResolution> {
  if (preferredBackend === "docker") {
    if (snapshot.docker.cliAvailable && snapshot.docker.daemonReachable) {
      return buildResolution("docker", ["docker"]);
    }
    if (snapshot.externalExecutor?.available) {
      return buildResolution("external_executor", ["external_executor"]);
    }
    return buildResolution(null, [], snapshot.docker.reason || snapshot.externalExecutor?.reason || "docker unavailable");
  }

  if (snapshot.localShell.available) {
    return buildResolution("local_shell", ["local_shell"]);
  }
  if (snapshot.externalExecutor?.available) {
    return buildResolution("external_executor", ["external_executor"]);
  }
  return buildResolution(null, [], snapshot.localShell.reason || snapshot.externalExecutor?.reason || "local shell unavailable");
}

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
  if (snapshot.externalExecutor?.available) {
    candidates.push("external_executor");
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
    : candidates.includes("external_executor")
    ? "external_executor"
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
