import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { Team } from "./agents/team";
import { createJimClowGraph } from "./core/graph";
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
  if (model?.model) return model.model;
  if (model?.modelName) return model.modelName;
  if (model?.lc_kwargs?.model) return model.lc_kwargs.model;
  if (model?.lc_kwargs?.modelName) return model.lc_kwargs.modelName;
  return "Unknown";
}

const teamInfo = Object.entries(Team).map(([key, agent]) => {
  const modelsMap = agent.getModels();
  const models: Record<string, string> = {};
  modelsMap.forEach((model, mode) => {
    models[mode] = getModelName(model);
  });
  return {
    id: key,
    name: agent.getPersona().name,
    role: agent.getPersona().role,
    specialty: agent.getPersona().specialty,
    personality: agent.getPersona().personality,
    model: models["default"] ?? "Unknown",
    models,
  };
});

// 全局 Session 镜像 (用于页面刷新同步)
let currentSession: any = {
  userGoal: "",
  status: "Idle",
  currentPhase: "idle",
  phaseData: {}, // { requirement: { startTime, duration, status } }
  currentNode: "-",
  retryCount: 0,
  logs: [],
  events: [],
  deployment: { status: "none", url: null },
  mediationDirectives: null,
  projectBrief: [],
  codeLog: [],
  team: teamInfo,
};

// 简单的静态文件服务
app.use(express.static(path.join(__dirname, "../public")));

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  
  // 握手：立即同步当前所有进度
  socket.emit("session-sync", currentSession);

  socket.on("run-task", async (data: { userGoal: string }) => {
    const { userGoal } = data;
    console.log(`Starting task for client ${socket.id}: ${userGoal}`);

    // 重置全局 Session（保留 team 信息，它是静态数据不随任务变化）
    currentSession = {
      userGoal,
      status: "Running",
      currentPhase: "requirement",
      phaseData: {
        requirement: { startTime: Date.now(), status: "active" }
      },
      currentNode: "-",
      retryCount: 0,
      logs: [],
      events: [],
      deployment: { status: "none", url: null },
      contract: null,
      spec: null,
      subTasks: [],
      testResults: "",
      qaFailures: null,
      mediationDirectives: null,
      projectBrief: [],
      codeLog: [],
      workspacePath: null,
      team: teamInfo,
    };

    try {
      const appGraph = await createJimClowGraph(Team, (event) => {
        if (event.type === 'workspace-ready') {
          currentSession.workspacePath = event.metadata?.workspacePath || null;
          io.emit("workspace-ready", { path: currentSession.workspacePath });
        }
        if (event.type === 'phase-change') {
          const newPhase = event.content;
          const oldPhase = currentSession.currentPhase;
          
          // 结束旧阶段，记录本次运行的时间段
          if (oldPhase && currentSession.phaseData[oldPhase]) {
            const phase = currentSession.phaseData[oldPhase];
            phase.endTime = Date.now();
            phase.totalDuration = (phase.totalDuration || 0) + (phase.endTime - phase.startTime);
            phase.status = "completed";
          }
          
          // 开始新阶段
          currentSession.currentPhase = newPhase;
          if (!currentSession.phaseData[newPhase]) {
            currentSession.phaseData[newPhase] = { totalDuration: 0 };
          }
          currentSession.phaseData[newPhase].startTime = Date.now();
          currentSession.phaseData[newPhase].status = "active";
        }
        currentSession.events.push({ ...event, timestamp: new Date().toLocaleTimeString() });
        io.emit("agent-event", event);
      });
      const stream = await appGraph.stream({
        userGoal,
        messages: [],
        teamChatLog: [],
        retryCount: 0,
        isDone: false,
        contract: null,
        spec: null,
        manifest: null,
        subTasks: [],
        code: "",
        testResults: "",
        qaFailures: null,
        mediationDirectives: null,
        projectBrief: [],
        codeLog: [],
        packageJsonHash: "",
      }, { recursionLimit: 100 });

      for await (const chunk of stream) {
        const nodeName = Object.keys(chunk)[0];
        const stateUpdate = (chunk as any)[nodeName];
        
        // 更新全局镜像
        currentSession.currentNode = nodeName;
        if (stateUpdate.teamChatLog) currentSession.logs.push(...stateUpdate.teamChatLog);
        if (stateUpdate.retryCount !== undefined) currentSession.retryCount = stateUpdate.retryCount;
        if (stateUpdate.deploymentStatus) currentSession.deployment = stateUpdate.deploymentStatus;
        if (stateUpdate.contract) currentSession.contract = stateUpdate.contract;
        if (stateUpdate.spec) currentSession.spec = stateUpdate.spec;
        if (stateUpdate.subTasks) currentSession.subTasks = stateUpdate.subTasks;
        if (stateUpdate.testResults) currentSession.testResults = stateUpdate.testResults;
        if (stateUpdate.qaFailures !== undefined) currentSession.qaFailures = stateUpdate.qaFailures;
        if (stateUpdate.mediationDirectives !== undefined) currentSession.mediationDirectives = stateUpdate.mediationDirectives;
        if (stateUpdate.projectBrief?.length) currentSession.projectBrief = [...currentSession.projectBrief, ...stateUpdate.projectBrief];
        if (stateUpdate.codeLog?.length) currentSession.codeLog = [...currentSession.codeLog, ...stateUpdate.codeLog];

        // 广播给所有客户端 (支持多端同步查看)
        io.emit("state-update", {
          node: nodeName,
          ...stateUpdate,
        });

        // 如果需要审批
        if (stateUpdate.requiresApproval) {
          console.log(`Node ${nodeName} requires approval. Pausing stream...`);
          await new Promise<void>((resolve) => {
            socket.once("approve-task", (approvalData: { approved: boolean, feedback?: string }) => {
              resolve();
            });
          });
        }
      }

      const finalPhase = currentSession.currentPhase;
      if (finalPhase && currentSession.phaseData[finalPhase]) {
        currentSession.phaseData[finalPhase].endTime = Date.now();
        currentSession.phaseData[finalPhase].duration = currentSession.phaseData[finalPhase].endTime - currentSession.phaseData[finalPhase].startTime;
        currentSession.phaseData[finalPhase].status = "completed";
      }

      currentSession.status = "Finished";
      io.emit("task-finished", { success: true });
    } catch (error: any) {
      console.error("Task failed:", error);
      currentSession.status = "Error";
      io.emit("task-error", { message: error.message });
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
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
  if (!full.startsWith(path.resolve(wsPath))) return res.status(403).json({ error: "Access denied" });
  try {
    const content = await fs.readFile(full, "utf-8");
    res.json({ content });
  } catch {
    res.status(404).json({ error: "File not found" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`🚀 JimClaw Web Backend running at http://localhost:${PORT}`);
});
