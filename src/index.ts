import { Team } from "./agents/team";
import { createJimClawGraph } from "./core/graph";
import { loadCheckpointSnapshot, prepareReplayStateFromCheckpoint } from "./core/logic_utils";
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

async function main() {
  // 改进 7：支持 --clean flag 仅清理不跑任务
  if (process.argv[2] === "--clean") {
    await cleanWorkspace();
    return;
  }

  if (process.argv[2] === "--replay") {
    const workspacePath = process.argv[3];
    const checkpointId = process.argv[4];
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
    return;
  }

  const userGoal = process.argv[2] || "a simple Counter app with increment and decrement";
  console.log(`🚀 Starting JimClaw: Multi-Agent Collaboration Session for goal: "${userGoal}"`);

  // 1. 初始化协作图
  const app = await createJimClawGraph(Team);

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
    },
    { recursionLimit: 500 }
  );

  console.log(`\n--- Session Completed ---`);
  console.log("Final Code Content:", finalState.code);
  console.log("\nTeam Conversation History:");
  finalState.teamChatLog.forEach((log: any) => {
    console.log(`[${log.sender}]: ${log.content}`);
  });
}

main().catch(console.error);
