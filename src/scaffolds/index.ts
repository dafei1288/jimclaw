/**
 * Scaffold 注册中心
 *
 * 使用方式：
 *   import { initScaffolds, findScaffoldProvider } from "./scaffolds";
 *   initScaffolds();  // 注册所有内置 provider
 *   const provider = findScaffoldProvider("python", "fastapi");
 */

import {
  registerScaffoldProvider,
  findScaffoldProvider,
  getScaffoldProviderById,
  getAllScaffoldProviders,
  inferTemplateId,
} from "./types";
import expressTsProvider from "./express_typescript";
import fastApiPythonProvider from "./fastapi_python";
import "./gin_go"; // side-effect: auto-registers
import "./spring_java"; // side-effect: auto-registers
import "./axum_rust"; // side-effect: auto-registers

let initialized = false;

export function initScaffolds(): void {
  if (initialized) return;
  registerScaffoldProvider(expressTsProvider);
  registerScaffoldProvider(fastApiPythonProvider);
  initialized = true;
  console.log(`[Scaffolds] 已注册 ${getAllScaffoldProviders().length} 个 scaffold provider: ${getAllScaffoldProviders().map((p) => p.id).join(", ")}`);
}

// 绑定 Express/TS provider 的 generate 函数
// （延迟绑定，因为函数在 logic_utils.ts 中定义）
export function bindExpressTsGenerate(
  fn: (ctx: import("./types").ScaffoldContext, target: string) => string | null
): void {
  expressTsProvider.setGenerateFn(fn);
}

// 重导出
export {
  findScaffoldProvider,
  getScaffoldProviderById,
  getAllScaffoldProviders,
  inferTemplateId,
};
export type { ScaffoldProvider, ScaffoldContext } from "./types";
