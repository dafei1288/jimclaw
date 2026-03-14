import { z } from "zod";
import * as fs from "fs/promises";
import { Skill } from "../core/skill";

/**
 * 读取本地文件的 Skill
 */
export const FileReadSkill = new Skill({
  name: "read_file",
  description: "Read the content of a file from the local file system.",
  schema: z.object({
    path: z.string().describe("The path to the file to read."),
  }),
  run: async ({ path }) => {
    try {
      const content = await fs.readFile(path, "utf-8");
      return content;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return `[系统提示]: 文件 "${path}" 尚未创建或不存在。如果该文件是你在本轮任务中需要生成的依赖文件，请根据 [接口契约 (ApiContract)] 和 [技术规范 (TechSpec)] 直接进行编码，不要尝试读取它。`;
      }
      return `[错误]: 无法读取文件 ${path}: ${error.message}`;
    }
  },
});
