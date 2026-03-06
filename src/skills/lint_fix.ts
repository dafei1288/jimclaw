import { Skill } from "../core/skill";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";

const execPromise = promisify(exec);

/**
 * PolyglotLintFixSkill: 多语言自动化代码规范修复技能
 */
export const LintFixSkill = new Skill({
  name: "lint_fix",
  description: "根据文件类型自动修复代码规范和格式问题（支持 TS, JS, Python, Go, JSON, MD 等）。",
  schema: z.object({
    file_path: z.string().describe("需要修复规范的文件路径"),
  }),
  run: async (args) => {
    const { file_path } = args;
    const fullPath = path.resolve(process.cwd(), file_path);
    const ext = path.extname(file_path).toLowerCase();

    try {
      let command = "";
      switch (ext) {
        case ".ts":
        case ".tsx":
        case ".js":
        case ".jsx":
          // JS/TS: Prettier + ESLint
          await execPromise(`npx prettier --write "${fullPath}"`);
          try {
            await execPromise(`npx eslint --fix "${fullPath}"`);
          } catch (e: any) {
            if (e.code !== 1) throw e;
          }
          return `文件 ${file_path} (JS/TS) 已完成格式化和规范修复。`;

        case ".py":
          // Python: Ruff (extremely fast)
          await execPromise(`ruff format "${fullPath}"`);
          await execPromise(`ruff check --fix "${fullPath}"`);
          return `文件 ${file_path} (Python) 已使用 ruff 完成格式化和规范修复。`;

        case ".go":
          // Go: gofmt
          await execPromise(`gofmt -w "${fullPath}"`);
          return `文件 ${file_path} (Go) 已使用 gofmt 完成格式化。`;

        case ".json":
        case ".md":
        case ".yml":
        case ".yaml":
          // Common files: Prettier
          await execPromise(`npx prettier --write "${fullPath}"`);
          return `文件 ${file_path} 已使用 prettier 完成格式化。`;

        default:
          return `未找到文件后缀 ${ext} 的对应规范工具，跳过修复。`;
      }
    } catch (error: any) {
      return `修复规范时出错 (${file_path}): ${error.message}`;
    }
  },
});
