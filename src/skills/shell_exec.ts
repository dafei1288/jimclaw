import { z } from "zod";
import { spawn } from "child_process";
import { Skill } from "../core/skill";

/**
 * 执行 Shell 命令的 Skill: 支持背景运行和超时控制
 */
export const ShellExecuteSkill = new Skill({
  name: "execute_command",
  description: "Execute a shell command in the terminal and return its output.",
  schema: z.object({
    command: z.string().describe("The shell command to run (e.g., 'npm test', 'node script.js')."),
    isBackground: z.boolean().optional().describe("If true, run the command in the background and return immediately."),
    timeout: z.number().optional().describe("Timeout in milliseconds for the command execution."),
  }),
  run: async ({ command, isBackground, timeout }) => {
    try {
      console.log(`[System] Executing: ${command}${isBackground ? " (background)" : ""}`);
      
      if (isBackground) {
        const child = spawn(command, {
          shell: true,
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        return `Background process started with PID: ${child.pid}`;
      }

      return new Promise<string>((resolve, reject) => {
        const child = spawn(command, { shell: true });
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
          reject(err);
        });
      });
    } catch (error: any) {
      return `Command failed with error: ${error.message}`;
    }
  },
});
