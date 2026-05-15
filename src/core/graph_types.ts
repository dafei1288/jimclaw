import { Annotation, StateGraph } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { GenerationStage, FileGenerationState, PhasedGenerationConfig } from "./phased_generation";
import { ExecutorState } from "../executor/types";

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

export type VerificationKind = "api" | "ui" | "unit" | "build" | "deploy" | "manual";

export const VerificationKindSchema = z.enum(["api", "ui", "unit", "build", "deploy", "manual"]);

export interface ProductSpec {
  version: "v1";
  title: string;
  userGoal: string;
  userStories: Array<{
    id: string;
    story: string;
    priority: "must" | "should" | "could";
  }>;
  acceptanceCriteria: Array<{
    id: string;
    description: string;
    verificationKind: VerificationKind;
  }>;
  nonGoals: string[];
}

export const ProductSpecSchema = z.object({
  version: z.literal("v1"),
  title: z.string(),
  userGoal: z.string(),
  userStories: z.array(z.object({
    id: z.string(),
    story: z.string(),
    priority: z.enum(["must", "should", "could"]),
  })),
  acceptanceCriteria: z.array(z.object({
    id: z.string(),
    description: z.string(),
    verificationKind: VerificationKindSchema,
  })),
  nonGoals: z.array(z.string()),
});

export interface SprintPlan {
  id: string;
  title: string;
  goal: string;
  userStoryIds: string[];
  acceptanceCriteriaIds: string[];
  deliverables: string[];
  allowedScope: string[];
  dependencies: string[];
  estimatedComplexity: "small" | "medium" | "large";
  doneWhen: string[];
}

export const SprintPlanSchema = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  userStoryIds: z.array(z.string()),
  acceptanceCriteriaIds: z.array(z.string()),
  deliverables: z.array(z.string()),
  allowedScope: z.array(z.string()),
  dependencies: z.array(z.string()),
  estimatedComplexity: z.enum(["small", "medium", "large"]),
  doneWhen: z.array(z.string()),
});

export interface EvaluationCheck {
  id: string;
  kind: "command" | "http" | "playwright" | "file" | "unit" | "deploy";
  description: string;
  command?: string;
  url?: string;
  method?: string;
  expectedStatus?: number[];
  expectedText?: string;
  targetFile?: string;
  path?: string;
  exists?: boolean;
}

export const EvaluationCheckSchema = z.object({
  id: z.string(),
  kind: z.enum(["command", "http", "playwright", "file", "unit", "deploy"]),
  description: z.string(),
  command: z.string().optional(),
  url: z.string().optional(),
  method: z.string().optional(),
  expectedStatus: z.array(z.number()).optional(),
  expectedText: z.string().optional(),
  targetFile: z.string().optional(),
  path: z.string().optional(),
  exists: z.boolean().optional(),
});

export interface SprintContract {
  version: "v1";
  sprintId: string;
  builderPlan: {
    intent: string;
    filesLikelyTouched: string[];
    implementationSteps: string[];
    selfChecks: string[];
    assumptions: string[];
  };
  evaluatorPlan: {
    checks: EvaluationCheck[];
    requiredEvidence: string[];
    passThreshold: "all" | "critical-only";
    concerns: string[];
  };
  agreedScope: {
    allowedFiles: string[];
    forbiddenFiles: string[];
    maxNewFiles?: number;
  };
  status: "draft" | "agreed" | "rejected";
}

export const SprintContractSchema = z.object({
  version: z.literal("v1"),
  sprintId: z.string(),
  builderPlan: z.object({
    intent: z.string(),
    filesLikelyTouched: z.array(z.string()),
    implementationSteps: z.array(z.string()),
    selfChecks: z.array(z.string()),
    assumptions: z.array(z.string()),
  }),
  evaluatorPlan: z.object({
    checks: z.array(EvaluationCheckSchema),
    requiredEvidence: z.array(z.string()),
    passThreshold: z.enum(["all", "critical-only"]),
    concerns: z.array(z.string()),
  }),
  agreedScope: z.object({
    allowedFiles: z.array(z.string()),
    forbiddenFiles: z.array(z.string()),
    maxNewFiles: z.number().optional(),
  }),
  status: z.enum(["draft", "agreed", "rejected"]),
});

