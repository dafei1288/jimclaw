import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { Team } from "./agents/team";
import { createJimClawGraph } from "./core/graph";
import { buildReplayStateFromSnapshot, loadCheckpointSnapshot, loadTraceIndex, prepareReplayStateFromCheckpoint } from "./core/logic_utils";
import { ModelManager } from "./utils/models";
import path from "path";
import * as fs from "fs/promises";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

const PORT = process.env.PORT || 3000;

function getModelName(model: any): string {
  try {
    if (!model) return "Unknown";
    // 优先尝试标准属性
    if (model.model) return model.model;
    if (model.modelName) return model.modelName;
    if (model.model_name) return model.model_name;

    // LangChain 内部结构
    if (model.lc_kwargs?.model) return model.lc_kwargs.model;
    if (model.lc_kwargs?.modelName) return model.lc_kwargs.modelName;
    if (model.lc_kwargs?.model_name) return model.lc_kwargs.model_name;

    // Provider 特定结构
    if (model.client?.model) return model.client.model; // Anthropic

    // 兜底方案：尝试从模型类名或字符串中寻找信息
    const str = String(model);
    if (str.includes("ChatOpenAI")) return "OpenAI Model";
    if (str.includes("ChatAnthropic")) return "Anthropic Model";
    if (str.includes("ChatOllama")) return "Ollama Model";
  } catch (e) {
    console.error("[Server] Error extracting model name:", e);
  }
  return "AI Model";
}

function getTeamInfo() {
  console.log("[Server] Generating team info...");
  try {
    const info = Object.entries(Team).map(([key, agent]) => {
      try {
        const modelsMap = agent.getModels();
        const models: Record<string, string> = {};
        if (modelsMap instanceof Map) {
          modelsMap.forEach((model, mode) => {
            models[mode] = getModelName(model);
          });
        }
        const persona = agent.getPersona();
        return {
          id: key,
          name: persona.name || "Unknown Agent",
          role: persona.role || "Agent",
          specialty: persona.specialty || "Generalist",
          personality: persona.personality || "",
          color: persona.color || "gray",
          model: models["default"] ?? "AI Model",
          models,
          };      } catch (err) {
        console.error(`[Server] Failed to initialize info for agent ${key}:`, err);
        return {
          id: key,
          name: "Error Agent",
          role: "Unknown",
          specialty: "Initialization Failed",
          personality: "",
          model: "Unknown",
          models: { default: "Unknown" },
        };
      }
    });
    console.log(`[Server] Successfully generated info for ${info.length} agents.`);
    return info;
  } catch (globalErr) {
    console.error("[Server] Critical error generating team info:", globalErr);
    return [];
  }
}

// 全局 Session 镜像 (用于页面刷新同步)
let currentSession: any = {
  userGoal: "",
  status: "Idle",
  currentPhase: "idle",
  phaseData: {}, // { requirement: { startTime, duration, status } }
  currentNode: "-",
  retryCount: 0,
  maxRetries: ModelManager.getGlobalConfig()?.maxRetries ?? 5, // 初始即使用配置
  logs: [],
  events: [],
  deployment: { status: "none", url: null },
  mediationDirectives: null,
  fixPlan: null,
  projectBrief: [],
  codeLog: [],
  consensusCore: null,
  consensusProgress: null,
  meetingNotes: [],
  lastFailedNode: "",
  lastFailureSummary: "",
  team: [], // 初始为空，由下方初始化
};

