import { Annotation, StateGraph } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { GenerationStage, FileGenerationState, PhasedGenerationConfig } from "./phased_generation";

/**
 * 任务契约：PM 下发给团队的标准指令
 */
export interface TaskContract {
  title: string;
  requirements: string[];
  acceptanceCriteria: string[];
}

export const TaskContractSchema = z.object({
  title: z.string(),
  requirements: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
});

/**
 * 技术方案：架构师下发给开发的实现指南
 */
export interface TechSpec {
  architecture: string;
  language: string;
  framework: string;              // 主框架，如 "Express.js 4.x" / "FastAPI 0.x"
  testCommand: string;
  runCommand: string;
  entryPoint: string;
  filesToCreate: string[];
  interfaces: string;
  // 架构师定义的核心依赖，Coder 以此为基准，可按需追加，但不得擅自移动分类
  dependencies: Record<string, string>;     // 运行时依赖，如 { "express": "^4.18.2" }
  devDependencies: Record<string, string>;  // 开发依赖，如 { "typescript": "^5.3.3" }
}

export const TechSpecSchema = z.object({
  architecture: z.string(),
  language: z.string(),
  framework: z.string(),
  testCommand: z.string(),
  runCommand: z.string(),
  entryPoint: z.string(),
  filesToCreate: z.array(z.string()),
  interfaces: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

/**
 * 资源清单：全局系统资源配置
 */
export interface SystemManifest {
  services: {
    name: string;
    port?: number;
    description?: string;
  }[];
  environment: Record<string, string>;
  sharedConfig: Record<string, any>;
}

/**
 * 接口契约：定义服务间的交互协议
 */
export interface ApiContract {
  endpoints: {
    path: string;
    method: string;
    description: string;
    requestBody?: any;
    responseBody?: any;
    parameters?: any;
  }[];
}

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const;

export const ApiEndpointSchema = z.object({
  path: z.string().refine((s) => s.startsWith("/"), { message: "路径必须以 / 开头" }),
  method: z.enum(HTTP_METHODS),
  description: z.string().min(1),
});

/**
 * 子任务：由 Orchestrator 拆解的具体开发任务
 */
export interface SubTask {
  id: string;
  description: string;
  fileTarget: string;
  dependencies: string[];
  contextRequirement: string;
  status: "pending" | "completed" | "failed";
  lastError?: string;
}

export const SubTaskArraySchema = z.array(z.object({
  id: z.string(),
  description: z.string(),
  fileTarget: z.string(),
  dependencies: z.array(z.string()),
  contextRequirement: z.string(),
  status: z.enum(["pending", "completed", "failed"] as [string, ...string[]]).optional(),
}));

/**
 * 仲裁指令：架构师介入时下发的跨文件修复指令
 */
export interface MediationDirective {
  file: string;
  action: string;
  detail: string;
}

export const MediationDirectiveSchema = z.array(z.object({
  file: z.string(),
  action: z.string(),
  detail: z.string(),
}));

/**
 * 文件变更记录
 */
export interface FileChangeEntry {
  round: number;
  file: string;
  taskTitle: string;
  status: "written" | "skipped" | "error";
  error?: string;
}

/**
 * 团队共识条目
 */
export type ConsensusType = 'requirement' | 'technical' | 'problem' | 'solution' | 'decision' | 'discussion';

export interface ConsensusEntry {
  type: ConsensusType;
  content: string;
  agent?: string;
  timestamp?: number;
  relatedFile?: string;
}

/**
 * 问题类型分类
 */
export type ProblemType = 'code_problem' | 'judgment_problem' | 'architecture_problem' | 'environment_problem';

/**
 * 问题分析结果
 */
export interface ProblemAnalysis {
  type: ProblemType;
  confidence: number;
  reason: string;
  suggestedAction: string;
}

export const QAResultSchema = z.object({
  passed: z.boolean(),
  feedback: z.string(),
  failedFiles: z.array(z.string()).optional(),
  testErrors: z.array(z.string()).optional(),
  failedTestNames: z.array(z.string()).optional(),
});

/**
 * 缺陷模型：定义系统中发现的具体质量问题
 */
export type IssueSeverity = 'critical' | 'major' | 'minor';
export type IssueStatus = 'open' | 'resolved' | 'ignored';

export interface Issue {
  id: string;              // 唯一标识，如 "BUG-001"
  title: string;           // 缺陷简述
  description: string;     // QA 提炼后的详细现象与修复建议
  severity: IssueSeverity; // 严重程度
  status: IssueStatus;     // 状态
  relatedFiles: string[];  // 关联文件列表
  rawErrorSnippet?: string; // 原始报错摘录
  detectedRound: number;   // 发现时的重试轮次
}

export const IssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  severity: z.enum(['critical', 'major', 'minor']),
  status: z.enum(['open', 'resolved', 'ignored']),
  relatedFiles: z.array(z.string()),
  rawErrorSnippet: z.string().optional(),
  detectedRound: z.number(),
});

/**
 * 三层共识结构：核心信息
 */
export interface ConsensusCore {
  projectTitle: string;
  requirements: string[];
  architectureSummary: string;
  techStack: string;
  framework: string;                            // 主框架，如 "Express.js 4.x"
  port: number;
  coreDependencies: Record<string, string>;     // 架构师定义的运行时依赖
  coreDevDependencies: Record<string, string>;  // 架构师定义的开发依赖
  criticalDecisions: string[];
}