export interface EvaluationResult {
  version: "v1";
  sprintId: string;
  status: "pass" | "fail";
  checks: Array<{
    checkId: string;
    status: "pass" | "fail" | "skipped";
    evidence: {
      commandOutput?: string;
      httpStatus?: number | null;
      httpBodySnippet?: string;
      screenshotPath?: string;
      tracePath?: string;
      fileSnippet?: string;
      path?: string;
      fileExists?: boolean;
      sizeBytes?: number;
      error?: string;
    };
    reproSteps: string[];
    suspectedFiles: string[];
  }>;
  summary: string;
}

export const EvaluationResultSchema = z.object({
  version: z.literal("v1"),
  sprintId: z.string(),
  status: z.enum(["pass", "fail"]),
  checks: z.array(z.object({
    checkId: z.string(),
    status: z.enum(["pass", "fail", "skipped"]),
    evidence: z.object({
      commandOutput: z.string().optional(),
      httpStatus: z.number().nullable().optional(),
      httpBodySnippet: z.string().optional(),
      screenshotPath: z.string().optional(),
      tracePath: z.string().optional(),
      fileSnippet: z.string().optional(),
      path: z.string().optional(),
      fileExists: z.boolean().optional(),
      sizeBytes: z.number().optional(),
      error: z.string().optional(),
    }),
    reproSteps: z.array(z.string()),
    suspectedFiles: z.array(z.string()),
  })),
  summary: z.string(),
});

/**
 * 技术方案：架构师下发给开发的实现指南
 */
export interface FrontendSpec {
  language: "TypeScript" | "JavaScript";
  framework: "Vue" | "React" | "Svelte";
  buildCommand: string;   // e.g. "npm run build"
  testCommand: string;    // e.g. "npm test"
  outputDir: string;      // e.g. "dist"
  sourceDir: string;      // e.g. "frontend"
}

export interface TechSpec {
  architecture: string;
  language: string;
  framework: string;              // 主框架，如 "Express.js 4.x" / "FastAPI 0.x"
  testCommand: string;
  runCommand: string;
  entryPoint: string;
  filesToCreate: string[];
  interfaces: string;
  authScaffoldMode?: "split" | "compact";
  /** 混合项目的前端配置（Vue/React + Java/Python/Go/Rust） */
  frontend?: FrontendSpec;
  // 架构师定义的核心依赖，Coder 以此为基准，可按需追加，但不得擅自移动分类
  dependencies: Record<string, string>;     // 运行时依赖，如 { "express": "^4.18.2" }
  devDependencies: Record<string, string>;  // 开发依赖，如 { "typescript": "^5.3.3" }
}

export const FrontendSpecSchema = z.object({
  language: z.enum(["TypeScript", "JavaScript"]),
  framework: z.enum(["Vue", "React", "Svelte"]),
  buildCommand: z.string(),
  testCommand: z.string(),
  outputDir: z.string(),
  sourceDir: z.string(),
});

