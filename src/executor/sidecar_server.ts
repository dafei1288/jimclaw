import express from "express";
import fs from "fs";
import * as fsp from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { classifyExecutorFailure } from "./result_classifier";
import { ExecutionIntent, ExecutorResult } from "./types";

type SidecarRunResult = Partial<ExecutorResult> & {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

type SidecarOptions = {
  token?: string;
  runCommand?: (intent: ExecutionIntent) => Promise<SidecarRunResult>;
};

function ensureExternalResult(result: SidecarRunResult): ExecutorResult {
  return {
    ok: result.ok,
    backend: "external_executor",
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    exitCode: typeof result.exitCode === "number" ? result.exitCode : undefined,
    retryable: Boolean(result.retryable),
    requiresApproval: Boolean(result.requiresApproval),
    approvalTicketId: result.approvalTicketId,
    blocked: Boolean(result.blocked),
    blockedReason: result.blockedReason ? String(result.blockedReason) : undefined,
    artifacts: result.artifacts,
    failureType: result.failureType,
  };
}

function getRuntimeArtifactPaths(workspace: string) {
  const runtimeDir = path.join(workspace, ".jimclaw");
  return {
    runtimeDir,
    pidPath: path.join(runtimeDir, "server.pid"),
    stdoutLogPath: path.join(runtimeDir, "server.stdout.log"),
    stderrLogPath: path.join(runtimeDir, "server.stderr.log"),
  };
}

async function runForeground(intent: ExecutionIntent): Promise<SidecarRunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(intent.command || "", {
        cwd: intent.workspace,
        shell: true,
        env: process.env,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({
        ok: false,
        stdout: "",
        stderr: message,
        blocked: true,
        blockedReason: message,
        failureType: classifyExecutorFailure({ raw: message }),
      });
      return;
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      resolve({
        ok: false,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${message}`,
        blocked: true,
        blockedReason: message,
        failureType: classifyExecutorFailure({ raw: message, stdout, stderr }),
      });
    });
    child.on("close", (code) => {
      const ok = code === 0;
      resolve({
        ok,
        stdout,
        stderr,
        exitCode: typeof code === "number" ? code : undefined,
        blocked: !ok && code === null,
        blockedReason: !ok && code === null ? (stderr || stdout || "command interrupted") : undefined,
        failureType: ok ? undefined : classifyExecutorFailure({ stdout, stderr }),
      });
    });
  });
}

async function runBackground(intent: ExecutionIntent): Promise<SidecarRunResult> {
  const { runtimeDir, pidPath, stdoutLogPath, stderrLogPath } = getRuntimeArtifactPaths(intent.workspace);
  await fsp.mkdir(runtimeDir, { recursive: true });

  const stdoutStream = fs.createWriteStream(stdoutLogPath, { flags: "w" });
  const stderrStream = fs.createWriteStream(stderrLogPath, { flags: "w" });

  try {
    const child = spawn(intent.command || "", {
      cwd: intent.workspace,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout?.pipe(stdoutStream);
    child.stderr?.pipe(stderrStream);
    child.unref();
    await fsp.writeFile(pidPath, String(child.pid || ""), "utf-8");
    return {
      ok: true,
      stdout: String(child.pid || ""),
      stderr: "",
      artifacts: {
        pidPath,
        stdoutLogPath,
        stderrLogPath,
      },
    };
  } catch (error) {
    stdoutStream.end();
    stderrStream.end();
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      stdout: "",
      stderr: message,
      blocked: true,
      blockedReason: message,
      failureType: classifyExecutorFailure({ raw: message }),
      artifacts: {
        pidPath,
        stdoutLogPath,
        stderrLogPath,
      },
    };
  }
}

export async function runSidecarCommand(intent: ExecutionIntent): Promise<SidecarRunResult> {
  if (intent.background) {
    return runBackground(intent);
  }
  return runForeground(intent);
}

function isAuthorized(req: express.Request, token: string) {
  if (!token) return true;
  const header = String(req.headers.authorization || "");
  return header === `Bearer ${token}`;
}

export function createExecutorSidecarApp(options: SidecarOptions = {}) {
  const app = express();
  const token = String(options.token || process.env.JIMCLAW_EXTERNAL_EXECUTOR_TOKEN || "").trim();
  const runCommand = options.runCommand || runSidecarCommand;

  app.use(express.json({ limit: "1mb" }));

  app.get("/capabilities", (_req, res) => {
    res.json({
      available: true,
      name: "jimclaw-executor-sidecar",
      backgroundProcess: { available: true },
      shell: { available: true },
      platform: process.platform,
      pid: process.pid,
    });
  });

  app.post("/execute", async (req, res) => {
    if (!isAuthorized(req, token)) {
      res.status(401).json({
        ok: false,
        backend: "external_executor",
        stdout: "",
        stderr: "unauthorized",
        retryable: false,
        requiresApproval: false,
        blocked: true,
        blockedReason: "unauthorized",
        failureType: "permission_required",
      });
      return;
    }

    const intent = req.body?.intent as ExecutionIntent | undefined;
    if (!intent?.workspace || !intent?.kind) {
      res.status(400).json({
        ok: false,
        backend: "external_executor",
        stdout: "",
        stderr: "invalid intent payload",
        retryable: false,
        requiresApproval: false,
        blocked: true,
        blockedReason: "invalid intent payload",
        failureType: "executor_unavailable",
      });
      return;
    }

    try {
      const result = ensureExternalResult(await runCommand(intent));
      res.status(result.ok ? 200 : 200).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({
        ok: false,
        backend: "external_executor",
        stdout: "",
        stderr: message,
        retryable: true,
        requiresApproval: false,
        blocked: true,
        blockedReason: message,
        failureType: classifyExecutorFailure({ raw: message }),
      });
    }
  });

  return app;
}

export async function startExecutorSidecarServer(options: SidecarOptions = {}) {
  const app = createExecutorSidecarApp(options);
  const port = Number(process.env.JIMCLAW_EXTERNAL_EXECUTOR_PORT || 4318);
  const host = process.env.JIMCLAW_EXTERNAL_EXECUTOR_HOST || "127.0.0.1";
  return new Promise<{ app: express.Express; server: ReturnType<typeof app.listen>; host: string; port: number }>((resolve) => {
    const server = app.listen(port, host, () => {
      resolve({ app, server, host, port });
    });
  });
}
