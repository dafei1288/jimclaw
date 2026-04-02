import { Team } from "./agents/team";
import { createJimClawGraph } from "./core/graph";
import { buildCustomerApprovalState, buildReplayStateFromSnapshot, buildResumeStateFromCurrentSnapshot, loadCheckpointSnapshot, prepareReplayStateFromCheckpoint } from "./core/logic_utils";
import { ModelManager } from "./utils/models";
import * as fs from "fs/promises";
import * as path from "path";

// 改进 7：清理 workspace，保留最新 10 个 run 目录
async function cleanWorkspace() {
  const workspaceDir = path.join(process.cwd(), "workspace");
  try {
    const entries = await fs.readdir(workspaceDir);
    const runDirs = entries.filter((d) => d.startsWith("run_")).sort();
    const toDelete = runDirs.slice(0, Math.max(0, runDirs.length - 10));
    for (const dir of toDelete) {
      await fs.rm(path.join(workspaceDir, dir), { recursive: true, force: true });
    }
    console.log(`保留最新10个run，已清理${Math.max(0, runDirs.length - 10)}个`);
  } catch (e: any) {
    if (e.code === "ENOENT") {
      console.log("workspace 目录不存在，无需清理。");
    } else {
      console.error("清理 workspace 失败:", e);
    }
  }
}

export function computeSessionExitCode(finalState: any): number {
  if (finalState?.requiresApproval || finalState?.pendingApprovalStage) {
    return 2;
  }
  if (finalState?.agentRecoveryPending) {
    return 3;
  }
  const deploymentFailed = finalState?.deploymentStatus?.status === "failed";
  const hasRecordedFailure = Boolean(finalState?.lastFailedNode || finalState?.lastFailureSummary);
  const incomplete = finalState?.isDone === false && deploymentFailed;
  return deploymentFailed || hasRecordedFailure || incomplete ? 1 : 0;
}

export function parseAutoApproveArg(raw?: string | null) {
  const normalized = String(raw || "").trim().toLowerCase();
  const result = { requirements: false, solution: false, deploy: false };
  if (!normalized) return result;
  if (normalized === "all") {
    return { requirements: true, solution: true, deploy: true };
  }

  for (const token of normalized.split(",").map((item) => item.trim()).filter(Boolean)) {
    if (token === "requirements") result.requirements = true;
    if (token === "solution") result.solution = true;
    if (token === "deploy") result.deploy = true;
  }
  return result;
}

export interface RunSnapshotSummary {
  workspacePath: string;
  node: string;
  isDone: boolean;
  completedSubTasks: number;
  totalSubTasks: number;
  requiresApproval: boolean;
  pendingApprovalStage?: string;
  agentRecoveryPending: boolean;
  deploymentStatus?: string;
  lastFailedNode?: string;
  lastFailureSummary?: string;
}

export function summarizeRunSnapshot(workspacePath: string, snapshot: any): RunSnapshotSummary {
  const state = snapshot?.state || {};
  const subTasks = Array.isArray(state.subTasks) ? state.subTasks : [];
  const completedSubTasks = subTasks.filter((task: any) => task?.status === "completed").length;
  return {
    workspacePath,
    node: String(snapshot?.node || ""),
    isDone: state.isDone === true,
    completedSubTasks,
    totalSubTasks: subTasks.length,
    requiresApproval: state.requiresApproval === true,
    pendingApprovalStage: state.pendingApprovalStage || "",
    agentRecoveryPending: state.agentRecoveryPending === true,
    deploymentStatus: state.deploymentStatus?.status || "",
    lastFailedNode: state.lastFailedNode || "",
    lastFailureSummary: state.lastFailureSummary || "",
  };
}

export function isRunTerminal(summary: RunSnapshotSummary): boolean {
  if (summary.isDone) return true;
  if (summary.requiresApproval) return true;
  if (summary.agentRecoveryPending) return true;
  if (summary.deploymentStatus === "failed") return true;
  if (summary.lastFailedNode && summary.lastFailureSummary) return true;
  return false;
}

async function resolveLatestRunPath(): Promise<string> {
  const workspaceDir = path.join(process.cwd(), "workspace");
  const entries = await fs.readdir(workspaceDir, { withFileTypes: true });
  const runDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run_"))
    .map((entry) => path.join(workspaceDir, entry.name));
  if (!runDirs.length) {
    throw new Error("workspace 下没有可观察的 run_* 目录。");
  }
  const sorted = await Promise.all(
    runDirs.map(async (dir) => ({
      dir,
      stat: await fs.stat(dir),
      hasSnapshot: await fs.access(path.join(dir, "boulder.json")).then(() => true).catch(() => false),
    }))
  );
  sorted.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const withSnapshot = sorted.find((item) => item.hasSnapshot);
  return (withSnapshot || sorted[0]).dir;
}

