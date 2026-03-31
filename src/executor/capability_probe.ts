import { spawn } from "child_process";
import { CapabilitySnapshot } from "./types";

type CommandRunner = (options: {
  command: string;
  workspace: string;
  timeoutMs?: number;
}) => Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  error?: Error;
}>;

const defaultRunner: CommandRunner = async ({ command, workspace, timeoutMs = 10_000 }) => {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(command, { shell: true, cwd: workspace });
    } catch (error) {
      resolve({
        stdout,
        stderr,
        code: null,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        stdout,
        stderr,
        code: null,
        error: new Error("timeout"),
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, error });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, error: undefined });
    });
  });
};

function mapErrorReason(error?: Error): string | undefined {
  if (!error) return undefined;
  return error.message;
}

export async function probeLocalShellCapability(
  workspace: string,
  runner: CommandRunner = defaultRunner
): Promise<CapabilitySnapshot["localShell"]> {
  const probeCmd = process.platform === "win32" ? "cmd.exe /d /s /c echo executor-shell-probe" : "sh -c 'echo executor-shell-probe'";
  let result;
  try {
    result = await runner({ command: probeCmd, workspace });
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (result.error) {
    return {
      available: false,
      reason: mapErrorReason(result.error),
    };
  }
  if (result.code !== 0) {
    return {
      available: false,
      reason: result.stderr || result.stdout || "non-zero exit code",
    };
  }
  return {
    available: true,
  };
}

export async function probeDockerCapability(
  workspace: string,
  runner: CommandRunner = defaultRunner
): Promise<CapabilitySnapshot["docker"]> {
  const result = await runner({
    command: "docker version --format \"{{.Server.Version}}\"",
    workspace,
  });
  if (result.error) {
    const missingCli = /ENOENT|not recognized as an internal or external command/i.test(
      result.error.message
    );
    if (missingCli) {
      return {
        cliAvailable: false,
        daemonReachable: false,
        reason: result.error.message,
      };
    }
    return {
      cliAvailable: true,
      daemonReachable: false,
      reason: mapErrorReason(result.error),
    };
  }
  if (result.code !== 0) {
    return {
      cliAvailable: true,
      daemonReachable: false,
      reason: result.stderr || result.stdout || "docker version failed",
    };
  }
  return {
    cliAvailable: true,
    daemonReachable: true,
  };
}

export async function probeExecutionCapabilities(
  workspace: string,
  runner: CommandRunner = defaultRunner
): Promise<CapabilitySnapshot> {
  const local = await probeLocalShellCapability(workspace, runner);
  const docker = await probeDockerCapability(workspace, runner);
  return {
    version: "v1",
    localShell: local,
    docker,
    network: {
      outboundAllowed: true,
    },
    backgroundProcess: {
      available: local.available,
    },
  };
}
