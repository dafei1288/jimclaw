import { z } from "zod";
import { Skill } from "../core/skill";
import * as net from "net";

/**
 * 扫描并返回第一个未被占用的空闲端口
 */
export const FindFreePortSkill = new Skill({
  name: "find_free_port",
  description: "从指定起始端口扫描，返回第一个未被占用的空闲端口号字符串。默认从 4000 扫到 4999，避免与常用服务（3000 等）冲突。",
  schema: z.object({
    start_port: z.number().optional().default(4000).describe("起始端口（默认 4000）"),
    end_port: z.number().optional().default(4999).describe("最大扫描端口（默认 4999）"),
  }),
  run: async ({ start_port = 4000, end_port = 4999 }) => {
    const isPortFree = (port: number): Promise<boolean> =>
      new Promise((resolve) => {
        const server = net.createServer();
        server.once("error", () => resolve(false));
        server.once("listening", () => {
          server.close(() => resolve(true));
        });
        server.listen(port, "0.0.0.0");
      });

    for (let port = start_port; port <= end_port; port++) {
      if (await isPortFree(port)) {
        return String(port);
      }
    }

    return String(start_port); // 兜底
  },
});