async function watchRun(workspacePath: string, options?: { intervalMs?: number; maxWaitMs?: number }) {
  const intervalMs = Math.max(500, Number(options?.intervalMs || 3000));
  const maxWaitMs = Math.max(intervalMs, Number(options?.maxWaitMs || 30 * 60 * 1000));
  const startedAt = Date.now();
  let lastKey = "";

  while (Date.now() - startedAt <= maxWaitMs) {
    let snapshot: any;
    try {
      snapshot = await loadCurrentWorkspaceState(workspacePath);
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        console.log(`[watch] 等待快照文件生成: ${workspacePath}\\boulder.json`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }
      throw error;
    }
    const summary = summarizeRunSnapshot(workspacePath, snapshot);
    const key = [
      summary.node,
      summary.completedSubTasks,
      summary.totalSubTasks,
      summary.lastFailedNode,
      summary.lastFailureSummary,
      summary.requiresApproval,
      summary.pendingApprovalStage,
      summary.agentRecoveryPending,
      summary.isDone,
      summary.deploymentStatus,
    ].join("|");

    if (key !== lastKey) {
      lastKey = key;
      console.log(
        `[watch] node=${summary.node} progress=${summary.completedSubTasks}/${summary.totalSubTasks} ` +
        `done=${summary.isDone} approval=${summary.requiresApproval ? summary.pendingApprovalStage || "pending" : "none"} ` +
        `recovery=${summary.agentRecoveryPending} failedNode=${summary.lastFailedNode || "-"}`
      );
      if (summary.lastFailureSummary) {
        console.log(`[watch] failure=${summary.lastFailureSummary}`);
      }
    }

    if (isRunTerminal(summary)) {
      console.log(`[watch] 终态已到达: ${summary.workspacePath}`);
      process.exitCode = computeSessionExitCode(snapshot.state || {});
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`watch 超时（>${maxWaitMs}ms），尚未观测到终态。workspace=${workspacePath}`);
}

function markApprovalApprovedForResume(state: any, stage: "requirements" | "solution" | "deploy") {
  const customerApprovalState = state?.customerApprovalState;
  if (!customerApprovalState?.checkpoints) {
    throw new Error("当前 run 缺少 customerApprovalState，无法恢复审批。");
  }
  return {
    ...state,
    requiresApproval: false,
    pendingApprovalStage: stage,
    resumeFromNode: "approval",
    customerApprovalState: {
      ...customerApprovalState,
      checkpoints: customerApprovalState.checkpoints.map((checkpoint: any) =>
        checkpoint.stage === stage
          ? {
              ...checkpoint,
              approved: true,
              approvedBy: "customer",
              timestamp: new Date().toLocaleString("zh-CN"),
            }
          : checkpoint
      ),
    },
  };
}

async function loadCurrentWorkspaceState(workspacePath: string) {
  const raw = await fs.readFile(path.join(workspacePath, "boulder.json"), "utf-8");
  const snapshot = JSON.parse(raw);
  return snapshot;
}

async function main() {
  const args = process.argv.slice(2);

  // 改进 7：支持 --clean flag 仅清理不跑任务
  if (args[0] === "--clean") {
    await cleanWorkspace();
    return;
  }

  if (args[0] === "--replay") {
    const workspacePath = args[1];
    const checkpointId = args[2];
    if (!workspacePath || !checkpointId) {
      throw new Error("用法: npx ts-node src/index.ts --replay <workspacePath> <checkpointId>");
    }

    const snapshot = await loadCheckpointSnapshot(workspacePath, checkpointId);
    const replayState = prepareReplayStateFromCheckpoint(snapshot);

    console.log(`🚀 Starting JimClaw Replay Session from ${checkpointId}`);
    console.log(`Resume Path: ${snapshot.node} -> ${replayState.resumeFromNode}`);

    const app = await createJimClawGraph(Team, undefined, {
      workspacePath,
      traceId: snapshot.traceId,
    });
    const finalState = await app.invoke(replayState, { recursionLimit: 500 });

    console.log(`\n--- Replay Session Completed ---`);
    console.log("Final Code Content:", finalState.code);
    process.exitCode = computeSessionExitCode(finalState);
    return;
  }

  if (args[0] === "--approve") {
    const workspacePath = args[1];
    if (!workspacePath) {
      throw new Error("用法: npx ts-node src/index.ts --approve <workspacePath>");
    }

    const snapshot = await loadCurrentWorkspaceState(workspacePath);
    const replayState = buildReplayStateFromSnapshot(snapshot.state || {});
    const stage = replayState.pendingApprovalStage;
    if (!stage) {
      throw new Error("当前 run 没有待确认的审批阶段。");
    }

    const resumedState = markApprovalApprovedForResume(replayState, stage);
    console.log(`🚀 Resuming approval for stage: ${stage}`);
    const app = await createJimClawGraph(Team, undefined, {
      workspacePath,
      traceId: snapshot.traceId,
    });
    const finalState = await app.invoke(resumedState, { recursionLimit: 500 });
    console.log(`\n--- Approval Resume Completed ---`);
    console.log("Final Code Content:", finalState.code);
    process.exitCode = computeSessionExitCode(finalState);
    return;
  }

  if (args[0] === "--resume") {
    const workspacePath = args[1];
    if (!workspacePath) {
      throw new Error("用法: npx ts-node src/index.ts --resume <workspacePath>");
    }

    const snapshot = await loadCurrentWorkspaceState(workspacePath);
    const resumedState = {
      ...buildResumeStateFromCurrentSnapshot(snapshot),
      agentRecoveryPending: false,
      agentRecoveryReason: "",
      agentRecoveryNode: "",
    };
    console.log(`🚀 Resuming session from node: ${resumedState.resumeFromNode}`);
    const app = await createJimClawGraph(Team, undefined, {
      workspacePath,
      traceId: snapshot.traceId,
    });
    const finalState = await app.invoke(resumedState, { recursionLimit: 500 });
    console.log(`\n--- Resume Completed ---`);
    console.log("Final Code Content:", finalState.code);
    process.exitCode = computeSessionExitCode(finalState);
    return;
  }

  if (args[0] === "--watch" || args[0] === "--watch-latest") {
    const intervalIndex = args.indexOf("--interval-ms");
    const maxWaitIndex = args.indexOf("--max-wait-ms");
    const intervalMs = intervalIndex >= 0 ? Number(args[intervalIndex + 1] || 0) : undefined;
    const maxWaitMs = maxWaitIndex >= 0 ? Number(args[maxWaitIndex + 1] || 0) : undefined;
    const workspacePath = args[0] === "--watch-latest" ? await resolveLatestRunPath() : args[1];
    if (!workspacePath) {
      throw new Error("用法: npx ts-node src/index.ts --watch <workspacePath> [--interval-ms 3000] [--max-wait-ms 1800000]");
    }
    console.log(`🔎 观察 run 状态: ${workspacePath}`);
    await watchRun(workspacePath, { intervalMs, maxWaitMs });
    return;
  }

  let autoApprove = { requirements: false, solution: false, deploy: false };
  const autoApproveIndex = args.indexOf("--auto-approve");
  if (autoApproveIndex >= 0) {
    autoApprove = parseAutoApproveArg(args[autoApproveIndex + 1] || "all");
    args.splice(autoApproveIndex, Math.min(2, args.length - autoApproveIndex));
  }

  const userGoal = args[0] || "a simple Counter app with increment and decrement";
  console.log(`🚀 Starting JimClaw: Multi-Agent Collaboration Session for goal: "${userGoal}"`);
  const workspacePath = path.join(process.cwd(), "workspace", `run_${Date.now()}`);
  const globalConfig = ModelManager.getGlobalConfig?.() || {};
  const coderMaxParallel = Number(globalConfig?.coderMaxParallel || 1);
  const coderExperimentalModelParallel = Boolean(globalConfig?.coderExperimentalModelParallel);

  // 1. 初始化协作图
  const app = await createJimClawGraph(Team, undefined, { workspacePath });

  // 2. 运行图
  const finalState = await app.invoke(
    {
      userGoal,
      messages: [],
      teamChatLog: [],
      retryCount: 0,
      isDone: false,
      contract: null,
      spec: null,
      code: "",
      testResults: "",
      qaFailures: null,
      packageJsonHash: "",
      customerApprovalState: buildCustomerApprovalState({ autoApprove }),
      coderMaxParallel: Number.isFinite(coderMaxParallel) ? Math.max(1, Math.min(4, Math.floor(coderMaxParallel))) : 1,
      coderExperimentalModelParallel,
    },
    { recursionLimit: 500 }
  );

  console.log(`\n--- Session Completed ---`);
  console.log("Final Code Content:", finalState.code);
  console.log("\nTeam Conversation History:");
  finalState.teamChatLog.forEach((log: any) => {
    console.log(`[${log.sender}]: ${log.content}`);
  });
  if (finalState.requiresApproval && finalState.pendingApprovalStage) {
    console.log(`\nSession Paused: 等待 ${finalState.pendingApprovalStage} 阶段确认`);
    console.log(`Workspace: ${workspacePath}`);
    console.log(`Resume Command: npx ts-node src/index.ts --approve "${workspacePath}"`);
  }
  if (finalState.agentRecoveryPending) {
    console.log(`\nSession Paused: 等待模型服务恢复`);
    console.log(`Node: ${finalState.agentRecoveryNode || "unknown"}`);
    console.log(`Reason: ${finalState.agentRecoveryReason || finalState.lastFailureSummary || "模型服务暂不可用"}`);
    console.log(`Workspace: ${workspacePath}`);
    console.log(`Resume Command: npx ts-node src/index.ts --resume "${workspacePath}"`);
  }
  process.exitCode = computeSessionExitCode(finalState);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