// 简单的静态文件服务
app.use(express.static(path.join(__dirname, "../public")));

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // 握手前确保 team 已加载（如果之前失败了）
  if (!currentSession.team || currentSession.team.length === 0) {
    currentSession.team = getTeamInfo();
  }

  // 握手：立即同步当前所有进度
  socket.emit("session-sync", currentSession);

  const createBaseGraphState = (userGoal: string, maxRetries: number) => ({
    userGoal,
    messages: [],
    teamChatLog: [],
    retryCount: 0,
    maxRetries,
    isDone: false,
    contract: null,
    spec: null,
    manifest: null,
    subTasks: [],
    code: "",
    testResults: "",
    qaFailures: null,
    issueTracker: [],
    mediationDirectives: null,
    fixPlan: null,
    projectBrief: [],
    codeLog: [],
    packageJsonHash: "",
  });

  const runGraphSession = async (
    latestTeam: any[],
    initialSession: any,
    initialGraphState: any,
    graphOptions?: { workspacePath?: string; traceId?: string }
  ) => {
    let trackedContainerId: string | null = null;
    try {
      currentSession = initialSession;

      const appGraph = await createJimClawGraph(Team, (event) => {
        if (event.type === "workspace-ready") {
          currentSession.workspacePath = event.metadata?.workspacePath || null;
          io.emit("workspace-ready", { path: currentSession.workspacePath });
        }
        if (event.type === "phase-change") {
          const newPhase = event.content;
          const oldPhase = currentSession.currentPhase;

          if (oldPhase && currentSession.phaseData[oldPhase]) {
            const phase = currentSession.phaseData[oldPhase];
            phase.endTime = Date.now();
            phase.totalDuration = (phase.totalDuration || 0) + (phase.endTime - phase.startTime);
            phase.status = "completed";
          }

          currentSession.currentPhase = newPhase;
          if (!currentSession.phaseData[newPhase]) {
            currentSession.phaseData[newPhase] = { totalDuration: 0 };
          }
          currentSession.phaseData[newPhase].startTime = Date.now();
          currentSession.phaseData[newPhase].status = "active";
        }
        currentSession.events.push({ ...event, timestamp: new Date().toLocaleTimeString() });
        io.emit("agent-event", event);
      }, graphOptions);

      const stream = await (appGraph as any).stream(initialGraphState, { recursionLimit: 500 });

      for await (const chunk of stream) {
        const nodeName = Object.keys(chunk)[0];
        const stateUpdate = (chunk as any)[nodeName];

        if (stateUpdate.containerId) trackedContainerId = stateUpdate.containerId;

        currentSession.currentNode = nodeName;
        if (stateUpdate.teamChatLog) currentSession.logs.push(...stateUpdate.teamChatLog);
        if (stateUpdate.retryCount !== undefined) currentSession.retryCount = stateUpdate.retryCount;
        if (stateUpdate.maxRetries !== undefined) currentSession.maxRetries = stateUpdate.maxRetries;
        if (stateUpdate.deploymentStatus) currentSession.deployment = stateUpdate.deploymentStatus;
        if (stateUpdate.contract) currentSession.contract = stateUpdate.contract;
        if (stateUpdate.spec) currentSession.spec = stateUpdate.spec;
        if ("subTasks" in stateUpdate) {
          currentSession.subTasks = stateUpdate.subTasks;
          console.log(`[Server] subTasks updated: ${currentSession.subTasks.length} tasks`);
        }
        if (stateUpdate.testResults) currentSession.testResults = stateUpdate.testResults;
        if (stateUpdate.qaFailures !== undefined) currentSession.qaFailures = stateUpdate.qaFailures;
        if (stateUpdate.issueTracker !== undefined) currentSession.issueTracker = stateUpdate.issueTracker;
        if (stateUpdate.mediationDirectives !== undefined) currentSession.mediationDirectives = stateUpdate.mediationDirectives;
        if (stateUpdate.fixPlan !== undefined) currentSession.fixPlan = stateUpdate.fixPlan;
        if (stateUpdate.requiresApproval !== undefined) currentSession.requiresApproval = stateUpdate.requiresApproval;

        if (stateUpdate.projectBrief && Array.isArray(stateUpdate.projectBrief)) {
          const uniqueBrief = new Set([
            ...currentSession.projectBrief,
            ...stateUpdate.projectBrief,
          ]);
          currentSession.projectBrief = Array.from(uniqueBrief);
          console.log(`[Server] Brief updated: ${currentSession.projectBrief.length} total items`);
        }
        if (stateUpdate.codeLog && Array.isArray(stateUpdate.codeLog)) {
          currentSession.codeLog = [...currentSession.codeLog, ...stateUpdate.codeLog];
        }
        if (stateUpdate.consensusCore !== undefined) currentSession.consensusCore = stateUpdate.consensusCore;
        if (stateUpdate.consensusProgress !== undefined) currentSession.consensusProgress = stateUpdate.consensusProgress;
        if (stateUpdate.meetingNotes && Array.isArray(stateUpdate.meetingNotes)) {
          const map = new Map((currentSession.meetingNotes || []).map((n: any) => [n.id, n]));
          stateUpdate.meetingNotes.forEach((n: any) => map.set(n.id, n));
          currentSession.meetingNotes = Array.from(map.values());
        }
        if (stateUpdate.lastFailedNode !== undefined) currentSession.lastFailedNode = stateUpdate.lastFailedNode;
        if (stateUpdate.lastFailureSummary !== undefined) currentSession.lastFailureSummary = stateUpdate.lastFailureSummary;

        if (!currentSession.team || currentSession.team.length === 0) {
          currentSession.team = latestTeam;
        }

        io.emit("state-update", currentSession);

        if (stateUpdate.requiresApproval) {
          console.log(`Node ${nodeName} requires approval. Pausing stream...`);
          await new Promise<void>((resolve) => {
            socket.once("approve-task", () => {
              currentSession.requiresApproval = false;
              io.emit("state-update", currentSession);
              resolve();
            });
          });
        }
      }

      const finalPhase = currentSession.currentPhase;
      if (finalPhase && currentSession.phaseData[finalPhase]) {
        currentSession.phaseData[finalPhase].endTime = Date.now();
        currentSession.phaseData[finalPhase].duration =
          currentSession.phaseData[finalPhase].endTime -
          currentSession.phaseData[finalPhase].startTime;
        currentSession.phaseData[finalPhase].status = "completed";
      }

      currentSession.status = "Finished";
      io.emit("task-finished", { success: true });
    } catch (error: any) {
      console.error("[Server] 任务执行失败:", error);
      if (error?.jimclawFailure) {
        currentSession.lastFailedNode = error.jimclawFailure.node;
        currentSession.lastFailureSummary = error.jimclawFailure.summary;
      }
      if (trackedContainerId) {
        console.error(`[Server] 兜底清理容器 ${trackedContainerId}...`);
        try {
          const { exec } = await import("child_process");
          const { promisify } = await import("util");
          await promisify(exec)(`docker rm -f ${trackedContainerId} 2>/dev/null || true`);
          console.error(`[Server] 容器 ${trackedContainerId} 已清理`);
        } catch (cleanupErr) {
          console.error(`[Server] 容器清理失败: ${cleanupErr}`);
        }
      }
      currentSession.status = "Error";
      io.emit("state-update", currentSession);
      io.emit("task-error", {
        message: error.message,
        node: currentSession.lastFailedNode || undefined,
        summary: currentSession.lastFailureSummary || undefined,
      });
    }
  };

  socket.on("run-task", async (data: { userGoal: string }) => {
    const { userGoal } = data;
    const globalMaxRetries = ModelManager.getGlobalConfig()?.maxRetries ?? 5;
    console.log(
      `Starting task for client ${socket.id}: ${userGoal} | maxRetries: ${globalMaxRetries}`
    );
    const latestTeam = getTeamInfo();
    await runGraphSession(
      latestTeam,
      {
        userGoal,
        status: "Running",
        currentPhase: "requirement",
        phaseData: {
          requirement: { startTime: Date.now(), status: "active" },
        },
        currentNode: "-",
        retryCount: 0,
        maxRetries: globalMaxRetries,
        logs: [],
        events: [],
        deployment: { status: "none", url: null },
        contract: null,
        spec: null,
        subTasks: [],
        testResults: "",
        qaFailures: null,
        issueTracker: [],
        mediationDirectives: null,
        fixPlan: null,
        projectBrief: [],
        codeLog: [],
        consensusCore: null,
        consensusProgress: null,
        meetingNotes: [],
        lastFailedNode: "",
        lastFailureSummary: "",
        workspacePath: null,
        team: latestTeam,
      },
      createBaseGraphState(userGoal, globalMaxRetries)
    );
  });

  socket.on("replay-task", async (data: { checkpointId: string }) => {
    const checkpointId = data?.checkpointId;
    const wsPath = currentSession.workspacePath;
    if (!wsPath || !checkpointId) {
      socket.emit("task-error", { message: "缺少 workspace 或 checkpointId" });
      return;
    }

    const globalMaxRetries = ModelManager.getGlobalConfig()?.maxRetries ?? 5;
    const latestTeam = getTeamInfo();

    try {
      const snapshot = await loadCheckpointSnapshot(wsPath, checkpointId);
      const replayState = prepareReplayStateFromCheckpoint(snapshot);
      replayState.maxRetries = globalMaxRetries;

      await runGraphSession(
        latestTeam,
        {
          userGoal: `[Replay] ${checkpointId}`,
          status: "Running",
          currentPhase: "replay",
          phaseData: {
            replay: { startTime: Date.now(), status: "active" },
          },
          currentNode: snapshot.node,
          retryCount: replayState.retryCount || 0,
          maxRetries: globalMaxRetries,
          logs: [],
          events: [],
          deployment: { status: "none", url: null },
          contract: replayState.contract || null,
          spec: replayState.spec || null,
          subTasks: replayState.subTasks || [],
          testResults: "",
          qaFailures: null,
          issueTracker: replayState.issueTracker || [],
          mediationDirectives: replayState.mediationDirectives || null,
          fixPlan: replayState.fixPlan || null,
          projectBrief: replayState.projectBrief || [],
          codeLog: replayState.codeLog || [],
          consensusCore: replayState.consensusCore || null,
          consensusProgress: replayState.consensusProgress || null,
          meetingNotes: replayState.meetingNotes || [],
          lastFailedNode: "",
          lastFailureSummary: "",
          workspacePath: wsPath,
          replaySourceCheckpoint: checkpointId,
          team: latestTeam,
        },
        replayState,
        { workspacePath: wsPath, traceId: snapshot.traceId }
      );
    } catch (error: any) {
      socket.emit("task-error", { message: error.message || String(error) });
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });

  // Human-in-the-loop: 人工反馈接口
  socket.on(
    "human-feedback",
    async (data: {
      type: "challenge" | "assist" | "approve" | "reject";
      content: string;
      relatedNode?: string;
    }) => {
      console.log(`[Human-in-the-loop] 收到人工反馈: ${data.type} - ${data.content}`);

      // 将人工反馈纳入团队共识
      const feedbackEntry = {
        type: data.type === "challenge" ? "problem" : "solution",
        content: `[人工反馈] ${data.content}`,
        agent: "Human",
        timestamp: Date.now(),
        relatedFile: data.relatedNode,
      };

      if (currentSession.projectBrief) {
        currentSession.projectBrief.push(feedbackEntry);
      }

      // 广播人工反馈事件
      io.emit("human-feedback-received", {
        type: data.type,
        content: data.content,
        timestamp: new Date().toISOString(),
      });

      // 如果是质疑，可能需要暂停当前流程
      if (data.type === "challenge") {
        // 发送给 agent 系统处理
        io.emit("agent-intervention", {
          reason: data.content,
          from: "human",
          action: "pause_and_review",
        });
      }

      // 确认收到反馈
      socket.emit("human-feedback-ack", { success: true });
    }
  );
});

