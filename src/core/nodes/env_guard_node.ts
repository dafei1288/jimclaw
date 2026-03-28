import * as fs from "fs/promises";
import * as path from "path";
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
