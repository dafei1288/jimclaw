import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { Skill } from "../core/skill";

const execAsync = promisify(exec);

/**
 * Playwright E2E 测试 Skill
 */
export const PlaywrightSkill = new Skill({
  name: "playwright_exec",
  description: "Execute Playwright E2E tests and return results.",
  schema: z.object({
    command: z.string().describe("The playwright test command (e.g., 'npx playwright test')."),
    workDir: z.string().optional().describe("Optional working directory."),
  }),
  run: async ({ command, workDir }) => {
    try {
      console.log(`[Playwright] Running: ${command}${workDir ? ` in ${workDir}` : ""}`);
      
      const fullCommand = workDir ? `cd ${workDir} && ${command}` : command;
      const { stdout, stderr } = await execAsync(fullCommand);
      
      return `Output:
${stdout}${stderr ? `
Errors:
${stderr}` : ""}`;
    } catch (error: any) {
      return `Playwright tests failed: ${error.message}
Output: ${error.stdout}
Errors: ${error.stderr}`;
    }
  },
});