// ── 文件浏览 API ──────────────────────────────────────────────────────────────

// 递归列出 workspace 下所有文件（排除 node_modules / .git）
async function listFiles(dir: string, base = ""): Promise<string[]> {
  const result: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push(...(await listFiles(path.join(dir, entry.name), rel)));
    } else {
      result.push(rel);
    }
  }
  return result;
}

app.get("/api/workspace/files", async (_req, res) => {
  const wsPath = currentSession.workspacePath;
  if (!wsPath) return res.json({ files: [], workspacePath: null });
  const files = await listFiles(wsPath);
  res.json({ files, workspacePath: wsPath });
});

app.get("/api/workspace/file", async (req, res) => {
  const wsPath = currentSession.workspacePath;
  const relPath = req.query.path as string;
  if (!wsPath || !relPath) return res.status(400).json({ error: "Missing path" });
  const full = path.resolve(wsPath, relPath);
  if (!full.startsWith(path.resolve(wsPath)))
    return res.status(403).json({ error: "Access denied" });
  try {
    const content = await fs.readFile(full, "utf-8");
    res.json({ content });
  } catch {
    res.status(404).json({ error: "File not found" });
  }
});

app.get("/api/workspace/checkpoints", async (_req, res) => {
  const wsPath = currentSession.workspacePath;
  if (!wsPath) return res.json({ checkpoints: [], workspacePath: null });
  const traceIndex = await loadTraceIndex(wsPath);
  res.json({
    checkpoints: traceIndex?.checkpoints || [],
    workspacePath: wsPath,
    lastNode: traceIndex?.lastNode || null,
    lastFailure: traceIndex?.lastFailure || null,
  });
});

