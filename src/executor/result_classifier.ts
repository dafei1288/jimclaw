import { ExecutorFailureType } from "./types";
import { ValidationFailureType } from "../core/graph_types";

type FailureInput = {
  raw?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
};

function buildFailureText(input: FailureInput) {
  return [input.raw || "", input.stdout || "", input.stderr || ""].filter(Boolean).join("\n");
}

export function classifyExecutorFailure(input: FailureInput): ExecutorFailureType {
  const text = buildFailureText(input);

  if (/spawn EPERM|EACCES|Access is denied/i.test(text)) {
    return "process_spawn_denied";
  }
  if (/failed to connect to the docker api|docker daemon|dockerdesktoplinuxengine/i.test(text)) {
    return "docker_daemon_unreachable";
  }
  if (/spawn ENOENT|not recognized as an internal or external command|command not found/i.test(text)) {
    return "command_not_found";
  }
  if (/timed out|timeout/i.test(text)) {
    return "timeout";
  }
  if (/EADDRINUSE|port is already allocated|address already in use/i.test(text)) {
    return "port_conflict";
  }
  if (/permission required|approval required/i.test(text)) {
    return "permission_required";
  }
  if (/network unavailable|ENOTFOUND|ECONNREFUSED|ECONNRESET/i.test(text)) {
    return "network_unavailable";
  }
  if (/runtime start failed|service start failed|deploy launch failed/i.test(text)) {
    return "runtime_start_failed";
  }
  return "executor_unavailable";
}

export function mapExecutorFailureToValidationFailure(
  failureType: ExecutorFailureType
): ValidationFailureType {
  if (failureType === "port_conflict" || failureType === "runtime_start_failed") {
    return "runtime_gap";
  }
  return "environment_gap";
}
