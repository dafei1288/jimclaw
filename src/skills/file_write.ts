import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { Skill } from "../core/skill";

/**
 * 写文件的 Skill: 支持自动创建目录
 */
export const FileWriteSkill = new Skill({
  name: "write_file",
  description: "Write or overwrite a file with specified content. Creates directories if they don't exist.",
  schema: z.object({
    filePath: z.string().describe("The relative path to the file from the workspace root."),
    content: z.string().describe("The full content to write into the file."),
  }),
  run: async ({ filePath, content }) => {
    try {
      // 鲁棒性改进：如果 content 中包含 Markdown 代码块（如 ```python ... ```），只提取代码内容
      let cleanContent = content;
      const codeBlockRegex = /```(?:\w+)?\s*\n([\s\S]*?)\n\s*```/g;
      const matches = Array.from(content.matchAll(codeBlockRegex));
      
      if (matches.length > 0) {
        // 如果有多个代码块，合并它们（通常一个文件只有一个，但这里做个通用处理）
        cleanContent = matches.map(m => m[1]).join("\n\n");
      } else {
        // 如果没有代码块标识符，尝试清理掉开头和结尾的空白
        cleanContent = content.trim();
      }

      // JSON Validate: If the file is a JSON file, ensure it parses correctly.
      if (filePath.endsWith('.json')) {
        try {
          JSON.parse(cleanContent);
        } catch (jsonError: any) {
          throw new Error(`Invalid JSON format for file ${filePath}: ${jsonError.message}. REMINDER: JSON files cannot contain JavaScript comments (// or /* */) or trailing commas.`);
        }
      }

      // 解析路径到当前 workspace（由 graph.ts 通过 JIMCLAW_WORKSPACE 注入）
      // 若未设置则拒绝写入，防止 Coder agent 向 workspace 外写入文件
      const workspaceRoot = process.env.JIMCLAW_WORKSPACE;
      if (!workspaceRoot) {
        throw new Error("JIMCLAW_WORKSPACE 未设置：禁止在 workspace 目录外写入文件。");
      }

      // 容错：agent 有时会传入绝对路径（含路径名拼写错误）
      // 若绝对路径在 workspace 内，转为相对路径；若在 workspace 外，拒绝写入
      let resolvedFilePath = filePath;
      if (path.isAbsolute(filePath)) {
        const normalizedFile = path.normalize(filePath);
        const normalizedRoot = path.normalize(workspaceRoot);
        if (normalizedFile.startsWith(normalizedRoot + path.sep) || normalizedFile === normalizedRoot) {
          resolvedFilePath = path.relative(workspaceRoot, normalizedFile);
        } else {
          throw new Error(`安全限制：绝对路径 "${filePath}" 不在 workspace 目录内，请使用相对路径。`);
        }
      }

      const absolutePath = path.resolve(workspaceRoot, resolvedFilePath);
      // 路径安全检查：防止 ../../../ 等路径穿越攻击
      if (!absolutePath.startsWith(workspaceRoot + path.sep) && absolutePath !== workspaceRoot) {
        throw new Error(`安全限制：不允许写入 workspace 目录外的路径 "${filePath}"。`);
      }
      const dirPath = path.dirname(absolutePath);

      // 递归创建目录
      await fs.mkdir(dirPath, { recursive: true });
      // 写入文件
      await fs.writeFile(absolutePath, cleanContent, "utf-8");

      return `Successfully wrote to ${filePath}`;
    } catch (error: any) {
      throw new Error(`Failed to write file: ${error.message}`);
    }
  },
});