app.get("/api/workspace/checkpoint", async (req, res) => {
  const wsPath = currentSession.workspacePath;
  const checkpointId = req.query.id as string;
  if (!wsPath || !checkpointId) {
    return res.status(400).json({ error: "Missing checkpoint id" });
  }

  try {
    const snapshot = await loadCheckpointSnapshot(wsPath, checkpointId);
    const replayState = buildReplayStateFromSnapshot(snapshot.state || {});
    const subTasks = Array.isArray(replayState.subTasks) ? replayState.subTasks : [];
    const completedFiles = subTasks.filter((task: any) => task.status === "completed").map((task: any) => task.fileTarget);
    const pendingFiles = subTasks.filter((task: any) => task.status !== "completed").map((task: any) => task.fileTarget);

    res.json({
      checkpointId,
      node: snapshot.node,
      timestamp: snapshot.timestamp,
      retryCount: replayState.retryCount || 0,
      completedFiles,
      pendingFiles,
      replayState,
    });
  } catch (error: any) {
    res.status(404).json({ error: error.message || String(error) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  const globalCfg = ModelManager.getGlobalConfig();
  console.log(`🚀 JimClaw Web Backend running at http://localhost:${PORT}`);
  console.log(`[Config] Initial Max Retries: ${globalCfg?.maxRetries ?? "Default(5)"}`);
});
