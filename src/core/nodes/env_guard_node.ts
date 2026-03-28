import * as fs from "fs/promises";
import * as path from "path";
import { builtinModules } from "module";
import { JimClawState, RepairLedgerEntry, ConsensusProgress } from "../graph_types";
import { ShellExecuteSkill } from "../../skills/shell_exec";
import { AuditLogger } from "../../utils/audit";
import { getDeterministicTemplateScaffold } from "../logic_utils";

function isNodeLikeProject(language?: string): boolean {
  const lang = String(language || "").toLowerCase();
  return /typescript|javascript|node/.test(lang);
}

function toolFailed(output: string): boolean {
  return /Command failed|npm error|ERR!/i.test(output || "");
}

function truncateForLog(s: string, max = 1200): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}\n...(truncated)` : s;
}

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((item) => `node:${item}`)]);
const KNOWN_DEP_VERSIONS: Record<string, string> = {
  express: "^4.18.2",
  cors: "^2.8.5",
  jsonwebtoken: "^9.0.2",
  uuid: "^9.0.1",
  bcryptjs: "^2.4.3",
  morgan: "^1.10.0",
  helmet: "^7.1.0",
  "rate-limiter-flexible": "^5.0.5",
  supertest: "^7.1.1",
  jest: "^29.7.0",
  "ts-jest": "^29.1.1",
  typescript: "^5.3.3",
  "ts-node": "^10.9.2",
};

function isTrackedSourceFile(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath);
}

function isDevOnlyFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return normalized.startsWith("tests/")
    || normalized.includes("/__tests__/")
    || /\.test\.[tj]sx?$/.test(normalized)
    || /\.spec\.[tj]sx?$/.test(normalized)
    || /jest\.config\./.test(normalized)
    || normalized.startsWith("scripts/");
}

function normalizePackageName(raw: string): string {
  if (!raw || raw.startsWith(".") || raw.startsWith("/") || NODE_BUILTINS.has(raw)) return "";
  if (raw.startsWith("@")) {
    const parts = raw.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : raw;
  }
  return raw.split("/")[0];
}

function collectImportedPackages(filePath: string, content: string): Array<{ packageName: string; devOnly: boolean }> {
  const found = new Map<string, boolean>();
  const devOnly = isDevOnlyFile(filePath);
  const patterns = [
    /import\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /export\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const packageName = normalizePackageName(match[1]);
      if (!packageName) continue;
      const current = found.get(packageName);
      found.set(packageName, current === undefined ? devOnly : current && devOnly);
    }
  }
  return Array.from(found.entries()).map(([packageName, fileDevOnly]) => ({ packageName, devOnly: fileDevOnly }));
}

async function listTrackedFiles(workspace: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (relativeDir: string) => {
    const absoluteDir = path.join(workspace, relativeDir);
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true }) as Array<{ name: string; isDirectory: () => boolean }>;
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const relativePath = relativeDir ? path.posix.join(relativeDir.replace(/\\/g, "/"), entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(relativePath);
      } else if (isTrackedSourceFile(relativePath)) {
        results.push(relativePath.replace(/\\/g, "/"));
      }
    }
  };
  await walk("");
  return results;
}

function resolveDependencyVersion(
  packageName: string,
  state: JimClawState,
  kind: "dependencies" | "devDependencies"
): string {
  return state.spec?.[kind]?.[packageName]
    || state.spec?.dependencies?.[packageName]
    || state.spec?.devDependencies?.[packageName]
    || KNOWN_DEP_VERSIONS[packageName]
    || "latest";
}

async function closePackageDependencyGaps(
  workspace: string,
  state: JimClawState
): Promise<{ changed: boolean; actions: string[]; code?: string }> {
  const pkgPath = path.join(workspace, "package.json");
  const raw = await fs.readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(raw || "{}");
  const actions: string[] = [];
  const filesContent: Record<string, string> = JSON.parse(state.code || "{}");
  const trackedFiles = new Set<string>([
    ...Object.keys(filesContent).filter(isTrackedSourceFile),
    ...(await listTrackedFiles(workspace)),
  ]);

  const runtimeDeps = { ...(pkg.dependencies || {}) } as Record<string, string>;
  const devDeps = { ...(pkg.devDependencies || {}) } as Record<string, string>;
  let changed = false;

  for (const filePath of trackedFiles) {
    const absolutePath = path.join(workspace, filePath);
    const content = filesContent[filePath] ?? await fs.readFile(absolutePath, "utf-8").catch(() => "");
    if (!content) continue;
    for (const imported of collectImportedPackages(filePath, content)) {
      if (imported.devOnly) {
        if (!runtimeDeps[imported.packageName] && !devDeps[imported.packageName]) {
          devDeps[imported.packageName] = resolveDependencyVersion(imported.packageName, state, "devDependencies");
          actions.push(`补齐测试依赖 ${imported.packageName} -> devDependencies`);
          changed = true;
        }
        continue;
      }

      if (devDeps[imported.packageName] && !runtimeDeps[imported.packageName]) {
        runtimeDeps[imported.packageName] = devDeps[imported.packageName];
        delete devDeps[imported.packageName];
        actions.push(`移动运行时依赖 ${imported.packageName} 到 dependencies`);
        changed = true;
        continue;
      }

      if (!runtimeDeps[imported.packageName]) {
        runtimeDeps[imported.packageName] = resolveDependencyVersion(imported.packageName, state, "dependencies");
        actions.push(`补齐运行时依赖 ${imported.packageName} -> dependencies`);
        changed = true;
      }
    }
  }

  if (!changed) {
    return { changed: false, actions };
  }

  pkg.dependencies = runtimeDeps;
  pkg.devDependencies = devDeps;
  const nextContent = `${JSON.stringify(pkg, null, 2)}\n`;
  await fs.writeFile(pkgPath, nextContent, "utf-8");
  filesContent["package.json"] = nextContent;
  return {
    changed: true,
    actions,
    code: JSON.stringify(filesContent, null, 2),
  };
}

async function normalizePackageJson(workspace: string): Promise<{ changed: boolean; actions: string[] }> {
  const pkgPath = path.join(workspace, "package.json");
  const raw = await fs.readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(raw || "{}");
  const actions: string[] = [];

  const dependencies = { ...(pkg.dependencies || {}) } as Record<string, string>;
  const devDependencies = { ...(pkg.devDependencies || {}) } as Record<string, string>;
  let changed = false;

  for (const dep of Object.keys(dependencies)) {
    if (dep.startsWith("@types/")) {
      devDependencies[dep] = dependencies[dep];
      delete dependencies[dep];
      changed = true;
      actions.push(`移动 ${dep} 到 devDependencies`);
    }
  }

  if ("@types/mongoose" in devDependencies) {
    delete devDependencies["@types/mongoose"];
    changed = true;
    actions.push("移除无效依赖 @types/mongoose");
  }

  if (changed) {
    pkg.dependencies = dependencies;
    pkg.devDependencies = devDependencies;
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  }

  return { changed, actions };
}

async function ensureBootstrapScaffold(
  workspace: string,
  state: JimClawState
): Promise<{
  changed: boolean;
  code?: string;
  subTasks?: JimClawState["subTasks"];
  consensusProgress?: ConsensusProgress;
  actions: string[];
}> {
  const bootstrapTargets = ["package.json", "tsconfig.json", "jest.config.cjs", "tests/setup.test.ts"];
  const filesContent: Record<string, string> = JSON.parse(state.code || "{}");
  const subTasks = [...(state.subTasks || [])];
  const actions: string[] = [];
  let changed = false;

  for (const fileTarget of bootstrapTargets) {
    const deterministicContent = getDeterministicTemplateScaffold(state, fileTarget);
    if (!deterministicContent) continue;

    const absolutePath = path.join(workspace, fileTarget);
    let fileExists = true;
    try {
      await fs.access(absolutePath);
    } catch {
      fileExists = false;
    }

    if (!fileExists) {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, deterministicContent, "utf-8");
      filesContent[fileTarget] = deterministicContent;
      const relatedTask = subTasks.find((task) => task.fileTarget === fileTarget);
      if (relatedTask) {
        relatedTask.status = "completed";
        delete relatedTask.lastError;
      }
      actions.push(`写入模板骨架 ${fileTarget}`);
      changed = true;
    } else if (filesContent[fileTarget] === undefined) {
      const existing = await fs.readFile(absolutePath, "utf-8");
      filesContent[fileTarget] = existing;
      changed = true;
    }
  }

  if (!changed) {
    return { changed: false, actions };
  }

  const completedFiles = subTasks.filter((task) => task.status === "completed").map((task) => task.fileTarget);
  const pendingFiles = subTasks.filter((task) => task.status !== "completed").map((task) => task.fileTarget);
  return {
    changed: true,
    code: JSON.stringify(filesContent, null, 2),
    subTasks,
    consensusProgress: {
      completedFiles,
      pendingFiles,
      currentRound: state.retryCount || 0,
      openIssues: state.consensusProgress?.openIssues || [],
    },
    actions,
  };
}

/**
 * Env Guard 节点：在 infra 前做环境预检与确定性修复，避免环境问题进入 coder 自旋
 */
export async function envGuardNode(
  state: JimClawState,
  agents: any,
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("env_guard");
  emit("phase-change", "System", "environment");

  const round = state.retryCount || 0;
  const ledger: RepairLedgerEntry[] = [];

  if (!isNodeLikeProject(state.spec?.language)) {
    return { envReady: true, blockedReason: "", recoveredEnvironment: false };
  }

  const pkgPath = path.join(WORKSPACE, "package.json");
  let bootstrapPatch: Partial<JimClawState> = {};
  try {
    await fs.access(pkgPath);
  } catch {
    const bootstrap = await ensureBootstrapScaffold(WORKSPACE, state);
    if (bootstrap.changed) {
      bootstrapPatch = {
        code: bootstrap.code,
        subTasks: bootstrap.subTasks,
        consensusProgress: bootstrap.consensusProgress,
      };
      ledger.push({ round, phase: "env_guard", action: bootstrap.actions.join("；"), result: "success" });
      await AuditLogger.log(WORKSPACE, "Environment", `### [Env Guard Bootstrap]\n\n**Action:** ${bootstrap.actions.join("；")}`);
    }
  }

  try {
    await fs.access(pkgPath);
  } catch {
    const reason = "[EnvGuard] 缺少 package.json，无法安装依赖。";
    ledger.push({ round, phase: "env_guard", action: "检查 package.json", result: "failed" });
    await saveBoulder({ ...state, ...bootstrapPatch, envReady: false, blockedReason: reason, repairLedger: ledger }, "env_guard_missing_pkg");
    return { ...bootstrapPatch, envReady: false, blockedReason: reason, repairLedger: ledger, testResults: `${state.testResults || ""}\n${reason}`.trim() };
  }

  try {
    const closureResult = await closePackageDependencyGaps(WORKSPACE, { ...state, ...bootstrapPatch } as JimClawState);
    if (closureResult.changed) {
      bootstrapPatch = {
        ...bootstrapPatch,
        code: closureResult.code,
      };
      const actionText = closureResult.actions.join("；");
      ledger.push({ round, phase: "env_guard", action: actionText, result: "success" });
      await AuditLogger.log(WORKSPACE, "Environment", `**Action:** ${actionText}`);
    }

    const normalized = await normalizePackageJson(WORKSPACE);
    if (normalized.changed) {
      const actionText = normalized.actions.join("；");
      ledger.push({ round, phase: "env_guard", action: actionText, result: "success" });
      await AuditLogger.log(WORKSPACE, "Environment", `**Action:** ${actionText}`);
    }

    await AuditLogger.log(WORKSPACE, "Environment", `### [Env Guard]\n\n**Action:** npm install --silent`);
    let installOut = await ShellExecuteSkill.config.run({ command: `cd ${WORKSPACE} && npm install --silent`, timeout: 300000 });
    await AuditLogger.log(WORKSPACE, "Environment", `**Install Output:**\n${truncateForLog(installOut)}`);

    if (toolFailed(installOut) && /No matching version found for @types\/mongoose@|ETARGET/i.test(installOut)) {
      const action = "检测到 ETARGET(@types/mongoose)，自动删除后重装依赖";
      await AuditLogger.log(WORKSPACE, "Environment", `**Auto Fix:** ${action}`);
      await ShellExecuteSkill.config.run({ command: `cd ${WORKSPACE} && npm pkg delete devDependencies.@types/mongoose`, timeout: 60000 });
      installOut = await ShellExecuteSkill.config.run({ command: `cd ${WORKSPACE} && npm install --silent`, timeout: 300000 });
      await AuditLogger.log(WORKSPACE, "Environment", `**Reinstall Output:**\n${truncateForLog(installOut)}`);
      ledger.push({ round, phase: "env_guard", action, result: toolFailed(installOut) ? "failed" : "success" });
    }

    if (toolFailed(installOut)) {
      const reason = `[EnvGuard] 依赖安装失败：\n${truncateForLog(installOut, 800)}`;
      ledger.push({ round, phase: "env_guard", action: "npm install --silent", result: "failed" });
      await saveBoulder({ ...state, ...bootstrapPatch, envReady: false, blockedReason: reason, repairLedger: ledger }, "env_guard_install_failed");
      return { ...bootstrapPatch, envReady: false, blockedReason: reason, repairLedger: ledger, testResults: `${state.testResults || ""}\n${reason}`.trim() };
    }

    ledger.push({ round, phase: "env_guard", action: "npm install --silent", result: "success" });
    const result = { ...bootstrapPatch, envReady: true, blockedReason: "", recoveredEnvironment: false, repairLedger: ledger };
    await saveBoulder({ ...state, ...result }, "env_guard_ready");
    return result;
  } catch (e: any) {
    const reason = `[EnvGuard] 环境预检异常：${e.message || e}`;
    ledger.push({ round, phase: "env_guard", action: "环境预检", result: "failed" });
    await saveBoulder({ ...state, ...bootstrapPatch, envReady: false, blockedReason: reason, repairLedger: ledger }, "env_guard_exception");
    return { ...bootstrapPatch, envReady: false, blockedReason: reason, repairLedger: ledger, testResults: `${state.testResults || ""}\n${reason}`.trim() };
  }
}
