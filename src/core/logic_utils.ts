import * as fs from "fs/promises";
import * as path from "path";
import {
  JimClawState,
  ConsensusEntry,
  ConsensusType,
  ProblemAnalysis,
  MeetingNote,
  ExecutionFailureInfo,
  TraceIndex,
  TraceCheckpoint,
  TraceFileSummary,
  TraceTimelineEntry,
} from "./graph_types";
import { ShellExecuteSkill } from "../skills/shell_exec";

/**
 * 获取北京时间（东八区）字符串
 */
export function getBeijingTime(): string {
  const date = new Date();
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  const beijingDate = new Date(utc + (3600000 * 8));
  
  const y = beijingDate.getFullYear();
  const m = String(beijingDate.getMonth() + 1).padStart(2, '0');
  const d = String(beijingDate.getDate()).padStart(2, '0');
  const hh = String(beijingDate.getHours()).padStart(2, '0');
  const mm = String(beijingDate.getMinutes()).padStart(2, '0');
  const ss = String(beijingDate.getSeconds()).padStart(2, '0');
  
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

/**
 * 格式化日志输出的前缀
 */
export function logPrefix(agentName: string = "System"): string {
  return `[${getBeijingTime()}] [${agentName}]`;
}

/**
 * 业务逻辑相关辅助函数
 */

/**
 * 动态获取项目入口点
 */
export function getEntryPoint(state: JimClawState): string {
  const allFiles = (state.subTasks || []).map(t => t.fileTarget);
  if (state.spec?.entryPoint) {
    try {
      const url = new URL(state.spec.entryPoint);
      const pathname = url.pathname === "/" ? "" : url.pathname;
      if (pathname) {
        const name = pathname.split("/").pop();
        if (name && allFiles.includes(name)) return name;
      }
    } catch {}
  }
  const serverFile = allFiles.find(f => /server|app|main|index/i.test(f) && !/test|spec/i.test(f) && !f.endsWith(".html") && !/utils|helper|lib/i.test(f));
  if (serverFile) return serverFile;

  const lang = state.spec?.language?.toLowerCase() || "javascript";
  if (lang.includes("python")) return "main.py";
  if (lang.includes("go")) return "main.go";
  return "server.js";
}

/**
 * 获取主实现文件
 */
export function getImplementationFile(state: JimClawState): string {
  const allFiles = (state.subTasks || []).map(t => t.fileTarget);
  const implFile = allFiles.find(f => 
    !/test|spec/i.test(f) && 
    !f.endsWith("package.json") && 
    !f.endsWith(".html") && 
    !/utils|helper|lib|common/i.test(f)
  );
  return implFile || getEntryPoint(state);
}

/**
 * 分析测试失败的原因分类
 */
export function analyzeTestProblem(testOutput: string, retryCount: number, hasMediation: boolean): ProblemAnalysis {
  const hasPassStats = /pass(?:ed)?[:\s]+([1-9]\d*)/i.test(testOutput);
  const hasZeroFail = /fail(?:ures|ed)?[:\s]+0\b/i.test(testOutput);
  const hasRealFailure =
    /command failed with exit code\s+[1-9]/i.test(testOutput) ||
    testOutput.includes('✖') ||
    /^not ok\s+/m.test(testOutput);

  if (hasPassStats && hasZeroFail && !hasRealFailure) {
    return {
      type: 'judgment_problem',
      confidence: 0.9,
      reason: "统计显示测试通过但没有明确失败信号",
      suggestedAction: 'QA 使用 LLM 重新分析测试结果'
    };
  }

  if (/EADDRINUSE|EACCES|ENOENT.*node_modules|cannot find module\s+['"]([^'"./][^'"]*)['"]|spawn \w+ ENOENT/i.test(testOutput)) {
    return {
      type: 'environment_problem',
      confidence: 0.85,
      reason: '检测到环境相关的错误（端口占用、依赖缺失等）',
      suggestedAction: '检查并修复环境问题'
    };
  }

  const isCrossFileError = /not exported|is not a function|undefined is not|cannot read property.*of undefined/i.test(testOutput);
  if ((retryCount >= 1 && isCrossFileError && !hasMediation) || (retryCount >= 2 && !hasMediation)) {
    return {
      type: 'architecture_problem',
      confidence: 0.8,
      reason: isCrossFileError ? '检测到明显的跨文件接口不匹配' : `经过 ${retryCount} 次重试仍未解决，怀疑存在架构冲突`,
      suggestedAction: '触发架构师仲裁'
    };
  }

  return {
    type: 'code_problem',
    confidence: 0.6,
    reason: '检测到明确的测试失败',
    suggestedAction: '返回 failedFiles，让 coder 修复代码'
  };
}

/**
 * 尝试自动修复环境问题
 */
export async function tryFixEnvironmentProblem(testOutput: string, state: JimClawState, workspacePath: string): Promise<{ fixed: boolean; action?: string; reason?: string }> {
  const runInstallCmd = async (cmd: string, timeout: number = 120000) => {
    if (state.containerId) {
      await execInContainer(state.containerId, cmd, { timeout });
    } else {
      await ShellExecuteSkill.config.run({ command: `cd ${workspacePath} && ${cmd}`, timeout });
    }
  };

  // npm ETARGET: 常见于无效版本（例如 @types/mongoose@^7.0.0）
  if (/No matching version found for @types\/mongoose@|ETARGET/i.test(testOutput)) {
    try {
      await runInstallCmd("npm pkg delete devDependencies.@types/mongoose", 60000);
      await runInstallCmd("npm install --silent", 180000);
      return { fixed: true, action: "已移除无效依赖 @types/mongoose 并重新安装依赖" };
    } catch (e: any) {
      return { fixed: false, reason: `自动修复 ETARGET 失败: ${e.message || e}` };
    }
  }

  if (/EADDRINUSE/.test(testOutput)) {
    const portMatch = testOutput.match(/port\s+(\d+)/i) || testOutput.match(/:(\d+)\)/);
    if (portMatch) {
      const port = portMatch[1];
      await ShellExecuteSkill.config.run({
        command: `fuser -k ${port}/tcp 2>/dev/null || lsof -ti:${port} | xargs kill -9 2>/dev/null || true`,
        timeout: 5000
      });
      return { fixed: true, action: `已释放端口 ${port}` };
    }
  }
  if (/cannot find module\s+['"]([^'"./][^'"]*)['"]|Cannot find module/.test(testOutput)) {
    const moduleMatch = testOutput.match(/cannot find module\s+['"]([^'"./][^'"]*)['"]|Cannot find module\s+'([^']+)'/i);
    const moduleName = moduleMatch?.[1] || moduleMatch?.[2];
    if (moduleName) {
      try {
        const installCmd = `npm install ${moduleName} --save --silent`;
        await runInstallCmd(installCmd, 60000);
        return { fixed: true, action: `已安装缺失模块 ${moduleName}` };
      } catch (e: any) {
        const errorText = String(e?.message || e || "");
        if (/No matching version found for @types\/mongoose@|ETARGET/i.test(errorText)) {
          try {
            await runInstallCmd("npm pkg delete devDependencies.@types/mongoose", 60000);
            await runInstallCmd("npm install --silent", 180000);
            return { fixed: true, action: `安装 ${moduleName} 时发现 @types/mongoose 版本无效，已自动修复并重装依赖` };
          } catch (fixErr: any) {
            return { fixed: false, reason: `修复缺失模块失败: ${fixErr.message || fixErr}` };
          }
        }
        return { fixed: false, reason: `安装缺失模块失败: ${errorText}` };
      }
    }
  }
  return { fixed: false, reason: "无法自动修复" };
}

/**
 * 将原始错误输出归一化为“失败指纹”，用于识别自旋
 */
export function buildFailureFingerprint(testOutput: string): string {
  const lines = (testOutput || "")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => /error|fail|exception|cannot find|ts\d+|etarget|eaddrinuse|enoent|not found/i.test(l))
    .slice(0, 12)
    .map(l => l.replace(/\d+/g, "#").replace(/\s+/g, " ").toLowerCase());

  const fingerprint = lines.join("|");
  return fingerprint.slice(0, 500);
}

/**
 * 团队共识转换辅助函数
 */
export function consensusToStringArray(consensus: ConsensusEntry[]): string[] {
  if (!consensus || consensus.length === 0) return [];
  return consensus.map(entry => {
    const prefix = `[${entry.type}]`;
    const agent = entry.agent ? `[${entry.agent}] ` : '';
    const file = entry.relatedFile ? `(${entry.relatedFile})` : '';
    return `${prefix} ${agent}${entry.content}${file}`;
  });
}

export function createConsensus(
  type: ConsensusType,
  content: string,
  agent?: string,
  relatedFile?: string
): ConsensusEntry {
  return {
    type,
    content,
    agent,
    timestamp: Date.now(),
    relatedFile
  };
}

/**
 * 格式化共识为 LLM 可读文本
 */
export function formatConsensusForLLM(consensus: ConsensusEntry[]): string {
  if (!consensus || consensus.length === 0) return '';
  const sections: string[] = [];
  const types: ConsensusType[] = ['requirement', 'technical', 'problem', 'solution', 'decision', 'discussion'];
  
  for (const type of types) {
    const entries = consensus.filter(e => e.type === type);
    if (entries.length > 0) {
      sections.push(`## ${type.toUpperCase()}`);
      entries.forEach(e => {
        const agent = e.agent ? `[${e.agent}] ` : '';
        sections.push(`- ${agent}${e.content}${e.relatedFile ? ` (${e.relatedFile})` : ''}`);
      });
    }
  }
  return sections.join('\n');
}

/**
 * 语言特定的依赖规则
 */
export function getDependencyRules(language: string, serverFile?: string, filesContent?: Record<string, string>): string {
  const lang = language.toLowerCase();
  if (lang.includes("javascript") || lang.includes("typescript")) {
    const needsCors = serverFile && filesContent?.[serverFile]?.includes("cors");
    const needsExpress = lang.includes("javascript") || lang.includes("typescript");
    
    return `\n\n[package.json 依赖分类规则 - 严格执行]
• 【dependencies】运行时必需的包：express, cors, sqlite3, pg, mongoose, axios 等
• 【devDependencies】仅开发时需要的工具：typescript, ts-node, jest, eslint, prettier 等${needsCors ? `\n• 【本项目特别要求】cors 必须放在 dependencies 中` : ""}${needsExpress ? `\n• 【本项目特别要求】express 必须放在 dependencies 中` : ""}`;
  }
  
  if (lang.includes("python")) {
    return `\n\n[requirements.txt 依赖规则]
• 【运行时依赖】fastapi, uvicorn, sqlalchemy, requests, pydantic 等
• 【开发依赖】pytest, mypy, black 等`;
  }
  return "";
}

/**
 * Fallback 子任务生成：当模型拆解失败时，基于 TechSpec 的 filesToCreate 动态生成任务链
 */
export function generateFallbackSubTasks(spec: any, apiContract: any): any[] {
  const language = spec?.language || "TypeScript";
  const filesToCreate = spec?.filesToCreate || [];
  const tasks: any[] = [];

  // 1. 识别必需的基础文件（如果是 TS/JS 项目且没有在 filesToCreate 中显式包含 package.json）
  const isJS = language.toLowerCase().includes("typescript") || language.toLowerCase().includes("ts") || language.toLowerCase().includes("javascript");
  const hasPackageJson = filesToCreate.some((f: string) => f.includes("package.json"));
  
  if (isJS && !hasPackageJson) {
    tasks.push({
      id: "fallback_task_pkg",
      description: "生成基础 package.json 配置文件",
      fileTarget: "package.json",
      dependencies: [],
      contextRequirement: "包含必需的依赖和脚本配置"
    });
  }

  // 2. 遍历 filesToCreate 动态生成任务
  filesToCreate.forEach((file: string, index: number) => {
    // 跳过重复的 package.json
    if (file.includes("package.json") && tasks.some(t => t.fileTarget === "package.json")) return;

    // 建立简单的依赖链（后续文件依赖前续文件，虽然不严谨但能保证顺序）
    const dependencies = index > 0 ? [`fallback_task_${index - 1}`] : (tasks.length > 0 ? [tasks[tasks.length - 1].id] : []);

    tasks.push({
      id: `fallback_task_${index}`,
      description: `实现文件: ${file}`,
      fileTarget: file,
      dependencies,
      contextRequirement: `根据技术规范实现 ${file} 的核心逻辑`
    });
  });

  // 3. 兜底逻辑：如果没有任何文件定义，至少生成一个入口
  if (tasks.length === 0) {
    const isPython = language.toLowerCase().includes("python");
    const serverFile = isPython ? "main.py" : `server.${isJS ? (language.toLowerCase().includes("ts") ? "ts" : "js") : "js"}`;
    tasks.push({
      id: "fallback_task_entry",
      description: `实现入口文件 ${serverFile}`,
      fileTarget: serverFile,
      dependencies: [],
      contextRequirement: `实现 API 核心逻辑`
    });
  }

  return tasks;
}

export function ensureTypeScriptTestBaseline(spec: any): any {
  const language = String(spec?.language || "").toLowerCase();
  const testCommand = String(spec?.testCommand || "").toLowerCase();
  if (!language.includes("typescript")) return spec;
  if (!/(npm test|jest|ts-jest)/.test(testCommand)) return spec;

  const filesToCreate = new Set(spec?.filesToCreate || []);
  filesToCreate.add("jest.config.cjs");
  filesToCreate.add("tests/setup.test.ts");

  const devDependencies = { ...(spec?.devDependencies || {}) } as Record<string, string>;
  if (!devDependencies.jest) devDependencies.jest = "^29.7.0";
  if (!devDependencies["ts-jest"]) devDependencies["ts-jest"] = "^29.1.1";
  if (!devDependencies["@types/jest"]) devDependencies["@types/jest"] = "^29.5.11";

  return {
    ...spec,
    filesToCreate: Array.from(filesToCreate),
    devDependencies,
  };
}

export function findContractRouteDrift(
  routeContent: string,
  contract: { endpoints?: Array<{ path: string; method: string }> } | null | undefined,
): string[] {
  const endpoints = contract?.endpoints || [];
  if (endpoints.length === 0) return [];

  const allowed = new Set(
    endpoints.map((ep) => `${String(ep.method || "").toUpperCase()} ${String(ep.path || "").trim()}`)
  );

  const routeRegex = /router\.(get|post|put|delete|patch)\s*\(\s*["'`](.+?)["'`]/gi;
  const drifts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = routeRegex.exec(routeContent)) !== null) {
    const actual = `${match[1].toUpperCase()} ${match[2]}`;
    if (!allowed.has(actual)) {
      drifts.push(`路由 ${actual} 未在 ApiContract 中声明`);
    }
  }

  return drifts;
}

/**
 * 构建结构化三层共识上下文，供所有节点注入 system prompt
 */
export function buildSystemContext(state: JimClawState): string[] {
  const core = state.consensusCore;
  const progress = state.consensusProgress;
  const notes = state.meetingNotes || [];

  if (!core) {
    return consensusToStringArray(state.projectBrief);
  }

  const lines: string[] = [];

  // 第一层：核心信息
  lines.push("[项目核心]");
  lines.push(`• 项目：${core.projectTitle}`);
  if (core.requirements.length > 0) {
    lines.push(`• 需求：${core.requirements.map((r, i) => `${i + 1}. ${r}`).join("  ")}`);
  }
  if (core.architectureSummary) {
    lines.push(`• 架构：${core.architectureSummary}`);
  }
  if (core.techStack) {
    lines.push(`• 技术栈：${core.techStack}，端口：${core.port}`);
  }
  if (core.framework) {
    lines.push(`• 主框架：${core.framework}`);
  }
  if (core.coreDependencies && Object.keys(core.coreDependencies).length > 0) {
    const deps = Object.entries(core.coreDependencies).map(([k, v]) => `${k}@${v}`).join(", ");
    lines.push(`• 运行时依赖：${deps}`);
  }
  if (core.coreDevDependencies && Object.keys(core.coreDevDependencies).length > 0) {
    const devDeps = Object.entries(core.coreDevDependencies).map(([k, v]) => `${k}@${v}`).join(", ");
    lines.push(`• 开发依赖：${devDeps}`);
  }
  if (core.criticalDecisions.length > 0) {
    lines.push(`• 关键决策：${core.criticalDecisions.map(d => `• ${d}`).join("  ")}`);
  }

  // 第二层：进度快照
  if (progress) {
    const total = progress.completedFiles.length + progress.pendingFiles.length;
    lines.push("");
    lines.push(`[当前进度（第 ${progress.currentRound} 轮）]`);
    lines.push(`• 已完成（${progress.completedFiles.length}/${total} 个文件）：${progress.completedFiles.join(", ") || "无"}`);
    lines.push(`• 待完成：${progress.pendingFiles.join(", ") || "无"}`);
    if (progress.openIssues.length > 0) {
      lines.push(`• 未解决问题：${progress.openIssues.join("; ")}`);
    }
  }

  // 第三层：会议纪要摘要
  if (notes.length > 0) {
    lines.push("");
    lines.push("[沟通纪要]");
    for (const note of notes) {
      lines.push(`• [${note.id}] ${note.summary}`);
    }
    lines.push("（需要详情？调用 read_meeting_note(note_id)）");
  }

  return lines;
}

/**
 * 写入会议纪要文件并返回 MeetingNote 对象
 */
export async function writeMeetingNote(
  workspace: string,
  id: string,
  phase: string,
  round: number,
  summary: string,
  fullContent: string
): Promise<MeetingNote> {
  const nodesDir = path.join(workspace, "nodes");
  await fs.mkdir(nodesDir, { recursive: true });
  await fs.writeFile(path.join(nodesDir, `${id}.md`), fullContent, "utf-8");
  return { id, phase, round, summary, contentFile: `nodes/${id}.md` };
}

function trimFailureText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export async function recordNodeFailure(
  workspace: string,
  state: Pick<JimClawState, "retryCount" | "meetingNotes">,
  nodeName: string,
  error: unknown
): Promise<{ failure: ExecutionFailureInfo; meetingNotes: MeetingNote[] }> {
  const round = state.retryCount || 0;
  const noteId = `note-${nodeName}-r${round}`;
  const rawMessage = error instanceof Error ? (error.stack || error.message) : String(error);
  const firstLine = rawMessage.split(/\r?\n/).find((line) => line.trim()) || rawMessage;
  const summary = `${nodeName} 节点异常：${trimFailureText(firstLine, 60)}`;
  const fullContent = [
    `# ${nodeName} 节点异常`,
    "",
    `- 轮次：${round}`,
    `- 摘要：${summary}`,
    "",
    "## 原始错误",
    "```text",
    rawMessage || "未知错误",
    "```",
    "",
  ].join("\n");

  const note = await writeMeetingNote(workspace, noteId, nodeName, round, summary, fullContent);
  const existingNotes = state.meetingNotes || [];
  const meetingNotes = existingNotes.some((item) => item.id === note.id)
    ? existingNotes.map((item) => item.id === note.id ? note : item)
    : [...existingNotes, note];

  return {
    failure: { node: nodeName, round, summary, noteId },
    meetingNotes,
  };
}

export function buildTraceIndex(
  state: Pick<JimClawState, "retryCount" | "meetingNotes" | "codeLog" | "lastFailedNode" | "lastFailureSummary">,
  nodeName: string,
  traceId: string,
  timestamp: string,
  checkpoints: TraceCheckpoint[] = []
): TraceIndex {
  const meetingNotes = [...(state.meetingNotes || [])].sort((a, b) => {
    if (a.round !== b.round) return a.round - b.round;
    return a.phase.localeCompare(b.phase);
  });
  const fileChanges = [...(state.codeLog || [])];
  const files = fileChanges.reduce<Record<string, TraceFileSummary>>((acc, entry) => {
    acc[entry.file] = {
      file: entry.file,
      lastRound: entry.round,
      lastStatus: entry.status,
      taskTitle: entry.taskTitle,
      lastError: entry.error,
    };
    return acc;
  }, {});

  const timeline: TraceTimelineEntry[] = meetingNotes.map((note) => ({
    node: note.phase,
    round: note.round,
    summary: note.summary,
  }));

  const currentRound = state.retryCount || 0;
  const shouldAppendLastNode = timeline.length === 0 || timeline[timeline.length - 1].node !== nodeName;
  if (shouldAppendLastNode) {
    timeline.push({
      node: nodeName,
      round: currentRound,
      timestamp,
      summary: state.lastFailureSummary || undefined,
    });
  } else if (!timeline[timeline.length - 1].timestamp) {
    timeline[timeline.length - 1] = {
      ...timeline[timeline.length - 1],
      timestamp,
    };
  }

  return {
    traceId,
    lastNode: nodeName,
    retryCount: currentRound,
    timestamp,
    meetingNotes,
    fileChanges,
    files,
    timeline,
    checkpoints,
    lastFailure: {
      node: state.lastFailedNode || undefined,
      summary: state.lastFailureSummary || undefined,
    },
  };
}

const CHECKPOINT_NODES = new Set([
  "orchestrator",
  "coder_final",
  "verifier",
  "qa",
  "deploy",
]);

export function shouldPersistCheckpoint(nodeName: string): boolean {
  return CHECKPOINT_NODES.has(nodeName);
}

export function buildCheckpointMeta(
  nodeName: string,
  round: number,
  timestamp: string
): TraceCheckpoint {
  const safeNode = nodeName.replace(/[^a-z0-9_-]/gi, "_");
  return {
    id: `${safeNode}-r${round}`,
    node: nodeName,
    round,
    timestamp,
    file: `checkpoints/${safeNode}-r${round}.json`,
  };
}

export async function loadTraceIndex(workspace: string): Promise<TraceIndex | null> {
  try {
    const raw = await fs.readFile(path.join(workspace, "trace-index.json"), "utf-8");
    return JSON.parse(raw) as TraceIndex;
  } catch {
    return null;
  }
}

export async function loadCheckpointSnapshot(workspace: string, checkpointId: string): Promise<any> {
  const traceIndex = await loadTraceIndex(workspace);
  const checkpoint = traceIndex?.checkpoints?.find((item) => item.id === checkpointId);
  if (!checkpoint) {
    throw new Error(`未找到 checkpoint: ${checkpointId}`);
  }
  const raw = await fs.readFile(path.join(workspace, checkpoint.file), "utf-8");
  return JSON.parse(raw);
}

export async function validateWorkspaceArtifacts(workspace: string): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  let boulder: any = null;
  let traceIndex: TraceIndex | null = null;

  try {
    const raw = await fs.readFile(path.join(workspace, "boulder.json"), "utf-8");
    boulder = JSON.parse(raw);
  } catch {
    errors.push("缂哄皯鎴栨棤娉曡鍙?boulder.json");
  }

  traceIndex = await loadTraceIndex(workspace);
  if (!traceIndex) {
    errors.push("缂哄皯鎴栨棤娉曡鍙?trace-index.json");
  }

  if (boulder && traceIndex) {
    if (boulder.traceId !== traceIndex.traceId) {
      errors.push("boulder.json 涓?traceId 涓?trace-index.json 涓嶄竴鑷?");
    }
    if (boulder.node !== traceIndex.lastNode) {
      errors.push("boulder.json 鏈€鍚庤妭鐐逛笌 trace-index.json.lastNode 涓嶄竴鑷?");
    }
    if ((boulder.state?.retryCount || 0) !== traceIndex.retryCount) {
      errors.push("boulder.json.state.retryCount 涓?trace-index.json.retryCount 涓嶄竴鑷?");
    }
  }

  const checkpoints = traceIndex?.checkpoints || [];
  for (const checkpoint of checkpoints) {
    const checkpointPath = path.join(workspace, checkpoint.file);
    try {
      const raw = await fs.readFile(checkpointPath, "utf-8");
      const snapshot = JSON.parse(raw);
      if (traceIndex && snapshot.traceId !== traceIndex.traceId) {
        errors.push(`checkpoint ${checkpoint.id} 鐨?traceId 涓?trace-index.json 涓嶄竴鑷?`);
      }
      if (snapshot.node !== checkpoint.node) {
        errors.push(`checkpoint ${checkpoint.id} 鐨?node 涓庣储寮曞厓鏁版嵁涓嶄竴鑷?`);
      }
      if ((snapshot.state?.retryCount || 0) !== checkpoint.round) {
        errors.push(`checkpoint ${checkpoint.id} 鐨?retryCount 涓庣储寮曞厓鏁版嵁 round 涓嶄竴鑷?`);
      }
    } catch {
      errors.push(`checkpoint 鏂囦欢缂哄け鎴栨棤娉曡鍙? ${checkpoint.file}`);
    }
  }

  const subTasks = Array.isArray(boulder?.state?.subTasks) ? boulder.state.subTasks : [];
  const fileSummaries = traceIndex?.files || {};
  for (const task of subTasks) {
    if (!task?.fileTarget) continue;
    const summary = fileSummaries[task.fileTarget];
    if (task.status === "completed") {
      if (!summary) {
        errors.push(`subTask ${task.fileTarget} 宸叉爣璁?completed锛屼絾 trace-index.files 涓己灏戝搴旀枃浠舵眹鎬?`);
        continue;
      }
      if (summary.lastStatus !== "written") {
        errors.push(`subTask ${task.fileTarget} 宸叉爣璁?completed锛屼絾 trace-index.files.lastStatus=${summary.lastStatus}`);
      }
    }
    if (task.status === "failed" && summary?.lastStatus === "written") {
      errors.push(`subTask ${task.fileTarget} 宸叉爣璁?failed锛屼絾 trace-index.files.lastStatus=written`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function buildReplayStateFromSnapshot(snapshotState: Partial<JimClawState>): Partial<JimClawState> {
  return {
    ...snapshotState,
    messages: [],
    teamChatLog: [],
    requiresApproval: false,
    deploymentStatus: { status: "none" },
    qaFailures: null,
    testResults: "",
    lastFailedNode: "",
    lastFailureSummary: "",
    blockedReason: "",
    recoveredEnvironment: false,
    envReady: null,
    resumeFromNode: "",
    containerId: "",
    allocatedHostPort: null,
    failureFingerprint: "",
    sameFailureCount: 0,
  };
}

export function getResumeNodeFromCheckpoint(nodeName: string): string {
  switch (nodeName) {
    case "orchestrator":
      return "coder";
    case "coder_final":
      return "env_guard";
    case "verifier":
      return "qa";
    case "qa":
      return "qa_resume_router";
    case "deploy":
      return "post_mortem";
    default:
      return "pm";
  }
}

export function prepareReplayStateFromCheckpoint(snapshot: { node: string; state?: Partial<JimClawState> }): Partial<JimClawState> {
  const replayState = buildReplayStateFromSnapshot(snapshot.state || {});
  replayState.resumeFromNode = getResumeNodeFromCheckpoint(snapshot.node);
  return replayState;
}

/**
 * Docker 容器执行辅助
 */
export async function execInContainer(containerId: string, command: string, opts: { timeout?: number; background?: boolean } = {}): Promise<string> {
  if (opts.background) {
    return ShellExecuteSkill.config.run({
      command: `docker exec -d ${containerId} sh -c ${JSON.stringify(command)}`,
      timeout: 10000,
    });
  }
  return ShellExecuteSkill.config.run({
    command: `docker exec ${containerId} sh -c ${JSON.stringify(command)}`,
    timeout: opts.timeout ?? 90000,
  });
}
