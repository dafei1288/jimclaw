import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { Skill } from "../core/skill";

const execAsync = promisify(exec);

/**
 * Docker 操作 Skill
 */
export const DockerSkill = new Skill({
  name: "docker_exec",
  description: "Execute Docker or Docker Compose commands.",
  schema: z.object({
    command: z.string().describe("The Docker or Docker Compose command (e.g., 'docker-compose up -d', 'docker ps')."),
    workDir: z.string().optional().describe("Optional working directory to run the command in."),
  }),
  run: async ({ command, workDir }) => {
    try {
      console.log(`[Docker] Executing: ${command}${workDir ? ` in ${workDir}` : ""}`);
      
      const fullCommand = workDir ? `cd ${workDir} && ${command}` : command;
      const { stdout, stderr } = await execAsync(fullCommand);
      
      return `Output:
${stdout}${stderr ? `
Errors:
${stderr}` : ""}`;
    } catch (error: any) {
      return `Docker command failed: ${error.message}
Output: ${error.stdout}
Errors: ${error.stderr}`;
    }
  },
});