export const TechSpecSchema = z.object({
  architecture: z.string(),
  language: z.string(),
  framework: z.string(),
  testCommand: z.string(),
  runCommand: z.string(),
  entryPoint: z.string(),
  filesToCreate: z.array(z.string()),
  interfaces: z.string(),
  authScaffoldMode: z.enum(["split", "compact"]).optional(),
  frontend: FrontendSpecSchema.optional(),
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

export type PlanningSource = "model" | "deterministic-fallback" | "modify-incremental";
export type GenerationSource = "model" | "deterministic_scaffold" | "recovered_disk";

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
  generationSource?: GenerationSource;
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

export interface RepairContract {
  version: "v1";
  sprintId: string;
  sourceEvaluationResultId?: string;
  failedChecks: string[];
  reproSteps?: string[];
  suspectedFiles?: string[];
  allowedRepairFiles?: string[];
  rerunChecks?: string[];
  repairScope: string[];
  instructions: string[];
  expectedEvidence: string[];
  status?: "open" | "closed";
}

/**
 * 环境修复账本：记录每次自动修复动作，避免重复无效尝试
 */
export interface RepairLedgerEntry {
  round: number;
  phase: string;
  action: string;
  result: "success" | "failed";
  fingerprint?: string;
}

export interface ExecutionFailureInfo {
  node: string;
  round: number;
  summary: string;
  noteId: string;
}

export interface TraceTimelineEntry {
  node: string;
  round: number;
  timestamp?: string;
  summary?: string;
}

export interface TraceCheckpoint {
  id: string;
  node: string;
  round: number;
  timestamp: string;
  file: string;
}

export interface TraceFileSummary {
  file: string;
  lastRound: number;
  lastStatus: "written" | "skipped" | "error";
  taskTitle: string;
  lastError?: string;
  generationSource?: GenerationSource;
}

export type ProtocolFileRole =
  | "entry"
  | "route"
  | "controller"
  | "service"
  | "repository"
  | "model"
  | "middleware"
  | "test"
  | "config"
  | "infra"
  | "other";

export interface ExecutionProtocolFileContract {
  role: ProtocolFileRole;
  allowedDependencyRoles: ProtocolFileRole[];
  requiredExports?: string[];
  ownedEndpoints?: string[];
  notes?: string[];
}

export interface FrontendApiUsage {
  resourcePath: string;
  methods: string[];
  supportsList: boolean;
  supportsCreate: boolean;
  supportsUpdate: boolean;
  supportsDelete: boolean;
}

export interface FrontendContract {
  appType: "none" | "static" | "spa";
  framework: "none" | "vanilla" | "react" | "vue" | "svelte";
  rootDir: "" | "public" | "frontend";
  entryFiles: string[];
  apiUsage: FrontendApiUsage[];
}

export interface RequirementProtocol {
  version: "v1";
  userIntent: {
    title: string;
    requirements: string[];
    acceptanceCriteria: string[];
  };
  capabilities: {
    frontendRequired: boolean;
    backendRequired: boolean;
    authRequired: boolean;
    auditLogRequired: boolean;
    dockerRequired: boolean;
    entities: string[];
    crudEntities: string[];
    uiCapabilities: string[];
  };
}

export interface SolutionProtocol {
  version: "v1";
  coverage: {
    frontendPlanned: boolean;
    backendPlanned: boolean;
    authPlanned: boolean;
    auditLogPlanned: boolean;
    uncoveredRequirements: string[];
    uncoveredAcceptanceCriteria: string[];
    coverageMatrix: Array<{
      requirement: string;
      coveredBy: string[];
    }>;
  };
}

export type BackendFramework =
  | "express-typescript"
  | "fastapi-python"
  | "gin-go"
  | "spring-java"
  | "rust-web"
  | "unknown";

export type ProjectRuntime = "node" | "python" | "go" | "java" | "rust" | "unknown";

export interface TechnologyDecision {
  version: "v1";
  source: "user" | "architect";
  frontend: {
    required: boolean;
    framework: "vanilla" | "react" | "vue" | "none";
    buildTool: "vite" | "none";
    entryFiles: string[];
  };
  backend: {
    required: boolean;
    framework: BackendFramework;
    entryFiles: string[];
  };
  database: {
    kind: "postgres" | "sqlite" | "memory" | "none";
  };
  testing: {
    unit: string;
    api?: string;
    e2e?: string;
  };
  deploy: {
    docker: boolean;
    compose: boolean;
  };
}

export interface ExecutionPlanFile {
  path: string;
  role: ProtocolFileRole | "ui";
  required: boolean;
  satisfiesRequirements: string[];
  dependsOnFiles: string[];
}

export interface ExecutionPlanTask {
  id: string;
  fileTarget: string;
  role: ProtocolFileRole | "ui";
  dependsOnTaskIds: string[];
  verificationHooks: string[];
}

export interface ExecutionPlan {
  version: "v1";
  files: ExecutionPlanFile[];
  tasks: ExecutionPlanTask[];
  acceptanceChecks: string[];
}

export interface ExecutionProtocol {
  version: "v1";
  requirements: RequirementProtocol;
  solution: SolutionProtocol;
  project: {
    language: string;
    framework: string;
    runtime: ProjectRuntime;
    workspaceLayout: {
      sourceRoots: string[];
      testRoots: string[];
      frontendRoots: string[];
      entryFiles: string[];
      configFiles: string[];
      infraFiles: string[];
    };
  };
  contracts: {
    api: {
      endpoints: Array<{
        path: string;
        method: string;
        ownerFile?: string;
      }>;
    };
    frontend: FrontendContract;
    files: Record<string, ExecutionProtocolFileContract>;
  };
  runtime: {
    startCommand?: string;
    testCommand?: string;
    entryPoint?: string;
    buildOutput?: string;
    listenPort?: number;
    healthCheckPath?: string;
  };
  workflow: {
    blockingRules: string[];
    recoveryRules: string[];
  };
  validation: {
    layoutRules: string[];
    dependencyRules: string[];
    runtimeRules: string[];
    acceptanceRules: string[];
  };
}

export interface ProtocolFailure {
  type:
    | "layout_mismatch"
    | "dependency_deadlock"
    | "contract_drift"
    | "runtime_mismatch"
    | "test_discovery_gap"
    | "tooling_unavailable";
  node: string;
  file?: string;
  summary: string;
  evidence: string[];
  blocking: boolean;
}

export interface ProtocolPatch {
  target: "project" | "contracts" | "runtime" | "validation" | "workflow";
  action: "replace" | "append" | "remove";
  path: string;
  value?: unknown;
  reason: string;
}

export type ValidationFailureType =
  | "planning_gap"
  | "implementation_bug"
  | "environment_gap"
  | "runtime_gap";

export interface ValidationFinding {
  type: ValidationFailureType;
  summary: string;
  file?: string;
  evidence: string[];
}

export interface ValidationReport {
  version: "v1";
  status: "pass" | "fail";
  failureType?: ValidationFailureType;
  blocking: boolean;
  findings: ValidationFinding[];
}

export interface RuntimeStateSnapshot {
  version: "v1";
  envReady: boolean;
  hostDepsReady: boolean;
  testRuntimeReady: boolean;
  deployRuntimeReady: boolean;
  executionBackend?: "docker" | "host";
  containerId?: string;
  hostPort?: number;
  containerPort?: number;
  deploymentUrl?: string;
  startupLogPath?: string;
  runtimePid?: number;
  tokenUsage?: TokenUsageSummary;
}

export interface RepairPlan {
  version: "v1";
  repairType: "planning" | "implementation" | "environment" | "runtime";
  targets: string[];
  allowedEdits: string[];
  expectedEvidence: string[];
}

export interface CustomerApprovalCheckpoint {
  stage: "requirements" | "solution" | "deploy";
  required: boolean;
  approved: boolean;
  approvedBy?: "customer" | "default-authorization";
  summary: string;
  timestamp?: string;
}

export interface CustomerApprovalState {
  version: "v1";
  autoApprove: {
    requirements: boolean;
    solution: boolean;
    deploy: boolean;
  };
  checkpoints: CustomerApprovalCheckpoint[];
}

export type ApprovalStage = "requirements" | "solution" | "deploy";

export interface TokenUsageStats {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 本次/本分类的 input 费用（USD） */
  inputCost?: number;
  /** 本次/本分类的 output 费用（USD） */
  outputCost?: number;
  /** 本次/本分类的总费用（USD） */
  totalCost?: number;
}

export interface TokenUsageEntry extends TokenUsageStats {
  timestamp: string;
  agent: string;
  mode: string;
  model?: string;
}

export interface TokenUsageSummary extends TokenUsageStats {
  byAgent: Record<string, TokenUsageStats>;
}

export interface TraceIndex {
  traceId: string;
  lastNode: string;
  retryCount: number;
  timestamp: string;
  meetingNotes: MeetingNote[];
  fileChanges: FileChangeEntry[];
  files: Record<string, TraceFileSummary>;
  timeline: TraceTimelineEntry[];
  checkpoints: TraceCheckpoint[];
  tokenUsage: TokenUsageSummary;
  protocolFailures: ProtocolFailure[];
  protocolPatches: ProtocolPatch[];
  lastFailure: {
    node?: string;
    summary?: string;
  };
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
  contractSource: Annotation<PlanningSource>({
    reducer: (x, y) => y ?? x,
  }),
  productSpec: Annotation<ProductSpec | null>({
    reducer: (x, y) => y ?? x,
  }),
  spec: Annotation<TechSpec | null>({
    reducer: (x, y) => y ?? x,
  }),
  designSource: Annotation<PlanningSource>({
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
  /** 增量修改模式：上一次 run 的 workspace 路径 */
  previousWorkspacePath: Annotation<string | null>({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
  /** 增量修改模式：已有代码文件快照 { relativePath: content } */
  existingFiles: Annotation<Record<string, string> | null>({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
  /** 增量修改模式：Architect 标记需要重写的已有文件路径列表 */
  modifyFilesToOverwrite: Annotation<string[] | null>({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
  /** 增量修改模式：原始任务契约 */
  previousContract: Annotation<TaskContract | null>({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
  /** 增量修改模式：原始技术规范 */
  previousSpec: Annotation<TechSpec | null>({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
  orchestrationSource: Annotation<PlanningSource>({
    reducer: (x, y) => y ?? x,
  }),
  sprintPlans: Annotation<SprintPlan[]>({
    reducer: (x, y) => y !== undefined ? y : (x || []),
  }),
  activeSprintId: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  sprintContracts: Annotation<SprintContract[]>({
    reducer: (x, y) => y !== undefined ? y : (x || []),
  }),
  evaluationResults: Annotation<EvaluationResult[]>({
    reducer: (x, y) => [...(x || []), ...(y || [])],
  }),
  repairContracts: Annotation<RepairContract[]>({
    reducer: (x, y) => {
      if (y === undefined) return x || [];
      const map = new Map((x || []).map((item) => [item.sprintId, item]));
      (y || []).forEach((item) => map.set(item.sprintId, item));
      return Array.from(map.values());
    },
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
  executionBackend: Annotation<"docker" | "host" | null>({
    reducer: (x, y) => y ?? x,
  }),
  hostRuntimePid: Annotation<number | null>({
    reducer: (x, y) => y ?? x,
  }),
  hostRuntimeLogPath: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  maxRetries: Annotation<number>({
    reducer: (x, y) => y ?? x,
  }),
  coderMaxParallel: Annotation<number>({
    reducer: (x, y) => y ?? x,
  }),
  coderExperimentalModelParallel: Annotation<boolean>({
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
  envReady: Annotation<boolean | null>({
    reducer: (x, y) => y ?? x,
  }),
  blockedReason: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  validationCheckpointRequested: Annotation<boolean>({
    reducer: (x, y) => y ?? x,
  }),
  validationCheckpointCompleted: Annotation<boolean>({
    reducer: (x, y) => y ?? x,
  }),
  validationCheckpointReason: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  resumeAfterValidation: Annotation<boolean>({
    reducer: (x, y) => y ?? x,
  }),
  resumeFromNode: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  recoveredEnvironment: Annotation<boolean>({
    reducer: (x, y) => y ?? x,
  }),
  lastFailedNode: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  lastFailureSummary: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  forceRebuildContainer: Annotation<boolean>({
    reducer: (_x, y) => y ?? false,
    default: () => false,
  }),
  failureFingerprint: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  sameFailureCount: Annotation<number>({
    reducer: (x, y) => y ?? x,
  }),
  repairLedger: Annotation<RepairLedgerEntry[]>({
    reducer: (x, y) => [...(x || []), ...(y || [])],
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
  requirementProtocol: Annotation<RequirementProtocol | null>({
    reducer: (x, y) => y ?? x,
  }),
  technologyDecision: Annotation<TechnologyDecision | null>({
    reducer: (x, y) => y ?? x,
  }),
  executionPlan: Annotation<ExecutionPlan | null>({
    reducer: (x, y) => y ?? x,
  }),
  solutionProtocol: Annotation<SolutionProtocol | null>({
    reducer: (x, y) => y ?? x,
  }),
  executionProtocol: Annotation<ExecutionProtocol | null>({
    reducer: (x, y) => y ?? x,
  }),
  validationReport: Annotation<ValidationReport | null>({
    reducer: (x, y) => y ?? x,
  }),
  runtimeStateSnapshot: Annotation<RuntimeStateSnapshot | null>({
    reducer: (x, y) => y ?? x,
  }),
  repairPlan: Annotation<RepairPlan | null>({
    reducer: (x, y) => y ?? x,
  }),
  customerApprovalState: Annotation<CustomerApprovalState | null>({
    reducer: (x, y) => y ?? x,
  }),
  executorState: Annotation<ExecutorState | null>({
    reducer: (x, y) => y ?? x,
  }),
  pendingApprovalStage: Annotation<ApprovalStage | null>({
    reducer: (x, y) => y ?? x,
  }),
  pendingApprovalTicketId: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  approvalNextNode: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  agentRecoveryPending: Annotation<boolean>({
    reducer: (x, y) => y ?? x,
  }),
  agentRecoveryNode: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  agentRecoveryReason: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  agentRecoveryRetryCount: Annotation<number>({
    reducer: (x, y) => y ?? x,
  }),
  protocolFailures: Annotation<ProtocolFailure[]>({
    reducer: (x, y) => y !== undefined ? y : (x || []),
  }),
  protocolPatches: Annotation<ProtocolPatch[]>({
    reducer: (x, y) => y !== undefined ? y : (x || []),
  }),
});

export type JimClawState = typeof JimClawState.State;
