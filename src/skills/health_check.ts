import { z } from "zod";
import { Skill } from "../core/skill";
import axios from "axios";

/**
 * 健康检查 Skill: 轮询指定的 URL 直到返回 200 或超时
 */
export const HealthCheckSkill = new Skill({
  name: "health_check",
  description: "Poll a URL until it returns 200 OK or times out.",
  schema: z.object({
    url: z.string().describe("The URL to check (e.g., 'http://localhost:3000/health')."),
    timeoutMs: z.number().optional().default(30000).describe("Timeout in milliseconds."),
    intervalMs: z.number().optional().default(2000).describe("Interval between checks in milliseconds."),
  }),
  run: async ({ url, timeoutMs, intervalMs }) => {
    const start = Date.now();
    console.log(`[HealthCheck] Polling ${url}...`);
    
    while (Date.now() - start < timeoutMs) {
      try {
        const response = await axios.get(url, { timeout: 1000, validateStatus: () => true });
        if (response.status === 200) {
          return `Success: ${url} is ready (HTTP 200).`;
        }
      } catch (error: any) {
        // Wait and retry
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    
    return `Failure: ${url} did not become ready within ${timeoutMs}ms.`;
  },
});
