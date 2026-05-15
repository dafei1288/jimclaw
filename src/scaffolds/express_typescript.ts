/**
 * Express + TypeScript Scaffold Provider
 *
 * 包装 logic_utils.ts 中现有的 getDeterministicTemplateScaffold 逻辑。
 * 不改变任何现有行为，只提供 ScaffoldProvider 接口适配。
 */

import type { ScaffoldProvider, ScaffoldContext } from "./types";

class ExpressTypeScriptProvider implements ScaffoldProvider {
  id = "express-typescript";
  language = "typescript";
  frameworks = ["express", "express.js"];

  canHandle(_ctx: ScaffoldContext, _normalizedTarget: string): boolean {
    // Express/TS 可以处理所有文件类型
    return true;
  }

  // generate() 由外部注入，因为实际逻辑在 logic_utils.ts
  private _generate: ((ctx: ScaffoldContext, target: string) => string | null) | null = null;

  setGenerateFn(fn: (ctx: ScaffoldContext, target: string) => string | null): void {
    this._generate = fn;
  }

  generate(ctx: ScaffoldContext, normalizedTarget: string): string | null {
    if (!this._generate) return null;
    return this._generate(ctx, normalizedTarget);
  }

  fileExtensions(): string[] {
    return [".ts", ".tsx", ".js", ".jsx"];
  }

  testCommand(_spec: any): string {
    return "npm test";
  }

  runCommand(_spec: any, port: number): string {
    return `node dist/src/index.js`;
  }

  baseDockerImage(): string {
    return "node:20-alpine";
  }

  installCommand(_spec: any): string {
    return "npm install";
  }

  entryFilePath(_spec: any): string {
    return "src/index.ts";
  }

  testFilePattern(): string {
    return "**/*.test.ts";
  }

  priority(): number {
    return 10;
  }
}

// 单例
const expressTsProvider = new ExpressTypeScriptProvider();
export default expressTsProvider;
