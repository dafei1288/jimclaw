import { z } from "zod";
import { spawn } from "child_process";
import { Skill } from "../core/skill";
import { CapabilitySnapshot, ExecutionIntent, ExecutorResult } from "../executor/types";

/**
 * 执行 Shell 命令的 Skill: 支持背景运行和超时控制
 */
export const ShellExecuteSkill = new Skill({
  name: "execute_command",
  description: "Execute a shell command in the terminal and return its output.",
  schema: z.object({
    command: z.string().describe("The shell command to run (e.g., 'npm test', 'node script.js')."),
    workDir: z.string().optional().describe("Optional: The directory to run the command in. Defaults to the current workspace root."),
    isBackground: z.boolean().optional().describe("If true, run the command in the background and return immediately."),
    timeout: z.number().optional().describe("Timeout in milliseconds for the command execution."),
  }),
  run: async ({ command, workDir, isBackground, timeout }) => {
    try {
      // 路径解析逻辑：优先使用参数 workDir，其次是环境变量 JIMCLAW_WORKSPACE，最后是当前进程目录
      const workspaceRoot = process.env.JIMCLAW_WORKSPACE;
      const effectiveWorkDir = workDir || workspaceRoot || process.cwd();

      console.log(`[System] Executing in ${effectiveWorkDir}: ${command}${isBackground ? " (background)" : ""}`);
      
      if (isBackground) {
        try {
          const child = spawn(command, {
            shell: true,
            detached: true,
            stdio: 'ignore',
            cwd: effectiveWorkDir
          });
          child.unref();
          return `Background process started with PID: ${child.pid} in ${effectiveWorkDir}`;
        } catch (error: any) {
          return `Command failed with error: ${error.message}`;
        }
      }

      return new Promise<string>((resolve, reject) => {
        let child;
        try {
          child = spawn(command, {
            shell: true,
            cwd: effectiveWorkDir
          });
        } catch (error: any) {
          resolve(`Command failed with error: ${error.message}`);
          return;
        }
        let stdout = "";
        let stderr = "";
        let timer: NodeJS.Timeout;

        if (timeout) {
          timer = setTimeout(() => {
            child.kill('SIGTERM');
            resolve(`Command timed out after ${timeout}ms. Output so far:\n${stdout}\nErrors so far:\n${stderr}`);
          }, timeout);
        }

        child.stdout.on("data", (data) => { stdout += data.toString(); });
        child.stderr.on("data", (data) => { stderr += data.toString(); });

        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          if (code === 0) {
            resolve(`Output:\n${stdout}${stderr ? `\nErrors:\n${stderr}` : ""}`);
          } else {
            resolve(`Command failed with exit code ${code}.\nOutput:\n${stdout}\nErrors:\n${stderr}`);
          }
        });

        child.on("error", (err) => {
          if (timer) clearTimeout(timer);
          resolve(`Command failed with error: ${err.message}`);
        });
      });
    } catch (error: any) {
      return `Command failed with error: ${error.message}`;
    }
  },
});

type LocalShellAdapterDeps = {
  runCommand?: (args: {
    command: string;
    workDir?: string;
    isBackground?: boolean;
    timeout?: number;
  }) => Promise<string>;
};

function unwrapSkillOutput(raw: string) {
  const text = String(raw || "");
  const match = text.match(/Output:\n([\s\S]*?)(?:\nErrors:|$)/);
  return (match ? match[1] : text).trim();
}

function extractSkillErrors(raw: string) {
  const text = String(raw || "");
  const match = text.match(/\nErrors:\n([\s\S]*)$/);
  return (match ? match[1] : "").trim();
}

export function createLocalShellAdapter(deps: LocalShellAdapterDeps = {}) {
  const runCommand =
    deps.runCommand ||
    ((args: { command: string; workDir?: string; isBackground?: boolean; timeout?: number }) =>
      ShellExecuteSkill.config.run(args));

  return {
    async execute(
      intent: ExecutionIntent,
      _context: { capabilitySnapshot: CapabilitySnapshot }
    ): Promise<ExecutorResult> {
      const raw = await runCommand({
        command: intent.command || "",
        workDir: intent.workspace,
        isBackground: intent.background,
        timeout: 30000,
      });

      const failed = /^Command failed/i.test(String(raw || "").trim());
      return {
        ok: !failed,
        backend: "local_shell",
        stdout: unwrapSkillOutput(raw),
        stderr: extractSkillErrors(raw),
        retryable: false,
        requiresApproval: false,
        blocked: false,
      };
    },
  };
}