/**
 * 三层共识结构：进度快照
 */
export interface ConsensusProgress {
  completedFiles: string[];
  pendingFiles: string[];
  currentRound: number;
  openIssues: string[];
}

/**
 * 三层共识结构：会议纪要
 */
export interface MeetingNote {
  id: string;
  phase: string;
  round: number;
  summary: string;
  contentFile: string;
}

/**
 * QA-Coder 协商后的单文件修复计划
 */
export interface FixPlanItem {
  fileTarget: string;
  diagnosis: string;        // Coder 对根因的理解（QA 可能已纠正）
  proposedChange: string;   // 具体修改内容
  qaApproval: "approved" | "corrected" | "pending";
  qaFeedback?: string;      // QA 的纠正意见（当 qaApproval = "corrected" 时有值）
}

/**
 * 全局状态定义
 */
export const JimClawState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
  }),
  teamChatLog: Annotation<{ sender: string; content: string }[]>({
    reducer: (x, y) => x.concat(y),
  }),
  issueTracker: Annotation<Issue[]>({
    reducer: (x, y) => {
      if (!y) return x || [];
      if (!x) return y;
      // 智能合并 Issue 列表
      const xMap = new Map(x.map(i => [i.id, i]));
      y.forEach(issue => {
        const existing = xMap.get(issue.id);
        if (existing) {
          // 如果已存在，则用新的覆盖旧的（状态流转）
          xMap.set(issue.id, { ...existing, ...issue });
        } else {
          xMap.set(issue.id, issue);
        }
      });
      return Array.from(xMap.values());
    },
  }),
  subTasks: Annotation<SubTask[]>({
    reducer: (x, y) => {
      if (!y) return x;
      if (!x) return y;
      // 智能合并：以 y 为主，但保留 x 中 y 没有覆盖到的任务，且 y 中的同 ID 任务覆盖 x
      const xMap = new Map(x.map(t => [t.id, t]));
      y.forEach(t => xMap.set(t.id, t));
      return Array.from(xMap.values());
    },
  }),
  contract: Annotation<TaskContract | null>({
    reducer: (x, y) => y ?? x,
  }),
  spec: Annotation<TechSpec | null>({
    reducer: (x, y) => y ?? x,
  }),
  manifest: Annotation<SystemManifest | null>({
    reducer: (x, y) => y ?? x,
  }),
  apiContract: Annotation<ApiContract | null>({
    reducer: (x, y) => y ?? x,
  }),
  code: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  testResults: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  userGoal: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  retryCount: Annotation<number>({
    reducer: (x, y) => y ?? x,
  }),
  isDone: Annotation<boolean>({
    reducer: (x, y) => y ?? x,
  }),
  requiresApproval: Annotation<boolean>({
    reducer: (x, y) => y ?? x,
  }),
  deploymentStatus: Annotation<{ url?: string; status: "none" | "deploying" | "running" | "failed" } | null>({
    reducer: (x, y) => y ?? x,
  }),
  qaFailures: Annotation<{
    failedFiles: string[];
    testErrors: string[];
    failedTestNames: string[];
  } | null>({
    reducer: (x, y) => y !== undefined ? y : x,
  }),
  packageJsonHash: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  mediationDirectives: Annotation<MediationDirective[] | null>({
    reducer: (x, y) => y !== undefined ? y : x,
  }),
  projectBrief: Annotation<ConsensusEntry[]>({
    reducer: (x, y) => [...(x || []), ...(y || [])],
  }),
  codeLog: Annotation<FileChangeEntry[]>({
    reducer: (x, y) => [...(x || []), ...(y || [])],
  }),
  containerId: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  maxRetries: Annotation<number>({
    reducer: (x, y) => y ?? x,
  }),
  templateId: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  templateMetadata: Annotation<any>({
    reducer: (x, y) => y ?? x,
  }),
  generationStage: Annotation<GenerationStage | null>({
    reducer: (x, y) => y ?? x,
  }),
  fileGenerationStates: Annotation<Record<string, FileGenerationState>>({
    reducer: (x, y) => ({ ...(x || {}), ...(y || {}) }),
  }),
  phasedConfig: Annotation<PhasedGenerationConfig>({
    reducer: (x, y) => y ?? x,
  }),
  allocatedHostPort: Annotation<number | null>({
    reducer: (x, y) => y ?? x,
  }),
  consensusCore: Annotation<ConsensusCore | null>({
    reducer: (x, y) => y ?? x,
  }),
  consensusProgress: Annotation<ConsensusProgress | null>({
    reducer: (x, y) => y ?? x,
  }),
  meetingNotes: Annotation<MeetingNote[]>({
    reducer: (x, y) => {
      const map = new Map((x || []).map(n => [n.id, n]));
      (y || []).forEach(n => map.set(n.id, n));
      return Array.from(map.values());
    },
  }),
  // QA 与 Coder 协商后达成的修复计划（每轮覆盖）
  fixPlan: Annotation<FixPlanItem[] | null>({
    reducer: (x, y) => y !== undefined ? y : x,
  }),
});

export type JimClawState = typeof JimClawState.State;
