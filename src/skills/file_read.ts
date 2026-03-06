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
      throw new Error(`Could not read file at ${path}: ${error.message}`);
    }
  },
});
