import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { Skill } from "../core/skill";
import * as path from "path";

const execAsync = promisify(exec);

/**
 * 鲁棒的多语言代码诊断技能
 */
export const LSPDiagnoseSkill = new Skill({
  name: "diagnose_code",
  description: "Check for syntax or type errors in a source file. Supports TS, JS, Python, and more.",
  schema: z.object({
    file_path: z.string().describe("The absolute or relative path to the file to check."),
  }),
  run: async ({ file_path }) => {
    const ext = path.extname(file_path).toLowerCase();
    
    try {
      switch (ext) {
        case ".ts":
        case ".tsx":
          // 优先尝试 tsc (非交互式，广泛存在)
          try {
            await execAsync(`npx tsc ${file_path} --noEmit --esModuleInterop --skipLibCheck`);
            return "[SUCCESS] No TypeScript errors found.";
          } catch (e: any) {
            return `[ERROR] TypeScript Error:\n${e.stdout || e.message}`;
          }

        case ".js":
        case ".jsx":
          // JS 简单语法检查
          try {
            await execAsync(`node --check ${file_path}`);
            return "[SUCCESS] JavaScript syntax is valid.";
          } catch (e: any) {
            return `[ERROR] JavaScript Syntax Error:\n${e.stderr || e.message}`;
          }

        case ".py":
          // Python 语法检查 (基于 compileall 或 ruff)
          try {
            await execAsync(`python3 -m py_compile ${file_path}`);
            return "[SUCCESS] Python syntax is valid.";
          } catch (e: any) {
            return `[ERROR] Python Syntax Error:\n${e.stderr || e.message}`;
          }

        default:
          return `[INFO] No specialized diagnostic for ${ext}. Skipping deep check.`;
      }
    } catch (globalError: any) {
      return `[WARNING] Diagnostic tool failed to run: ${globalError.message}`;
    }
  },
});
