import * as fs from "fs/promises";
import * as path from "path";
import * as ts from "typescript";
import { JimClawState, FileChangeEntry, ConsensusProgress } from "../graph_types";
import { AgentTimeoutError, BaseAgent } from "../agent";
import {
  buildCoderExecutionContext,
  getProtocolFileContract,
  getDeterministicTemplateScaffold,
  getExecutionDependencyStem,
  isAggregateExecutionServiceFile,
  logPrefix,
  writeMeetingNote,
  persistWriteRecoveryIntent,
  clearWriteRecoveryIntent
} from "../logic_utils";
import { extractText, extractCodeFromResponse } from "../../utils/common";

function isNodeLikeLanguage(language?: string): boolean {
  const normalized = String(language || "").toLowerCase();
  return /typescript|javascript|node/.test(normalized);
}

function getCoderMaxParallel(state: JimClawState): number {
  const raw = Number((state as any).coderMaxParallel || 1);
  if (!Number.isFinite(raw) || raw <= 1) return 1;
  return Math.min(Math.floor(raw), 4);
}

function isExperimentalModelParallelEnabled(state: JimClawState): boolean {
  return Boolean((state as any).coderExperimentalModelParallel);
}

async function hasWorkspaceNodeModules(workspace: string): Promise<boolean> {
  try {
    await fs.access(path.join(workspace, "node_modules"));
    return true;
  } catch {
    return false;
  }
}

function isUiLikeFile(fileTarget: string): boolean {
  const normalized = String(fileTarget || "").replace(/\\/g, "/").toLowerCase();
  return normalized.startsWith("public/") || normalized.endsWith(".html");
}

function getCheckpointRole(state: JimClawState, fileTarget: string): string {
  if (isUiLikeFile(fileTarget)) return "ui";
  return getProtocolFileContract(state.executionProtocol, fileTarget)?.role || "other";
}

function isAppShellFile(fileTarget: string): boolean {
  const normalized = normalizeTaskFileTarget(fileTarget).toLowerCase();
  return /(^|\/)(app|server|main)\.(ts|tsx|js|jsx|py|go)$/i.test(normalized);
}

function isPeripheralFile(fileTarget: string): boolean {
  const normalized = normalizeTaskFileTarget(fileTarget).toLowerCase();
  return (
    normalized === ".env.example" ||
    normalized.startsWith("data/") ||
    normalized === "readme.md" ||
    normalized.startsWith("docs/") ||
    normalized.endsWith(".md") ||
    normalized === "dockerfile" ||
    normalized.endsWith("/dockerfile") ||
    normalized.endsWith("docker-compose.yml") ||
    normalized.startsWith("scripts/")
  );
}

function isPlanningFallbackActive(state: JimClawState): boolean {
  return (
    state.designSource === "deterministic-fallback" ||
    state.orchestrationSource === "deterministic-fallback"
  );
}

function isSafeDeterministicScaffoldFile(fileTarget: string): boolean {
  const normalized = normalizeTaskFileTarget(fileTarget).toLowerCase();
  return (
    normalized === "package.json" ||
    normalized === "requirements.txt" ||
    normalized === "tsconfig.json" ||
    /^(jest\.config\.(cjs|js|ts)|vitest\.config\.(ts|js|mjs))$/i.test(normalized) ||
    normalized === "tests/setup.test.ts" ||
    normalized === ".env.example" ||
    normalized === ".dockerignore" ||
    normalized === "dockerfile" ||
    normalized.endsWith("docker-compose.yml") ||
    normalized === "public/index.html" ||
    (normalized.startsWith("tests/") && /\.test\.[^.]+$/i.test(normalized)) ||
    normalized === "readme.md" ||
    /^scripts\/verify\.[^.]+$/i.test(normalized) ||
    normalized === "src/errors.ts" ||
    normalized === "src/logging/logger.ts" ||
    normalized === "src/logger.ts" ||
    normalized === "src/middleware/logger.ts" ||
    normalized === "src/middleware/auth.ts" ||
    normalized === "src/controllers/authcontroller.ts" ||
    normalized === "src/routes/auth.ts"
  );
}

function isCompactAuthFallbackRuntimeScaffoldFile(state: JimClawState, fileTarget: string): boolean {
  if (!isPlanningFallbackActive(state)) return false;
  const normalized = normalizeTaskFileTarget(fileTarget).toLowerCase();
  return (
    normalized === "src/services/authservice.ts" ||
    /^src\/services\/auth[a-z0-9]+service\.ts$/i.test(normalized)
  );
}

function isAcceptedFallbackValidationArtifact(state: JimClawState, fileTarget: string, generationSource?: string): boolean {
  if (generationSource !== "deterministic_scaffold") return true;
  return isCompactAuthFallbackRuntimeScaffoldFile(state, fileTarget);
}

function resolveAllowedDeterministicScaffold(state: JimClawState, fileTarget: string): string {
  const deterministicScaffold = getDeterministicTemplateScaffold(state, fileTarget);
  if (!deterministicScaffold) return "";
  const scaffoldAllowed = Boolean(
    !isPlanningFallbackActive(state) ||
    isSafeDeterministicScaffoldFile(fileTarget) ||
    isCompactAuthFallbackRuntimeScaffoldFile(state, fileTarget)
  );
  return scaffoldAllowed ? deterministicScaffold : "";
}

function isValidationCoreFile(state: JimClawState, fileTarget: string): boolean {
  const role = getCheckpointRole(state, fileTarget);
  return ["entry", "route", "controller", "service", "repository", "model", "middleware"].includes(role);
}

function getLatestFileChangeEntry(
  entries: FileChangeEntry[],
  fileTarget: string
): FileChangeEntry | undefined {
  const normalized = normalizeTaskFileTarget(fileTarget);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (normalizeTaskFileTarget(entry.file) === normalized) {
      return entry;
    }
  }
  return undefined;
}

function getReopenedFileTargets(state: JimClawState): Set<string> {
  return new Set(
    [
      ...((state.qaFailures?.failedFiles || []).map((file) => normalizeTaskFileTarget(file))),
      ...(((state.fixPlan || []) as Array<{ fileTarget: string }>).map((item) => normalizeTaskFileTarget(item.fileTarget))),
    ].filter(Boolean)
  );
}

function getTaskExecutionPriority(state: JimClawState, task: { fileTarget: string }): number {
  const fileTarget = normalizeTaskFileTarget(task.fileTarget);
  if (getReopenedFileTargets(state).has(fileTarget)) return -100;
  const role = getCheckpointRole(state, fileTarget);
  if (fileTarget === "package.json") return 0;
  if (fileTarget === "tsconfig.json") return 1;
  if (/^(jest\.config\.(cjs|js|ts)|vitest\.config\.(ts|js|mjs))$/i.test(fileTarget)) return 2;
  if (role === "model") return 10;
  if (role === "repository") return 20;
  if (role === "service") return 30;
  if (role === "middleware") return 40;
  if (role === "controller") return 50;
  if (role === "route") return 60;
  if (role === "entry" || isAppShellFile(fileTarget)) return 70;
  if (role === "ui") return 80;
  if (role === "test") return 90;
  if (isPeripheralFile(fileTarget)) return 200;
  return 120;
}

function isCorePhaseDeferredFile(fileTarget: string): boolean {
  const normalized = normalizeTaskFileTarget(fileTarget).toLowerCase();
  return (
    normalized === ".env.example" ||
    normalized.startsWith("public/") ||
    normalized.startsWith("tests/") ||
    normalized.includes("/__tests__/") ||
    /\.test\.[^.]+$/.test(normalized) ||
    /\.spec\.[^.]+$/.test(normalized) ||
    normalized === "readme.md" ||
    normalized.startsWith("docs/") ||
    normalized.startsWith("scripts/") ||
    normalized === "dockerfile" ||
    normalized.endsWith("/dockerfile") ||
    normalized.endsWith("docker-compose.yml") ||
    normalized.startsWith("data/")
  );
}

function isCorePhaseActive(
  state: JimClawState,
  subTasks: Array<{ fileTarget: string }> = []
): boolean {
  // Python/Go/Java 项目子任务少且依赖关系清晰，不分阶段全部写完
  const lang = (state.spec?.language || "").toLowerCase();
  if (lang.includes("python") || lang.includes("go") || lang.includes("java")) return false;
  return (state.retryCount || 0) === 0 && !state.validationCheckpointCompleted && subTasks.length >= 10;
}

function getCoderTaskTimeoutMs(
  state: JimClawState,
  subTasks: Array<{ fileTarget: string }>,
  localAttempt: number = 0
): number {
  const overrideTimeout = Number((state as any).coderTaskTimeoutMs || 0);
  const baseTimeout = overrideTimeout > 0 ? overrideTimeout : (isCorePhaseActive(state, subTasks) ? 120000 : 240000);
  if (localAttempt <= 0) return baseTimeout;
  // 慢进度超时时给一次预算提升，避免“有进度却被硬切”。
  return Math.min(Math.round(baseTimeout * 1.5), 360000);
}

function getCoderFirstWriteTimeoutMs(
  state: JimClawState,
  subTasks: Array<{ fileTarget: string }>,
  fileTarget: string
): number {
  const overrideTimeout = Number((state as any).coderFirstWriteTimeoutMs || 0);
  if (overrideTimeout > 0) return overrideTimeout;
  if (!isCorePhaseActive(state, subTasks)) return 0;
  const normalized = normalizeTaskFileTarget(fileTarget).toLowerCase();
  const isHeavyRole = normalized.includes("/services/") || normalized.includes("/controllers/") || normalized.includes("/routes/");
  if (!isHeavyRole) return 0;
  return 90000;
}

function isAgentTimeoutError(error: any): boolean {
  return (
    error instanceof AgentTimeoutError ||
    error?.code === "AGENT_TIMEOUT" ||
    error?.name === "AgentTimeoutError"
  );
}

function eventContainsExtractableCode(event: any): boolean {
  const candidates = [
    event?.response,
    event?.content,
    event?.metadata?.response,
    event?.metadata?.content,
  ];
  return candidates.some((candidate) => {
    if (typeof candidate !== "string" || !candidate.includes("```")) return false;
    return extractCodeFromResponse(candidate).isValid;
  });
}

async function invokeCoderWithTaskTimeout(args: {
  agent: {
    chat: (
      messages: Array<{ role: string; content: string }>,
      onEvent?: (event: any) => void,
      options?: Record<string, any>
    ) => Promise<any>;
    getPersona?: () => { name?: string };
  };
  prompt: string;
  onEvent: (event: any) => void;
  brief: string[];
  workspaceDir: string;
  timeoutMs: number;
  firstWriteTimeoutMs?: number;
}): Promise<any> {
  const controller = new AbortController();
  const agentName = args.agent.getPersona?.()?.name || "Coder";
  let timeoutHandle: NodeJS.Timeout | null = null;
  let firstWriteHandle: NodeJS.Timeout | null = null;
  let firstWriteObserved = false;
  let progressObserved = false;
  let lastEventAt = Date.now();

  try {
    const wrappedOnEvent = (event: any) => {
      progressObserved = true;
      lastEventAt = Date.now();
      const contentStr = String(event?.content || "");
      if (!firstWriteObserved) {
        const wroteFile = event?.tool === "write_file" && contentStr.includes("Successfully wrote");
        const emittedCompleteCode = eventContainsExtractableCode(event);
        if (wroteFile || emittedCompleteCode) {
          firstWriteObserved = true;
          if (firstWriteHandle) {
            clearTimeout(firstWriteHandle);
            firstWriteHandle = null;
          }
        }
      }
      args.onEvent(event);
    };

    const chatPromise = Promise.resolve(
      args.agent.chat(
        [{ role: "user", content: args.prompt }],
        wrappedOnEvent,
        {
          mode: "coding",
          brief: args.brief,
          workspaceDir: args.workspaceDir,
          timeoutMs: args.timeoutMs,
          signal: controller.signal,
        }
      )
    );

    const firstWriteTimeoutPromise = new Promise<never>((_, reject) => {
      if (!args.firstWriteTimeoutMs || args.firstWriteTimeoutMs <= 0) return;
      firstWriteHandle = setTimeout(() => {
        if (firstWriteObserved) return;
        const timeoutError: any = new Error(`${agentName} 首个写入超时（>${args.firstWriteTimeoutMs}ms）`);
        timeoutError.name = "FirstWriteTimeoutError";
        timeoutError.code = "CODER_FIRST_WRITE_TIMEOUT";
        timeoutError.timeoutMs = args.firstWriteTimeoutMs;
        controller.abort(timeoutError);
        reject(timeoutError);
      }, args.firstWriteTimeoutMs);
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const timeoutError: any = new AgentTimeoutError(agentName, args.timeoutMs);
        timeoutError.timeoutKind = progressObserved ? "slow_progress" : "no_progress";
        timeoutError.progressObserved = progressObserved;
        timeoutError.firstWriteObserved = firstWriteObserved;
        timeoutError.lastEventAgoMs = Date.now() - lastEventAt;
        controller.abort(timeoutError);
        reject(timeoutError);
      }, args.timeoutMs);
    });

    return await Promise.race([chatPromise, timeoutPromise, firstWriteTimeoutPromise]);
  } catch (error: any) {
    if (controller.signal.aborted && (isAgentTimeoutError(controller.signal.reason) || controller.signal.reason?.code === "CODER_FIRST_WRITE_TIMEOUT")) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (firstWriteHandle) {
      clearTimeout(firstWriteHandle);
    }
  }
}

function getPrioritizedSubTasks(
  state: JimClawState,
  subTasks: Array<{ fileTarget: string }>
): Array<{ fileTarget: string }> {
  return [...subTasks].sort((left, right) => {
    const priorityDelta = getTaskExecutionPriority(state, left) - getTaskExecutionPriority(state, right);
    if (priorityDelta !== 0) return priorityDelta;
    return normalizeTaskFileTarget(left.fileTarget).localeCompare(normalizeTaskFileTarget(right.fileTarget));
  });
}

function hasCompletedFile(subTasks: Array<{ fileTarget: string; status: string }>, expected: string): boolean {
  return subTasks.some((task) => task.fileTarget.replace(/\\/g, "/") === expected && task.status === "completed");
}

function shouldRequestValidationCheckpoint(
  state: JimClawState,
  subTasks: Array<{ fileTarget: string; status: string }>,
  pendingCodeLogEntries: FileChangeEntry[] = []
): {
  requested: boolean;
  reason: string;
} {
  if ((state.retryCount || 0) !== 0) return { requested: false, reason: "" };
  if (state.validationCheckpointCompleted) return { requested: false, reason: "" };
  if ((subTasks || []).length < 10) return { requested: false, reason: "" };

  const pendingTasks = subTasks.filter((task) => task.status !== "completed");
  if (pendingTasks.length === 0) return { requested: false, reason: "" };

  const completedTasks = subTasks.filter((task) => task.status === "completed");
  if (completedTasks.length < 10) return { requested: false, reason: "" };

  const allRoles = new Set(subTasks.map((task) => getCheckpointRole(state, task.fileTarget)));
  const completedRoles = new Set(completedTasks.map((task) => getCheckpointRole(state, task.fileTarget)));
  const requiredRoles = ["entry", "route", "controller", "service", "model"];
  if (allRoles.has("repository")) requiredRoles.push("repository");
  if (state.requirementProtocol?.capabilities?.authRequired || allRoles.has("middleware")) requiredRoles.push("middleware");

  if (!hasCompletedFile(completedTasks, "package.json")) return { requested: false, reason: "" };
  if (subTasks.some((task) => task.fileTarget === "tsconfig.json") && !hasCompletedFile(completedTasks, "tsconfig.json")) {
    return { requested: false, reason: "" };
  }
  const hasTestConfigTask = subTasks.some((task) => /^(jest\.config\.(cjs|js|ts)|vitest\.config\.(ts|js|mjs))$/i.test(task.fileTarget));
  if (hasTestConfigTask) {
    const testConfigReady = completedTasks.some((task) => /^(jest\.config\.(cjs|js|ts)|vitest\.config\.(ts|js|mjs))$/i.test(task.fileTarget));
    if (!testConfigReady) return { requested: false, reason: "" };
  }

  for (const role of requiredRoles) {
    if (!completedRoles.has(role)) return { requested: false, reason: "" };
  }

  if (isPlanningFallbackActive(state)) {
    const combinedCodeLog = [...(state.codeLog || []), ...pendingCodeLogEntries];
    const validatedRoles = new Set(
      completedTasks
        .filter((task) => isValidationCoreFile(state, task.fileTarget))
        .filter((task) => {
          const latest = getLatestFileChangeEntry(combinedCodeLog, task.fileTarget);
          return latest?.status === "written" && isAcceptedFallbackValidationArtifact(state, task.fileTarget, latest.generationSource);
        })
        .map((task) => getCheckpointRole(state, task.fileTarget))
    );
    for (const role of requiredRoles) {
      if (!validatedRoles.has(role)) return { requested: false, reason: "" };
    }
  }

  return {
    requested: true,
    reason: `首轮后端核心骨架已完成（${completedTasks.length}/${subTasks.length}），先进行环境与可运行性验证，再继续补齐前端、测试与部署外围文件`,
  };
}

function formatTsDiagnostics(fileTarget: string, content: string, diagnostics: readonly ts.Diagnostic[]): string {
  return diagnostics
    .map((diag) => {
      const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
      if (typeof diag.start !== "number") {
        return `语法错误: ${message}`;
      }

      const sourceFile = ts.createSourceFile(fileTarget, content, ts.ScriptTarget.ES2020, true);
      const position = sourceFile.getLineAndCharacterOfPosition(diag.start);
      const lineNumber = position.line + 1;
      const columnNumber = position.character + 1;
      const lineText = sourceFile.text.split(/\r?\n/)[position.line] || "";
      const snippet = lineText.trim().slice(0, 160);
      return `语法错误(L${lineNumber}:C${columnNumber}): ${message}${snippet ? ` | ${snippet}` : ""}`;
    })
    .join("; ");
}

function validateGeneratedFileContent(fileTarget: string, content: string): string | null {
  const trimmed = content.trim();
  const ext = path.extname(fileTarget).toLowerCase();

  if (!trimmed) {
    return "生成内容为空，不能作为有效文件提交";
  }

  if (ext === ".json") {
    try {
      JSON.parse(trimmed);
      return null;
    } catch (error: any) {
      return `JSON 格式校验失败: ${error.message || error}`;
    }
  }

  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
    const diagnostics = ts.transpileModule(content, {
      fileName: fileTarget,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
      },
    }).diagnostics || [];
    if (diagnostics.length > 0) {
      return formatTsDiagnostics(fileTarget, content, diagnostics);
    }

    const looksLikeObjectFragment =
      trimmed.startsWith("{") &&
      trimmed.endsWith("}") &&
      !/(export|import|const|let|var|function|class|interface|type|enum|=>|module\.exports|return|\=)/.test(trimmed);
    if (looksLikeObjectFragment) {
      return "检测到孤立对象片段，缺少完整模块或语句结构";
    }
  }

  return null;
}

function summarizeSelfHealArtifact(content: string, max = 400): string {
  const normalized = String(content || "").replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function isLocalSelfHealContentError(message: string | null | undefined): boolean {
  const text = String(message || "").trim();
  if (!text) return false;
  return (
    /语法错误/i.test(text) ||
    /JSON 格式校验失败/i.test(text) ||
    /Markdown 格式的汇报|非纯净代码/i.test(text) ||
    /代码提取失败|提取失败|未找到.*代码块|未检测到.*代码块|无法提取/i.test(text)
  );
}

function shouldRetryTaskLocally(options: {
  attempt: number;
  toolError: string | null;
  formatError: string | null;
  extractError: string;
  unauthorizedWriteTargets: Set<string>;
}): boolean {
  if (options.attempt > 1) return false;
  if (options.unauthorizedWriteTargets.size > 0) return false;
  if (options.toolError) return false;
  return (
    isLocalSelfHealContentError(options.formatError) ||
    isLocalSelfHealContentError(options.extractError) ||
    /慢进度超时/i.test(options.extractError)
  );
}

function normalizeTaskFileTarget(fileTarget: string): string {
  return String(fileTarget || "").replace(/\\/g, "/");
}

function isControllerFile(fileTarget: string): boolean {
  return normalizeTaskFileTarget(fileTarget).toLowerCase().includes("/controllers/");
}

function isMiddlewareFile(fileTarget: string): boolean {
  return normalizeTaskFileTarget(fileTarget).toLowerCase().includes("/middleware/");
}

function isModelFile(fileTarget: string): boolean {
  return normalizeTaskFileTarget(fileTarget).toLowerCase().includes("/models/");
}

function isServiceFile(fileTarget: string): boolean {
  return normalizeTaskFileTarget(fileTarget).toLowerCase().includes("/services/");
}

function isCrossCuttingStructuralFile(fileTarget: string): boolean {
  const stem = getExecutionDependencyStem(fileTarget);
  return ["auth", "permission", "rbac", "logger", "logging", "error", "audit"].includes(stem);
}

function pickSameStemTargets(
  targets: string[],
  currentFile: string,
  stem: string,
  options?: { preferAggregateService?: boolean; includeCrossCutting?: boolean }
): string[] {
  const normalizedStem = String(stem || "").toLowerCase();
  const candidates = targets.filter((target) => normalizeTaskFileTarget(target) !== normalizeTaskFileTarget(currentFile));
  const sameStem = normalizedStem
    ? candidates.filter((target) => getExecutionDependencyStem(target) === normalizedStem)
    : [];
  const picked = options?.preferAggregateService
    ? (() => {
        const aggregate = sameStem.find((target) => isAggregateExecutionServiceFile(target));
        return aggregate ? [aggregate] : sameStem.slice(0, 1);
      })()
    : sameStem;
  if (!options?.includeCrossCutting) return picked;
  return Array.from(new Set([...picked, ...candidates.filter((target) => isCrossCuttingStructuralFile(target))]));
}

function pickSplitServiceHelperTargets(targets: string[], currentFile: string, stem: string): string[] {
  const normalizedStem = String(stem || "").toLowerCase();
  if (!normalizedStem || !isAggregateExecutionServiceFile(currentFile)) return [];
  return targets
    .filter((target) => normalizeTaskFileTarget(target) !== normalizeTaskFileTarget(currentFile))
    .filter((target) => getExecutionDependencyStem(target) === normalizedStem)
    .filter((target) => !isAggregateExecutionServiceFile(target));
}

export function normalizeStructuralDependencies(
  subTasks: Array<{ id?: string; fileTarget: string; dependencies?: string[] }>
): void {
  const resolveDependency = (dependency: string): string => {
    const normalizedDependency = normalizeTaskFileTarget(dependency);
    const dependencyTask = subTasks.find((candidate) => candidate.id === normalizedDependency || normalizeTaskFileTarget(candidate.fileTarget) === normalizedDependency);
    return dependencyTask ? normalizeTaskFileTarget(dependencyTask.fileTarget) : normalizedDependency;
  };
  const controllerTargets = subTasks.map((task) => normalizeTaskFileTarget(task.fileTarget)).filter(isControllerFile);
  const middlewareTargets = subTasks.map((task) => normalizeTaskFileTarget(task.fileTarget)).filter(isMiddlewareFile);
  const modelTargets = subTasks.map((task) => normalizeTaskFileTarget(task.fileTarget)).filter(isModelFile);
  const serviceTargets = subTasks.map((task) => normalizeTaskFileTarget(task.fileTarget)).filter(isServiceFile);

  for (const task of subTasks) {
    const fileTarget = normalizeTaskFileTarget(task.fileTarget);
    const dependencyStem = getExecutionDependencyStem(fileTarget);
    const nextDependencies = new Set((task.dependencies || []).map((dependency) => resolveDependency(dependency)));

    if (isControllerFile(fileTarget)) {
      for (const dependency of Array.from(nextDependencies)) {
        if (isRouteFile(dependency)) {
          nextDependencies.delete(dependency);
        }
      }
      for (const dependency of pickSameStemTargets(serviceTargets, fileTarget, dependencyStem, { preferAggregateService: true })) nextDependencies.add(dependency);
      for (const dependency of pickSameStemTargets(modelTargets, fileTarget, dependencyStem)) nextDependencies.add(dependency);
      for (const dependency of pickSameStemTargets(middlewareTargets, fileTarget, dependencyStem, { includeCrossCutting: true })) nextDependencies.add(dependency);
    }

    if (isMiddlewareFile(fileTarget)) {
      for (const dependency of Array.from(nextDependencies)) {
        if (isControllerFile(dependency) || isRouteFile(dependency)) {
          nextDependencies.delete(dependency);
        }
      }
      for (const dependency of pickSameStemTargets(serviceTargets, fileTarget, dependencyStem, { preferAggregateService: true })) nextDependencies.add(dependency);
      for (const dependency of pickSameStemTargets(modelTargets, fileTarget, dependencyStem)) nextDependencies.add(dependency);
    }

    if (isModelFile(fileTarget)) {
      for (const dependency of Array.from(nextDependencies)) {
        if (isControllerFile(dependency) || isRouteFile(dependency) || isMiddlewareFile(dependency)) {
          nextDependencies.delete(dependency);
        }
      }
    }

    if (isServiceFile(fileTarget)) {
      for (const dependency of Array.from(nextDependencies)) {
        if (isControllerFile(dependency) || isRouteFile(dependency)) {
          nextDependencies.delete(dependency);
        }
      }
      for (const dependency of pickSplitServiceHelperTargets(serviceTargets, fileTarget, dependencyStem)) nextDependencies.add(dependency);
      for (const dependency of pickSameStemTargets(modelTargets, fileTarget, dependencyStem)) nextDependencies.add(dependency);
    }

    if (isRouteFile(fileTarget)) {
      for (const dependency of Array.from(nextDependencies)) {
        if (dependency.endsWith("src/index.ts") || dependency.endsWith("/index.ts") || dependency.endsWith("/index.js")) {
          nextDependencies.delete(dependency);
        }
      }
      for (const dependency of pickSameStemTargets(controllerTargets, fileTarget, dependencyStem)) nextDependencies.add(dependency);
      for (const dependency of pickSameStemTargets(middlewareTargets, fileTarget, dependencyStem, { includeCrossCutting: true })) nextDependencies.add(dependency);
    }

    task.dependencies = Array.from(nextDependencies);
  }
}

function buildCompactTaskSpecSummary(
  state: JimClawState,
  task: { fileTarget: string; dependencies?: string[] }
): string {
  const spec = (state.spec || {}) as any;
  const dependencyFiles = (task.dependencies || [])
    .map((dependency) => {
      const normalizedDependency = normalizeTaskFileTarget(dependency);
      const dependencyTask = (state.subTasks || []).find((item) => item.id === normalizedDependency || normalizeTaskFileTarget(item.fileTarget) === normalizedDependency);
      return dependencyTask?.fileTarget || (/[/\\.]/.test(normalizedDependency) ? normalizedDependency : "");
    })
    .filter(Boolean);
  return JSON.stringify(
    {
      language: spec.language || "",
      framework: spec.framework || "",
      testCommand: spec.testCommand || "",
      runCommand: spec.runCommand || "",
      entryPoint: spec.entryPoint || "",
      declaredFiles: Array.from(new Set([normalizeTaskFileTarget(task.fileTarget), ...dependencyFiles])),
      dependencies: Object.keys(spec.dependencies || {}),
      devDependencies: Object.keys(spec.devDependencies || {}),
    },
    null,
    2
  );
}

function areTaskDependenciesSatisfied(
  task: { dependencies?: string[] },
  subTasks: Array<{ id: string; fileTarget: string; status: string }>,
  filesContent: Record<string, string>,
): boolean {
  const dependencies = task.dependencies || [];
  if (dependencies.length === 0) return true;

  return dependencies.every((dependency) => {
    if (filesContent[dependency] !== undefined) return true;
    // jest.config 变体名兼容
    if (/jest\.config\.(js|ts|mjs)$/.test(dependency)) {
      const cjsVariant = dependency.replace(/\.(js|ts|mjs)$/, ".cjs");
      if (filesContent[cjsVariant] !== undefined) return true;
      const cjsTask = subTasks.find((item) => item.fileTarget === cjsVariant);
      if (cjsTask?.status === "completed") return true;
    }
    const dependencyTask = subTasks.find((item) => item.fileTarget === dependency || item.id === dependency);
    return dependencyTask?.status === "completed";
  });
}

function isTestFile(fileTarget: string): boolean {
  const normalized = fileTarget.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/tests/") ||
    normalized.includes("/__tests__/") ||
    /\.test\.[^.]+$/.test(normalized) ||
    /\.spec\.[^.]+$/.test(normalized)
  );
}

function isRouteFile(fileTarget: string): boolean {
  const normalized = fileTarget.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/routes/") && !isTestFile(normalized);
}

function shouldUseFocusedContext(task: { fileTarget: string; dependencies?: string[] }): boolean {
  return isTestFile(task.fileTarget) || isRouteFile(task.fileTarget) || (task.dependencies || []).length > 0;
}

function getFocusedContextFiles(
  task: { fileTarget: string; dependencies?: string[] },
  filesContent: Record<string, string>
): string[] {
  const focused = new Set<string>();

  for (const dependency of task.dependencies || []) {
    const normalizedDependency = dependency.replace(/\\/g, "/");
    if (filesContent[normalizedDependency] !== undefined) {
      focused.add(normalizedDependency);
    }
  }

  return Array.from(focused);
}

function buildFocusedContextSnippets(
  task: { fileTarget: string },
  files: string[],
  filesContent: Record<string, string>
): Array<{ file: string; content: string; truncated: boolean }> {
  const isTest = isTestFile(task.fileTarget);
  const maxPerFile = isTest ? 3000 : 8000;
  const maxTotal = isTest ? 12000 : 24000;
  const snippets: Array<{ file: string; content: string; truncated: boolean }> = [];
  let remaining = maxTotal;

  for (const file of files) {
    if (remaining <= 0) break;
    const source = filesContent[file] || "";
    if (!source) continue;
    const limit = Math.min(maxPerFile, remaining);
    const truncated = source.length > limit;
    const content = truncated ? source.slice(0, limit) : source;
    snippets.push({ file, content, truncated });
    remaining -= content.length;
  }

  return snippets;
}

function singularizeStem(value: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized.endsWith("ies")) return `${normalized.slice(0, -3)}y`;
  if (normalized.endsWith("ses")) return normalized.slice(0, -2);
  if (normalized.endsWith("s") && normalized.length > 1) return normalized.slice(0, -1);
  return normalized;
}

function getTaskDomainStems(fileTarget: string): string[] {
  const normalized = normalizeTaskFileTarget(fileTarget).toLowerCase();
  const base = path.posix.basename(normalized, path.posix.extname(normalized));
  const stem = base
    .replace(/(controller|service|repository|model|routes?|middleware|test|spec)$/i, "")
    .trim();
  const singular = singularizeStem(stem);
  const plural = singular ? `${singular}s` : "";
  return Array.from(new Set([stem, singular, plural].filter(Boolean)));
}

function summarizeApiEndpoint(endpoint: any) {
  const request = endpoint?.request || {};
  const requestSummary: Record<string, string[]> = {};
  const bodyFields = Object.keys(request.body || {});
  const queryFields = Object.keys(request.query || {});
  const paramsFields = Object.keys(request.params || {});
  const headerKeys = Object.keys(request.headers || {});
  if (bodyFields.length > 0) requestSummary.bodyFields = bodyFields;
  if (queryFields.length > 0) requestSummary.queryFields = queryFields;
  if (paramsFields.length > 0) requestSummary.paramsFields = paramsFields;
  if (headerKeys.length > 0) requestSummary.headerKeys = headerKeys;

  return {
    method: String(endpoint?.method || "").toUpperCase(),
    path: String(endpoint?.path || ""),
    description: endpoint?.description || "",
    auth: endpoint?.auth || undefined,
    request: Object.keys(requestSummary).length > 0 ? requestSummary : undefined,
    responseStatus: Object.keys(endpoint?.responses || {}),
  };
}

function buildRelevantApiContract(task: { fileTarget: string }, state: JimClawState): string {
  const endpoints = state.apiContract?.endpoints || [];
  if (endpoints.length === 0) return "";

  const normalizedTarget = normalizeTaskFileTarget(task.fileTarget).toLowerCase();
  const fileContract = getProtocolFileContract(state.executionProtocol, normalizedTarget);
  const ownedEndpoints = new Set(
    (fileContract?.ownedEndpoints || []).map((entry) => String(entry || "").toUpperCase())
  );

  let relevantEndpoints = endpoints;
  if (ownedEndpoints.size > 0) {
    relevantEndpoints = endpoints.filter((endpoint) =>
      ownedEndpoints.has(`${String(endpoint.method || "").toUpperCase()} ${String(endpoint.path || "")}`.trim())
    );
  } else if (/\/health\./i.test(normalizedTarget)) {
    relevantEndpoints = endpoints.filter((endpoint) => /\/health$/i.test(String(endpoint.path || "")));
  } else {
    const stems = getTaskDomainStems(normalizedTarget);
    if (stems.length > 0) {
      const stemSet = new Set(stems);
      const narrowed = endpoints.filter((endpoint) =>
        String(endpoint.path || "")
          .toLowerCase()
          .split("/")
          .filter(Boolean)
          .some((segment) => stemSet.has(segment.replace(/:[^/]+/g, "")))
      );
      if (narrowed.length > 0) {
        relevantEndpoints = narrowed;
      }
    }

    if (/\/middleware\/auth/i.test(normalizedTarget)) {
      const authEndpoints = endpoints.filter((endpoint) => {
        const endpointPath = String(endpoint.path || "").toLowerCase();
        return /\/auth(\/|$)/.test(endpointPath) || Boolean((endpoint as any).auth);
      });
      if (authEndpoints.length > 0) {
        relevantEndpoints = authEndpoints;
      }
    }
  }

  const role = getProtocolFileContract(state.executionProtocol, normalizedTarget)?.role || "other";
  const maxEndpointsByRole: Record<string, number> = {
    service: 6,
    controller: 8,
    route: 8,
    middleware: 8,
    entry: 10,
    test: 10,
    other: 6,
  };
  const maxEndpoints = maxEndpointsByRole[role] || maxEndpointsByRole.other;
  const compactContract = {
    endpoints: relevantEndpoints
      .slice(0, maxEndpoints)
      .map((endpoint) => summarizeApiEndpoint(endpoint)),
  };
  return JSON.stringify(compactContract, null, 2);
}

function extractExportContract(code: string): { hasDefaultExport: boolean; namedExports: string[] } {
  const namedExports = new Set<string>();
  const hasDefaultExport = /\bexport\s+default\b/.test(code) || /\bmodule\.exports\s*=/.test(code);
  const patterns = [
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+class\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+interface\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+type\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+enum\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code))) {
      namedExports.add(match[1]);
    }
  }

  const groupedExportPattern = /\bexport\s*\{([^}]+)\}/g;
  let groupedMatch: RegExpExecArray | null;
  while ((groupedMatch = groupedExportPattern.exec(code))) {
    const items = groupedMatch[1]
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    for (const item of items) {
      const aliasMatch = item.match(/^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (aliasMatch) {
        namedExports.add(aliasMatch[2] || aliasMatch[1]);
      }
    }
  }

  return { hasDefaultExport, namedExports: Array.from(namedExports).sort() };
}

function buildDependencyContractText(
  filePaths: string[],
  filesContent: Record<string, string>
): string {
  return filePaths
    .map((filePath) => {
      const contract = extractExportContract(filesContent[filePath] || "");
      return [
        `### ${filePath}`,
        `- default export: ${contract.hasDefaultExport ? "有" : "无"}`,
        `- named exports: ${contract.namedExports.length > 0 ? contract.namedExports.join(", ") : "(无)"}`,
      ].join("\n");
    })
    .join("\n\n");
}

function resolveRelativeImportTarget(fromFile: string, importPath: string): string | null {
  if (!importPath.startsWith(".")) return null;

  const normalizedFrom = fromFile.replace(/\\/g, "/");
  const baseDir = path.posix.dirname(normalizedFrom);
  return path.posix.normalize(path.posix.join(baseDir, importPath));
}

/**
 * 自动剥离引用不存在文件的 import 行。
 * 解决 Coder LLM 幻觉问题：生成的代码引用了不在 filesToCreate 中的模块。
 * 策略：只移除 import 行本身，不尝试删除使用处代码（由后续编译校验兜底）。
 * 仅处理相对路径 import（以 . 开头），不碰第三方库。
 */
function stripInvalidImports(
  fileTarget: string,
  content: string,
  filesContent: Record<string, string>,
  filesToCreate: string[]
): string {
  // 构建项目中存在的文件集合（含常见扩展名解析）
  const existingFiles = new Set<string>();
  for (const f of Object.keys(filesContent)) {
    existingFiles.add(f.replace(/\\/g, "/"));
  }
  for (const f of filesToCreate) {
    existingFiles.add(f.replace(/\\/g, "/"));
  }

  // 扩展名解析候选列表
  const extensions = [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"];

  const lines = content.split("\n");
  const strippedLines: string[] = [];
  let modified = false;

  for (const line of lines) {
    // 匹配 import ... from "..." 或 import "..."
    const importMatch = line.match(
      /^(\s*import\s+(?:type\s+)?(?:.+?\s+from\s+)?["'])([^"']+)(["']\s*;?\s*)$/
    );
    if (!importMatch) {
      strippedLines.push(line);
      continue;
    }

    const importPath = importMatch[2];
    // 只处理相对路径 import
    if (!importPath.startsWith(".")) {
      strippedLines.push(line);
      continue;
    }

    const targetBase = resolveRelativeImportTarget(fileTarget, importPath);
    if (!targetBase) {
      strippedLines.push(line);
      continue;
    }

    // 检查目标文件是否存在（含各种扩展名解析）
    let found = existingFiles.has(targetBase);
    if (!found) {
      for (const ext of extensions) {
        if (existingFiles.has(targetBase + ext)) {
          found = true;
          break;
        }
      }
    }

    if (found) {
      strippedLines.push(line);
    } else {
      // 目标文件不存在——剥离此 import
      modified = true;
      console.warn(
        `${logPrefix("System")} [Coder] 剥离无效 import: ${fileTarget} -> ${importPath} (目标 ${targetBase} 不存在)`
      );
    }
  }

  return modified ? strippedLines.join("\n") : content;
}

function validateImportContracts(
  fileTarget: string,
  content: string,
  filesContent: Record<string, string>
): string[] {
  const totalFiles = Object.keys(filesContent).length;
  const skipExportValidation = totalFiles <= 15;
  const errors: string[] = [];
  const importPattern = /^\s*import\s+(.+?)\s+from\s+["']([^"']+)["'];?\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = importPattern.exec(content))) {
    const specifier = match[1].trim();
    const importPath = match[2].trim();
    const targetBase = resolveRelativeImportTarget(fileTarget, importPath);
    if (!targetBase) continue;

    const targetFile = [
      targetBase,
      `${targetBase}.ts`,
      `${targetBase}.tsx`,
      `${targetBase}.js`,
      `${targetBase}.jsx`,
      `${targetBase}/index.ts`,
      `${targetBase}/index.js`,
    ]
      .map((candidate) => candidate.replace(/\\/g, "/"))
      .find((candidate) => filesContent[candidate] !== undefined);

    if (!targetFile) {
      // 目标文件不存在——这是编译错误（TS2307），必须报告
      errors.push(`${targetBase} 不存在于项目中，无法导入`);
      continue;
    }

    if (skipExportValidation) continue;

    const contract = extractExportContract(filesContent[targetFile]);
    const sanitized = specifier.replace(/\s+/g, " ").trim();
    const namedMatch = sanitized.match(/\{([^}]+)\}/);
    const defaultPart = sanitized.replace(/\{[^}]+\}/, "").replace(/,$/, "").trim();

    if (defaultPart && !defaultPart.startsWith("* as") && !contract.hasDefaultExport) {
      errors.push(`${targetFile} 未导出 default，但当前文件尝试默认导入 ${defaultPart}`);
    }

    if (namedMatch) {
      const imports = namedMatch[1]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

      for (const item of imports) {
        const importName = item.replace(/^type\s+/, "").split(/\s+as\s+/i)[0].trim();
        if (importName && !contract.namedExports.includes(importName)) {
          errors.push(`${targetFile} 未导出 ${importName}`);
        }
      }
    }
  }

  return errors;
}

function validateProtocolDependencyRoles(
  protocol: JimClawState["executionProtocol"],
  fileTarget: string,
  content: string,
  filesContent: Record<string, string>
): string[] {
  const currentContract = getProtocolFileContract(protocol, fileTarget);
  if (!currentContract || !currentContract.allowedDependencyRoles?.length) return [];
  // 小型项目（≤15 文件）跳过严格依赖角色校验——奥卡姆剃刀
  const totalFiles = Object.keys(filesContent).length;
  if (totalFiles <= 15) return [];

  const errors: string[] = [];
  const importPattern = /^\s*import\s+(.+?)\s+from\s+["']([^"']+)["'];?\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = importPattern.exec(content))) {
    const importPath = match[2].trim();
    const targetBase = resolveRelativeImportTarget(fileTarget, importPath);
    if (!targetBase) continue;

    const targetFile = [
      targetBase,
      `${targetBase}.ts`,
      `${targetBase}.tsx`,
      `${targetBase}.js`,
      `${targetBase}.jsx`,
      `${targetBase}/index.ts`,
      `${targetBase}/index.js`,
    ]
      .map((candidate) => candidate.replace(/\\/g, "/"))
      .find((candidate) => filesContent[candidate] !== undefined);

    if (!targetFile) continue;

    const dependencyContract = getProtocolFileContract(protocol, targetFile);
    if (!dependencyContract) continue;
    const allowAggregateServiceHelperDependency =
      currentContract.role === "service" &&
      dependencyContract.role === "service" &&
      isAggregateExecutionServiceFile(fileTarget) &&
      !isAggregateExecutionServiceFile(targetFile) &&
      getExecutionDependencyStem(fileTarget) === getExecutionDependencyStem(targetFile);
    if (!allowAggregateServiceHelperDependency && !currentContract.allowedDependencyRoles.includes(dependencyContract.role)) {
      errors.push(`${fileTarget}(${currentContract.role}) 不允许依赖 ${targetFile}(${dependencyContract.role})`);
    }
  }

  return errors;
}

function isBlockingToolError(message: string): boolean {
  const text = String(message || "");
  if (!text) return false;
  if (/\[WARNING\]/i.test(text)) return false;
  if (/No files matching the pattern were found/i.test(text)) return false;
  return /Error executing|Command failed|越权写文件/i.test(text);
}

function isMissingTargetFileDiagnostic(message: string, fileTarget: string): boolean {
  const text = String(message || "");
  if (!text) return false;
  const normalizedTarget = normalizeTaskFileTarget(fileTarget);
  const escapedTarget = normalizedTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    /file not found/i.test(text) &&
    (new RegExp(escapedTarget, "i").test(text) ||
      new RegExp(path.basename(normalizedTarget).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text))
  );
}

async function tryLoadValidatedDiskOutput(
  workspace: string,
  fileTarget: string,
  filesContent: Record<string, string>,
  protocol: JimClawState["executionProtocol"]
): Promise<{ ok: boolean; code?: string; error?: string }> {
  try {
    const filePath = path.join(workspace, fileTarget);
    const diskCode = await fs.readFile(filePath, "utf-8");
    const diskValidationError = validateGeneratedFileContent(fileTarget, diskCode);
    if (diskValidationError) {
      return { ok: false, error: diskValidationError };
    }
    const importContractErrors = validateImportContracts(fileTarget, diskCode, filesContent);
    if (importContractErrors.length > 0) {
      return { ok: false, error: `依赖导出契约校验失败: ${importContractErrors.join("; ")}` };
    }
    const protocolDependencyErrors = validateProtocolDependencyRoles(protocol, fileTarget, diskCode, filesContent);
    if (protocolDependencyErrors.length > 0) {
      return { ok: false, error: `执行协议依赖角色校验失败: ${protocolDependencyErrors.join("; ")}` };
    }
    return { ok: true, code: diskCode };
  } catch (error: any) {
    return { ok: false, error: `尝试读取已由工具写入的文件失败: ${error.message || error}` };
  }
}

async function reconcileCompletedFilesFromDisk(
  workspace: string,
  subTasks: Array<{ id: string; description: string; fileTarget: string; status: string; lastError?: string }>,
  filesContent: Record<string, string>,
  codeLogEntries: FileChangeEntry[],
  currentRetry: number,
  protocol: JimClawState["executionProtocol"],
  qaFailedFiles?: string[]
): Promise<void> {
  const qaFailedSet = new Set((qaFailedFiles || []).map(f => f.replace(/\\/g, "/")));
  for (const task of subTasks) {
    if (task.status === "completed") continue;
    // 不要从磁盘恢复本轮 QA 标记为失败的文件——它们需要重新生成
    if (qaFailedSet.has(task.fileTarget.replace(/\\/g, "/"))) continue;

    const recovered = await tryLoadValidatedDiskOutput(workspace, task.fileTarget, filesContent, protocol);
    if (!recovered.ok) continue;

    filesContent[task.fileTarget] = recovered.code || "";
    task.status = "completed";
    delete task.lastError;

    const alreadyLogged = codeLogEntries.some(
      (entry) => entry.file === task.fileTarget && entry.status === "written"
    );
    if (!alreadyLogged) {
      codeLogEntries.push({
        round: currentRetry,
        file: task.fileTarget,
        taskTitle: task.description.slice(0, 80),
        status: "written",
        generationSource: "recovered_disk",
      });
    }
  }
}

/**
 * Coder 节点：负责根据子任务编写代码
 */
export async function coderNode(
  state: JimClawState,
  agents: { coder: BaseAgent },
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("coder");
  const currentRetry = state.retryCount || 0;
  emit("phase-change", "System", "coding");

  const subTasks = state.subTasks || [];
  const filesContent: Record<string, string> = JSON.parse(state.code || "{}");
  const codeLogEntries: FileChangeEntry[] = [];
  const nodeModulesReady = isNodeLikeLanguage(state.spec?.language)
    ? await hasWorkspaceNodeModules(WORKSPACE)
    : true;
  const skipPerFileQualityChecks = isNodeLikeLanguage(state.spec?.language) && !nodeModulesReady;
  const maxParallel = getCoderMaxParallel(state);
  const experimentalModelParallel = isExperimentalModelParallelEnabled(state);
  let blockedReason = "";
  let blockedFailedFiles: string[] = [];
  let validationCheckpointRequested = false;
  let validationCheckpointReason = "";
  const localRetryAttempts: Record<string, number> = {};
  const localRetryArtifacts: Record<string, string> = {};

  const runDeterministicParallelBatch = async (): Promise<{ progressed: boolean; stop: boolean }> => {
    if (maxParallel <= 1 || blockedReason || validationCheckpointRequested) {
      return { progressed: false, stop: false };
    }

    const prioritized = getPrioritizedSubTasks(state, subTasks as any) as typeof subTasks;
    const readyTasks = prioritized.filter((task) => {
      if (task.status === "completed") return false;
      if (isCorePhaseActive(state, subTasks as any) && isCorePhaseDeferredFile(task.fileTarget)) return false;
      if (!areTaskDependenciesSatisfied(task, subTasks as any, filesContent)) return false;
      if ((localRetryAttempts[task.fileTarget] || 0) > 0) return false;
      const hasFixPlan = (state.fixPlan || []).some((plan) => plan.fileTarget === task.fileTarget);
      if (hasFixPlan) return false;
      const hasQaFailure = new Set((state.qaFailures?.failedFiles || []).map(f => f.replace(/\\/g, "/"))).has(task.fileTarget.replace(/\\/g, "/"));
      if (hasQaFailure) return false;
      return Boolean(resolveAllowedDeterministicScaffold(state, task.fileTarget));
    });
    const batch = readyTasks.slice(0, maxParallel);
    if (batch.length < 2) {
      return { progressed: false, stop: false };
    }

    emit(
      "thinking",
      "System",
      `[Coder] 启用并行批次（${batch.length}个）：${batch.map((item) => item.fileTarget).join(", ")}`,
      { batch: batch.map((item) => item.fileTarget) }
    );

    const generationResults = await Promise.all(
      batch.map(async (task) => {
        const scaffold = resolveAllowedDeterministicScaffold(state, task.fileTarget);
        if (!scaffold) {
          return {
            ok: false as const,
            task,
            code: "",
            error: "确定性骨架不可用",
          };
        }
        const validationError = validateGeneratedFileContent(task.fileTarget, scaffold);
        if (validationError) {
          return {
            ok: false as const,
            task,
            code: "",
            error: validationError,
          };
        }
        const importContractErrors = validateImportContracts(task.fileTarget, scaffold, filesContent);
        if (importContractErrors.length > 0) {
          return {
            ok: false as const,
            task,
            code: "",
            error: `依赖导出契约校验失败: ${importContractErrors.join("; ")}`,
          };
        }
        const protocolDependencyErrors = validateProtocolDependencyRoles(
          state.executionProtocol,
          task.fileTarget,
          scaffold,
          filesContent
        );
        if (protocolDependencyErrors.length > 0) {
          return {
            ok: false as const,
            task,
            code: "",
            error: `执行协议依赖角色校验失败: ${protocolDependencyErrors.join("; ")}`,
          };
        }
        // 自动剥离确定性 scaffold 中引用不存在文件的 import
        const specFiles = (state.spec?.filesToCreate || []).map(f => f.replace(/\\/g, "/"));
        const cleanedScaffold = isNodeLikeLanguage(state.spec?.language)
          ? stripInvalidImports(task.fileTarget, scaffold, filesContent, specFiles)
          : scaffold;

        return {
          ok: true as const,
          task,
          code: cleanedScaffold,
          generationSource: "deterministic_scaffold" as const,
        };
      })
    );

    let progressed = false;
    for (const generation of generationResults) {
      const task = generation.task;
      if (!generation.ok) {
        task.status = "failed";
        task.lastError = generation.error;
        codeLogEntries.push({
          round: currentRetry,
          file: task.fileTarget,
          taskTitle: task.description.slice(0, 80),
          status: "error",
          error: generation.error,
        });
        blockedReason = `Coder 阻塞失败: ${task.fileTarget} -> ${generation.error}`;
        blockedFailedFiles = [task.fileTarget];
        emit("thinking", "System", `[Coder] 并行批次失败，停止本轮后续生成: ${blockedReason}`, { task });
        return { progressed, stop: true };
      }

      const filePath = path.join(WORKSPACE, task.fileTarget);
      const previousCode = filesContent[task.fileTarget];
      const previousStatus = task.status;
      const previousError = task.lastError;
      const codeLogStartIndex = codeLogEntries.length;
      try {
        filesContent[task.fileTarget] = generation.code;
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, generation.code);
        task.status = "completed";
        delete task.lastError;
        codeLogEntries.push({
          round: currentRetry,
          file: task.fileTarget,
          taskTitle: task.description.slice(0, 80),
          status: "written",
          generationSource: generation.generationSource,
        });
        const incrementalResult = {
          code: JSON.stringify(filesContent, null, 2),
          subTasks: [...subTasks],
          codeLog: [...(state.codeLog || []), ...codeLogEntries],
          blockedReason: "",
          testResults: "",
          qaFailures: null,
          lastFailedNode: "",
          lastFailureSummary: "",
          failureFingerprint: "",
          sameFailureCount: 0,
        };
        await persistWriteRecoveryIntent(WORKSPACE, {
          taskId: task.id,
          fileTarget: task.fileTarget,
          expectedContent: generation.code,
          nodeName: `coder_task_${task.id}`,
          traceId: (state as any).traceId,
          snapshotState: { ...state, ...incrementalResult } as any,
        });
        await saveBoulder({ ...state, ...incrementalResult }, `coder_task_${task.id}`);
        await clearWriteRecoveryIntent(WORKSPACE, task.id);
        delete localRetryAttempts[task.fileTarget];
        delete localRetryArtifacts[task.fileTarget];
        progressed = true;
        emit("thinking", "System", `[Coder] 并行批次完成: ${task.fileTarget}`, { task });
        const checkpointDecision = shouldRequestValidationCheckpoint(state, subTasks as any, codeLogEntries);
        if (checkpointDecision.requested) {
          validationCheckpointRequested = true;
          validationCheckpointReason = checkpointDecision.reason;
          emit("thinking", "System", `[Coder] ${validationCheckpointReason}`, { task });
          return { progressed, stop: true };
        }
      } catch (error: any) {
        await clearWriteRecoveryIntent(WORKSPACE, task.id);
        if (previousCode === undefined) {
          delete filesContent[task.fileTarget];
          await fs.rm(filePath, { force: true }).catch(() => undefined);
        } else {
          filesContent[task.fileTarget] = previousCode;
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, previousCode);
        }
        task.status = previousStatus || "failed";
        task.lastError = `${previousError ? `${previousError}; ` : ""}状态保存失败: ${error.message || error}`;
        codeLogEntries.splice(codeLogStartIndex);
        codeLogEntries.push({
          round: currentRetry,
          file: task.fileTarget,
          taskTitle: task.description.slice(0, 80),
          status: "error",
          error: task.lastError,
        });
        blockedReason = `Coder 阻塞失败: ${task.fileTarget} -> ${task.lastError}`;
        blockedFailedFiles = [task.fileTarget];
        emit("thinking", "System", `[Coder] 并行批次状态落盘失败，停止本轮后续生成: ${blockedReason}`, { task });
        return { progressed, stop: true };
      }
    }

    return { progressed, stop: false };
  };

  const runModelParallelBatch = async (): Promise<{ progressed: boolean; stop: boolean }> => {
    if (!experimentalModelParallel || maxParallel <= 1 || blockedReason || validationCheckpointRequested) {
      return { progressed: false, stop: false };
    }

    const prioritized = getPrioritizedSubTasks(state, subTasks as any) as typeof subTasks;
    const readyTasks = prioritized.filter((task) => {
      if (task.status === "completed") return false;
      if (isCorePhaseActive(state, subTasks as any) && isCorePhaseDeferredFile(task.fileTarget)) return false;
      if (!areTaskDependenciesSatisfied(task, subTasks as any, filesContent)) return false;
      if ((localRetryAttempts[task.fileTarget] || 0) > 0) return false;
      const hasFixPlan = (state.fixPlan || []).some((plan) => plan.fileTarget === task.fileTarget);
      if (hasFixPlan) return false;
      return !Boolean(resolveAllowedDeterministicScaffold(state, task.fileTarget));
    });
    const batch = readyTasks.slice(0, maxParallel);
    if (batch.length < 2) {
      return { progressed: false, stop: false };
    }

    emit(
      "thinking",
      "System",
      `[Coder] 启用实验模型并行批次（${batch.length}个）：${batch.map((item) => item.fileTarget).join(", ")}`,
      { batch: batch.map((item) => item.fileTarget) }
    );

    const taskTimeoutMs = getCoderTaskTimeoutMs(state, subTasks as any);
    const generationResults = await Promise.all(
      batch.map(async (task) => {
        const prompt = `请实现 ${task.fileTarget}。\n[任务规范摘要]\n${buildCompactTaskSpecSummary(state, task)}\n上下文：${task.contextRequirement}\n\n仅输出 markdown 代码块中的完整文件内容，不要调用 write_file 工具。`;
        try {
          const coderResponse = await invokeCoderWithTaskTimeout({
            agent: agents.coder,
            prompt,
            onEvent: (ev) => {
              emit(ev.type, ev.sender, `并行开发: ${task.fileTarget}`, ev);
            },
            brief: buildCoderExecutionContext(state, task),
            workspaceDir: WORKSPACE,
            timeoutMs: taskTimeoutMs,
            firstWriteTimeoutMs: 0,
          });
          const rawResponseText = extractText(coderResponse.content);
          const extractResult = extractCodeFromResponse(rawResponseText);
          if (!extractResult.isValid) {
            return { ok: false as const, task, code: "", error: extractResult.error || "代码提取失败" };
          }
          let code = extractResult.code || "";
          const validationError = validateGeneratedFileContent(task.fileTarget, code);
          if (validationError) {
            return { ok: false as const, task, code: "", error: validationError };
          }
          // 先 strip 无效 import（引用不存在文件），再校验导出契约
          if (isNodeLikeLanguage(state.spec?.language)) {
            const specFiles = (state.spec?.filesToCreate || []).map(f => f.replace(/\\/g, "/"));
            code = stripInvalidImports(task.fileTarget, code, filesContent, specFiles);
          }
          const importContractErrors = validateImportContracts(task.fileTarget, code, filesContent);
          if (importContractErrors.length > 0) {
            return { ok: false as const, task, code: "", error: `依赖导出契约校验失败: ${importContractErrors.join("; ")}` };
          }
                    const protocolDependencyErrors = validateProtocolDependencyRoles(state.executionProtocol, task.fileTarget, code, filesContent);
          if (protocolDependencyErrors.length > 0) {
            return { ok: false as const, task, code: "", error: `执行协议依赖角色校验失败: ${protocolDependencyErrors.join("; ")}` };
          }
          return {
            ok: true as const,
            task,
            code,
            generationSource: "model" as const,
          };
        } catch (error: any) {
          if (error?.code === "CODER_FIRST_WRITE_TIMEOUT") {
            return { ok: false as const, task, code: "", error: `首个写入超时（>${taskTimeoutMs}ms）` };
          }
          if (isAgentTimeoutError(error)) {
            return { ok: false as const, task, code: "", error: `单文件生成超时（>${taskTimeoutMs}ms）` };
          }
          return { ok: false as const, task, code: "", error: String(error?.message || error || "模型并行生成失败") };
        }
      })
    );

    let progressed = false;
    for (const generation of generationResults) {
      const task = generation.task;
      if (!generation.ok) {
        task.status = "failed";
        task.lastError = generation.error;
        codeLogEntries.push({
          round: currentRetry,
          file: task.fileTarget,
          taskTitle: task.description.slice(0, 80),
          status: "error",
          error: generation.error,
        });
        blockedReason = `Coder 阻塞失败: ${task.fileTarget} -> ${generation.error}`;
        blockedFailedFiles = [task.fileTarget];
        emit("thinking", "System", `[Coder] 实验模型并行批次失败，停止本轮后续生成: ${blockedReason}`, { task });
        return { progressed, stop: true };
      }

      const filePath = path.join(WORKSPACE, task.fileTarget);
      const previousCode = filesContent[task.fileTarget];
      const previousStatus = task.status;
      const previousError = task.lastError;
      const codeLogStartIndex = codeLogEntries.length;
      try {
        filesContent[task.fileTarget] = generation.code;
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, generation.code);
        task.status = "completed";
        delete task.lastError;
        codeLogEntries.push({
          round: currentRetry,
          file: task.fileTarget,
          taskTitle: task.description.slice(0, 80),
          status: "written",
          generationSource: generation.generationSource,
        });
        const incrementalResult = {
          code: JSON.stringify(filesContent, null, 2),
          subTasks: [...subTasks],
          codeLog: [...(state.codeLog || []), ...codeLogEntries],
          blockedReason: "",
          testResults: "",
          qaFailures: null,
          lastFailedNode: "",
          lastFailureSummary: "",
          failureFingerprint: "",
          sameFailureCount: 0,
        };
        await persistWriteRecoveryIntent(WORKSPACE, {
          taskId: task.id,
          fileTarget: task.fileTarget,
          expectedContent: generation.code,
          nodeName: `coder_task_${task.id}`,
          traceId: (state as any).traceId,
          snapshotState: { ...state, ...incrementalResult } as any,
        });
        await saveBoulder({ ...state, ...incrementalResult }, `coder_task_${task.id}`);
        await clearWriteRecoveryIntent(WORKSPACE, task.id);
        delete localRetryAttempts[task.fileTarget];
        delete localRetryArtifacts[task.fileTarget];
        progressed = true;
        emit("thinking", "System", `[Coder] 实验模型并行批次完成: ${task.fileTarget}`, { task });
        const checkpointDecision = shouldRequestValidationCheckpoint(state, subTasks as any, codeLogEntries);
        if (checkpointDecision.requested) {
          validationCheckpointRequested = true;
          validationCheckpointReason = checkpointDecision.reason;
          emit("thinking", "System", `[Coder] ${validationCheckpointReason}`, { task });
          return { progressed, stop: true };
        }
      } catch (error: any) {
        await clearWriteRecoveryIntent(WORKSPACE, task.id);
        if (previousCode === undefined) {
          delete filesContent[task.fileTarget];
          await fs.rm(filePath, { force: true }).catch(() => undefined);
        } else {
          filesContent[task.fileTarget] = previousCode;
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, previousCode);
        }
        task.status = previousStatus || "failed";
        task.lastError = `${previousError ? `${previousError}; ` : ""}状态保存失败: ${error.message || error}`;
        codeLogEntries.splice(codeLogStartIndex);
        codeLogEntries.push({
          round: currentRetry,
          file: task.fileTarget,
          taskTitle: task.description.slice(0, 80),
          status: "error",
          error: task.lastError,
        });
        blockedReason = `Coder 阻塞失败: ${task.fileTarget} -> ${task.lastError}`;
        blockedFailedFiles = [task.fileTarget];
        emit("thinking", "System", `[Coder] 实验模型并行批次状态落盘失败，停止本轮后续生成: ${blockedReason}`, { task });
        return { progressed, stop: true };
      }
    }

    return { progressed, stop: false };
  };

  // 1. 根据 QA 反馈，精准重置需要修复的任务状态
  if (state.qaFailures && state.qaFailures.failedFiles.length > 0) {
    const errorDetail = state.qaFailures.testErrors.join("\n");
    for (const task of subTasks) {
      if (state.qaFailures.failedFiles.includes(task.fileTarget)) {
        task.status = "pending";
        const msg = `发现失败文件: ${task.fileTarget}。正在重置以重新实现。\n[失败原因]：\n${errorDetail}`;
        console.log(`${logPrefix("System")} [Coder] ${msg}`);
        emit("thinking", "System", msg, { task, error: errorDetail });
      }
    }
  }

  await reconcileCompletedFilesFromDisk(
    WORKSPACE,
    subTasks as any,
    filesContent,
    codeLogEntries,
    currentRetry,
    state.executionProtocol,
    state.qaFailures?.failedFiles
  );

  // ── 全局超时保护：防止 Coder process 被外部杀死而丢失已完成的工作 ──
  const CODER_GLOBAL_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟（Python 项目需要更长）
  const coderStartTime = Date.now();

  normalizeStructuralDependencies(subTasks as any);
  let progressMade = true;
  while (progressMade && !blockedReason) {
    // 全局超时检查
    if (Date.now() - coderStartTime > CODER_GLOBAL_TIMEOUT_MS) {
      const completedCount = subTasks.filter((t: any) => t.status === "completed").length;
      const totalCount = subTasks.length;
      emit("thinking", "System", `[Coder] 全局超时（>${CODER_GLOBAL_TIMEOUT_MS / 1000}s），已完成 ${completedCount}/${totalCount}，保存进度并退出`, {});
      console.log(`${logPrefix("System")} [Coder] 全局超时：${completedCount}/${totalCount} 文件已完成`);
      break;
    }
    progressMade = false;
    const parallelBatch = await runDeterministicParallelBatch();
    if (parallelBatch.progressed) {
      progressMade = true;
    }
    if (parallelBatch.stop) {
      break;
    }
    if (parallelBatch.progressed) {
      continue;
    }
    const modelParallelBatch = await runModelParallelBatch();
    if (modelParallelBatch.progressed) {
      progressMade = true;
    }
    if (modelParallelBatch.stop) {
      break;
    }
    if (modelParallelBatch.progressed) {
      continue;
    }
    for (const task of getPrioritizedSubTasks(state, subTasks as any) as typeof subTasks) {
      // 2. 严格增量：跳过所有已完成且不在修复名单中的任务
      if (task.status === "completed") continue;
      if (isCorePhaseActive(state, subTasks as any) && isCorePhaseDeferredFile(task.fileTarget)) {
        emit("thinking", "System", `[Coder] 首轮核心阶段暂缓 ${task.fileTarget}，等待阶段验证后再补齐外围文件`, { task });
        continue;
      }
      if (!areTaskDependenciesSatisfied(task, subTasks as any, filesContent)) {
        emit("thinking", "System", `[Coder] 暂缓 ${task.fileTarget}，其依赖尚未完成: ${(task.dependencies || []).join(", ")}`, { task });
        continue;
      }

      const taskLocalAttempt = localRetryAttempts[task.fileTarget] || 0;
      emit("thinking", agents.coder.getPersona().name, `正在实现: ${task.fileTarget}${taskLocalAttempt > 0 ? `（任务内重试 ${taskLocalAttempt}）` : ""}`, { task });

      // 检查是否有 QA-Coder 协商后的修复计划
      const fixPlanItem = (state.fixPlan || []).find(p => p.fileTarget === task.fileTarget);

      let prompt = fixPlanItem
        // 有协商计划：直接按计划执行，不再靠自己猜
        ? `请修复 ${task.fileTarget}。\n\n[与QA协商后的修复方案（必须严格按此执行）]：\n- 根因：${fixPlanItem.diagnosis}\n- 具体修改：${fixPlanItem.proposedChange}${fixPlanItem.qaFeedback ? `\n- QA的纠正意见：${fixPlanItem.qaFeedback}` : ""}\n\n[任务规范摘要]\n${buildCompactTaskSpecSummary(state, task)}\n上下文：${task.contextRequirement}`
        // 无协商计划：首轮正常实现
        : `请实现 ${task.fileTarget}。\n[任务规范摘要]\n${buildCompactTaskSpecSummary(state, task)}\n上下文：${task.contextRequirement}`;

      // P0-A：注入 API 接口契约
      if (state.apiContract?.endpoints?.length) {
        const relevantApiContract = buildRelevantApiContract(task, state);
        prompt += `\n\n[API 接口契约 - 仅保留当前文件相关端点摘要]：\n${relevantApiContract}`;
      }
      const protocolFileContract = getProtocolFileContract(state.executionProtocol, task.fileTarget);
      if (state.executionProtocol && protocolFileContract) {
        prompt += `\n\n[ExecutionProtocol - 当前文件约束]\n${JSON.stringify({
          file: task.fileTarget,
          role: protocolFileContract.role,
          allowedDependencyRoles: protocolFileContract.allowedDependencyRoles,
          requiredExports: protocolFileContract.requiredExports || [],
          ownedEndpoints: protocolFileContract.ownedEndpoints || [],
        }, null, 2)}`;
      }

      // P0-A：注入已完成文件列表，让 Coder 知道哪些文件已就绪、可以 import
      const completedFiles = Object.keys(filesContent);
      const focusedContextFiles = getFocusedContextFiles(task, filesContent);
      if (shouldUseFocusedContext(task) && focusedContextFiles.length > 0) {
        const focusedSnippets = buildFocusedContextSnippets(task, focusedContextFiles, filesContent);
        prompt += `\n\n[测试文件直连上下文 - 只允许优先使用这些已完成文件，不要反复读取其他已完成文件]\n${focusedContextFiles.map(f => `- ${f}`).join("\n")}`;
        prompt += `\n\n[测试文件直连上下文内容]\n${focusedSnippets
          .map((snippet) =>
            `### ${snippet.file}\n\`\`\`\n${snippet.content}${snippet.truncated ? "\n/* ...上下文已截断，按依赖契约继续实现 */" : ""}\n\`\`\``
          )
          .join("\n\n")}`;
        prompt += `\n\n[依赖文件导出契约 - import 只能使用这里真正存在的导出]\n${buildDependencyContractText(focusedContextFiles, filesContent)}`;
        completedFiles.length = 0;
      }
      if (completedFiles.length > 0) {
        prompt += `\n\n[已完成的文件列表 - 可安全 import]：\n${completedFiles.map(f => `- ${f}`).join("\n")}`;
      }

      // P0-B：重试时注入当前文件内容，避免盲目重写丢失已有正确实现
      if (currentRetry > 0 && filesContent[task.fileTarget]) {
        prompt += `\n\n[当前文件内容 - 请在此基础上修复，勿整体重写]：\n\`\`\`\n${filesContent[task.fileTarget]}\n\`\`\``;
      }

      // P0-B：注入具体错误原因（来自 task.lastError）
      if (currentRetry > 0 && task.lastError) {
        prompt += `\n\n[上次失败原因 - 必须针对性修复]：\n${task.lastError}`;
      }

      if (taskLocalAttempt > 0 && task.lastError) {
        prompt += `\n\n[任务内自愈重试 - 必须修正上一次输出]：\n- 上一次失败原因：${task.lastError}\n- 上一次输出摘要：${localRetryArtifacts[task.fileTarget] || "（无）"}\n- 现在必须重新生成完整文件，确保语法合法、结构完整、无自然语言污染。`;
        if (taskLocalAttempt >= 1) {
          prompt += `\n- 这是最后一次内容自愈机会。你的回复第一行必须直接开始代码块（例如 \`\`\`typescript），不得再输出计划、解释、JSON、总结或任何自然语言句子。`;
        }
      }

      // P0-C：注入实际测试报错输出（从 testResults 中提取与本文件相关的片段）
      // 高于 issueTracker 描述的可信度，因为这是真实的 stack trace
      if (currentRetry > 0 && state.testResults && state.qaFailures?.failedFiles.includes(task.fileTarget)) {
        const testOutput = state.testResults;
        // 提取文件名相关的报错块（保留最多 1000 字符避免 prompt 膨胀）
        const fileName = task.fileTarget.replace(/^.*\//, "");
        const lines = testOutput.split("\n");
        const relevantLines: string[] = [];
        let capturing = false;
        for (const line of lines) {
          if (line.includes(fileName) && (line.includes("FAIL") || line.includes("●") || line.includes("error"))) {
            capturing = true;
          }
          if (capturing) relevantLines.push(line);
          if (relevantLines.length >= 40) break;
        }
        if (relevantLines.length > 0) {
          prompt += `\n\n[实际测试错误输出（真实 stack trace，比 Issue 描述更可信）]：\n${relevantLines.join("\n")}`;
        }
      }

      // 动态端口注入
      const appPort = state.manifest?.services?.[0]?.port || 8080;
      prompt += `\n\n[硬性技术规范]：\n本项目统一使用端口 ${appPort}。如果该文件涉及服务启动、端口监听或 Docker 配置，请务必将其设置为 ${appPort}。严禁使用其他端口。`;

      // Express req.params 类型安全提示
      if (/\.(ts|js)$/i.test(task.fileTarget) && /express/i.test(state.spec?.framework || "")) {
        prompt += `\n\n[Express 类型安全提示]：\nreq.params 的类型是 Record<string, string | string[]>（不是纯 string）。解构赋值后不可直接传给只接受 string 的函数。正确做法：使用 req.params.id as string，或 const id = String(req.params.id)。`;
      }

      // Express 入口文件导出格式约束 + 服务器启动约束
      if (/^src\/index\.(ts|js)$/i.test(task.fileTarget) && /express/i.test(state.spec?.framework || "")) {
        prompt += `\n\n[Express 入口文件关键约束]：
1. 默认导出必须是 Express Application 实例：\n   正确：const app = express(); ... export default app;\n   错误：export default createApp; (函数)\n   错误：export default { app, server }; (对象)\n   错误：export default createApp(); (每次调用创建新实例)\n   原因：测试文件使用 supertest，需要 import app from "../src/index" 直接获得 Express 实例。

2. 必须在模块顶层启动服务器（不能包在函数里！）：\n   正确：\n     const PORT = process.env.PORT || 3000;\n     if (process.env.NODE_ENV !== 'test') {\n       app.listen(PORT, () => console.log('Server on port', PORT));\n     }\n     export default app;\n   错误：把 app.listen 放在 startServer() 函数里但不调用它 → npm start 什么都不会发生\n   原因：npm start 执行 node dist/src/index.js，需要在加载模块时直接启动服务器。
   注意：测试环境下 (NODE_ENV=test) 不要启动服务器，避免端口冲突。

3. 必须注册根路径 GET / 处理器，返回 API 导航信息（JSON 对象）：
   app.get('/', (req, res) => res.json({ message: '项目名 API', version: '1.0.0', endpoints: ['/api/health', '/api/users'] }));
   原因：部署后用户访问根路径应看到可用端点，而不是 "Cannot GET /" 错误。`;
      }

      // 注入缺陷工单 (Issues)
      const relatedIssues = (state.issueTracker || []).filter(i => i.status === 'open' && i.relatedFiles.includes(task.fileTarget));
      if (relatedIssues.length > 0) {
        prompt += `\n\n[待修复的缺陷工单 (Issues)]：\n该文件在之前的测试中发现了以下问题，请优先修复：\n${relatedIssues.map(i => `- [${i.id}] ${i.title} (${i.severity}): ${i.description}`).join("\n")}`;
      }

      if (state.mediationDirectives && state.mediationDirectives.length > 0) {
        const relevantDirectives = state.mediationDirectives.filter(d => d.file === task.fileTarget || d.file === "*");
        if (relevantDirectives.length > 0) {
          prompt += `\n\n[架构仲裁指令]：\n${relevantDirectives.map(d => `- ${d.action}: ${d.detail}`).join("\n")}`;
        }
      }

      // Dockerfile 专项提示：防止 Coder 把 shell 命令写进 Dockerfile
      if (task.fileTarget === "Dockerfile" || task.fileTarget.endsWith("/Dockerfile")) {
        prompt += `\n\n[Dockerfile 铁律]：
Dockerfile 是 Docker 镜像构建指令文件，绝对不是 shell 脚本。
第一行必须是 FROM <image>（如 FROM node:20-alpine），不得写 docker run / docker build 等命令。
正确示例：
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE <端口>
CMD ["node", "dist/index.js"]`;
      }

      // 测试文件专项提示
      if (task.fileTarget.includes("test") || task.fileTarget.includes("spec")) {
        prompt += `\n\n[测试文件铁律 - 必须严格遵守]：
1. **只能 import 已存在的文件**：测试文件只能 import workspace 中已生成或由 scaffold 生成的模块。严禁 import 不存在的文件、未在 package.json 中声明的第三方包。如果需要某个工具函数，在测试文件内直接定义。
   - 已知可用的包：express, supertest, jest/ts-jest（测试框架内置，无需 import）。
   - 如果 package.json 中没有 uuid、axios、lodash 等包，不要在测试中 import 它们。
2. **Jest Mock 污染防护**：如果 beforeEach 中调用了 mock 函数（如 register、setup 等会触发 mockResponse.json 的函数），必须在该 beforeEach 末尾添加 mock 重置，例如：
   \`\`\`typescript
   (mockResponse.json as jest.Mock).mockClear();
   (mockResponse.status as jest.Mock).mockClear();
   \`\`\`
   否则后续测试中 mock.calls[0][0] 会取到 setup 阶段的调用结果，导致断言失败。
3. **TypeScript 严格模式**：项目开启了 noUnusedLocals，任何 import 的类型或变量如果未在文件中使用，必须删除，否则整个测试套件将无法运行（TS6133 错误）。
4. **断言数据来源**：使用 mock.calls[N][0] 时，N 必须对应测试逻辑中第 N+1 次调用。如果 beforeEach 已经触发了一次调用，则测试中的第一次调用结果在 mock.calls[1][0] 而非 mock.calls[0][0]。`;
      }

      prompt += `\n\n[输出质量铁律 - 必须严格遵守]：
1. **代码包裹**：必须将实现的代码包裹在 Markdown 代码块中（例如 \`\`\`typescript 或 \`\`\`json）。
2. **拒绝废话**：严禁在代码块前后输出任何解释性文字。对于 JSON 文件，必须确保其为严格合法的 JSON 格式。
3. **按需引用**：严禁对当前 [行动清单] 中尚未生成的文件调用 read_file。请根据 [接口契约 (ApiContract)] 直接生成引用代码。
4. **防御性编程**：不要因为无法读取到某个物理文件而中断任务。你应该相信契约并继续完成你的当前任务。`;
      if (skipPerFileQualityChecks) {
        prompt += `\n\n[阶段执行策略 - 依赖未就绪]：
当前工作空间尚未安装 node_modules。为避免重复空检查，请在本文件实现阶段不要调用 diagnose_code 与 lint_fix。
先完成文件写入，依赖安装后再在阶段校验统一执行类型诊断与格式化。`;
      }

      let toolError: string | null = null;
      let fileWrittenByTool = false;
      let diagnosticsPassed = false;
      let lintPassed = false;
      let missingTargetDiagnostic = false;
      const unauthorizedWriteTargets = new Set<string>();
      let rawResponseText = "";

      const normalizeWriteTarget = (rawTarget: string) => {
        const trimmed = rawTarget.trim().replace(/^["']|["']$/g, "");
        if (!trimmed) return "";
        const absolute = path.isAbsolute(trimmed) ? trimmed : path.join(WORKSPACE, trimmed);
        const relative = path.relative(WORKSPACE, absolute).replace(/\\/g, "/");
        return relative.startsWith("..") ? trimmed.replace(/\\/g, "/") : relative;
      };

      const deterministicScaffold = resolveAllowedDeterministicScaffold(state, task.fileTarget);
      const qaFailedSet = new Set((state.qaFailures?.failedFiles || []).map(f => f.replace(/\\/g, "/")));
      const fileFailedByQa = qaFailedSet.has(task.fileTarget.replace(/\\/g, "/"));
      const scaffoldAllowed = Boolean(deterministicScaffold) && !fileFailedByQa;
      let generationSource: FileChangeEntry["generationSource"] | undefined;
      let extractResult: { isValid: boolean; code: string; error?: string } | undefined = undefined;
      if (scaffoldAllowed) {
        generationSource = "deterministic_scaffold";
        extractResult = { isValid: true, code: deterministicScaffold, error: "" };
      } else if (fileFailedByQa && deterministicScaffold) {
        emit(
          "thinking",
          "System",
          `[Coder] ${task.fileTarget} 被 QA 标记失败，跳过确定性骨架，强制走模型生成`,
          { task }
        );
        extractResult = undefined; // 强制走模型生成
      } else {
        if (deterministicScaffold && isPlanningFallbackActive(state)) {
          emit(
            "thinking",
            "System",
            `[Coder] 规划已降级，核心文件 ${task.fileTarget} 禁止直接套用确定性骨架，改走模型生成`,
            { task }
          );
        }
        const taskTimeoutMs = getCoderTaskTimeoutMs(state, subTasks as any, taskLocalAttempt);
        const taskFirstWriteTimeoutMs = getCoderFirstWriteTimeoutMs(state, subTasks as any, task.fileTarget);
        try {
          const coderResponse = await invokeCoderWithTaskTimeout({
            agent: agents.coder,
            prompt,
            onEvent: (ev) => {
              emit(ev.type, ev.sender, `正在开发: ${task.fileTarget}`, ev);
              // 深度校验：通过监听工具调用的回显，准确捕获底层工具的报错
              if (ev.type === "tool_use" && ev.content) {
                const contentStr = String(ev.content);
                if (contentStr.includes("Error executing") || contentStr.includes("修复规范时出错") || contentStr.includes("Command failed")) {
                  toolError = `工具执行异常: ${contentStr.slice(0, 200)}`;
                } else if (ev.tool === "write_file" && contentStr.includes("Successfully wrote")) {
                  const targetMatch = contentStr.match(/Successfully wrote to\s+(.+)$/);
                  const writtenTarget = normalizeWriteTarget(targetMatch?.[1] || "");
                  if (writtenTarget === task.fileTarget.replace(/\\/g, "/")) {
                    fileWrittenByTool = true;
                  } else if (writtenTarget) {
                    unauthorizedWriteTargets.add(writtenTarget);
                    toolError = `检测到越权写文件：当前任务只允许写入 ${task.fileTarget}，但工具实际写入了 ${writtenTarget}`;
                  }
                } else if (ev.tool === "diagnose_code") {
                  if (/\[SUCCESS\]/i.test(contentStr)) {
                    diagnosticsPassed = true;
                  } else if (isMissingTargetFileDiagnostic(contentStr, task.fileTarget)) {
                    missingTargetDiagnostic = true;
                  }
                } else if (ev.tool === "lint_fix") {
                  if (/\[WARNING\]/i.test(contentStr) || /已完成格式化|已完成格式化和规范修复|已使用 prettier 完成格式化/i.test(contentStr)) {
                    lintPassed = true;
                  }
                }
              }
            },
            brief: buildCoderExecutionContext(state, task),
            workspaceDir: WORKSPACE,
            timeoutMs: taskTimeoutMs,
            firstWriteTimeoutMs: taskFirstWriteTimeoutMs,
          });
          rawResponseText = extractText(coderResponse.content);
          extractResult = extractCodeFromResponse(rawResponseText);
        } catch (error: any) {
          if (error?.code === "CODER_FIRST_WRITE_TIMEOUT") {
            extractResult = {
              isValid: false,
              code: "",
              error: `首个写入超时（>${taskFirstWriteTimeoutMs}ms），在首次 write_file 前未产生任何落盘动作，判定当前任务过大或提示过重，请拆分职责或缩减上下文后重试`,
            };
          } else if (isAgentTimeoutError(error)) {
            const isSlowProgressTimeout = String(error?.timeoutKind || "").toLowerCase() === "slow_progress";
            extractResult = {
              isValid: false,
              code: "",
              error: isSlowProgressTimeout
                ? `单文件生成超时（慢进度，>${taskTimeoutMs}ms，期间有事件产出）。将自动提升一次超时预算后重试`
                : `单文件生成超时（无进度，>${taskTimeoutMs}ms，未观测到有效产出）。请缩小任务范围或拆分子任务`,
            };
          } else {
            throw error;
          }
        }
      }

      if (scaffoldAllowed) {
        emit("thinking", "System", `[Coder] 使用模板骨架直接生成 ${task.fileTarget}`, { task });
      }

      // 额外的质量校验：防止废话污染
      let formatError: string | null = null;
      let finalCode = "";
      let isSuccess = false;
      const shouldTrustDiskOutput =
        fileWrittenByTool &&
        unauthorizedWriteTargets.size === 0 &&
        (diagnosticsPassed || lintPassed || missingTargetDiagnostic || skipPerFileQualityChecks);

      if (shouldTrustDiskOutput) {
        const diskResult = await tryLoadValidatedDiskOutput(WORKSPACE, task.fileTarget, filesContent, state.executionProtocol);
        if (diskResult.ok) {
          finalCode = diskResult.code || "";
          isSuccess = true;
          generationSource = "recovered_disk";
          toolError = null;
          formatError = null;
        } else {
          const diskError = diskResult.error || "尝试读取已由工具写入的文件失败";
          if (
            (missingTargetDiagnostic && /读取已由工具写入的文件失败/.test(diskError)) ||
            (skipPerFileQualityChecks && extractResult?.isValid)
          ) {
            toolError = null;
          } else {
            formatError = diskError;
          }
        }
      }

      if (!isSuccess && extractResult?.isValid) {
        finalCode = extractResult.code || "";
        // 1. JSON 强校验
        if (task.fileTarget.endsWith(".json")) {
          try {
            JSON.parse(finalCode);
          } catch (e: any) {
            formatError = `JSON 格式校验失败：提取的内容不是合法的 JSON。请确保只输出 JSON 内容，严禁包含废话说明。`;
          }
        }
        // 2. 严禁 Markdown 汇报混入代码文件
        if (!task.fileTarget.endsWith(".md") && (finalCode.includes("## ") || finalCode.includes("任务完成") || finalCode.includes("修复了"))) {
           formatError = `提取的内容包含 Markdown 格式的汇报或总结性文字，这被判定为非纯净代码。请重新输出，严禁在代码块中包含任何自然语言说明。`;
        }

        if (!formatError) {
          const validationError = validateGeneratedFileContent(task.fileTarget, finalCode);
          if (validationError) {
            formatError = validationError;
          }
        }

        if (!formatError) {
          // 先 strip 无效 import，再校验导出契约
          if (isNodeLikeLanguage(state.spec?.language)) {
            const specFiles = (state.spec?.filesToCreate || []).map(f => f.replace(/\\/g, "/"));
            finalCode = stripInvalidImports(task.fileTarget, finalCode, filesContent, specFiles);
          }
          const importContractErrors = validateImportContracts(task.fileTarget, finalCode, filesContent);
          if (importContractErrors.length > 0) {
            formatError = `依赖导出契约校验失败: ${importContractErrors.join("; ")}`;
          }
        }

        if (!formatError) {
          const protocolDependencyErrors = validateProtocolDependencyRoles(state.executionProtocol, task.fileTarget, finalCode, filesContent);
          if (protocolDependencyErrors.length > 0) {
            formatError = `执行协议依赖角色校验失败: ${protocolDependencyErrors.join("; ")}`;
          }
        }

        if (!formatError) {
          isSuccess = true;
          generationSource = generationSource || "model";
        }
      }

      // 核心修复：如果纯文本提取失败，但 Agent 成功调用了 write_file 工具，则从磁盘读取结果作为最终代码
      if (!isSuccess && fileWrittenByTool && !formatError) {
         const diskResult = await tryLoadValidatedDiskOutput(WORKSPACE, task.fileTarget, filesContent, state.executionProtocol);
         if (diskResult.ok) {
            finalCode = diskResult.code || "";
            isSuccess = true;
            generationSource = "recovered_disk";
            toolError = null;
            formatError = null;
         } else {
            const diskError = diskResult.error || "尝试读取已由工具写入的文件失败";
            toolError = diskError;
         }
      }

      if (isSuccess && fileWrittenByTool && unauthorizedWriteTargets.size === 0) {
        toolError = null;
      }

      if (unauthorizedWriteTargets.size > 0) {
        for (const target of unauthorizedWriteTargets) {
          const targetPath = path.join(WORKSPACE, target);
          const previousContent = filesContent[target];
          if (previousContent === undefined) {
            await fs.rm(targetPath, { force: true }).catch(() => undefined);
          } else {
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.writeFile(targetPath, previousContent);
          }
        }
        toolError = `检测到越权写文件：当前任务只允许写入 ${task.fileTarget}，但工具还修改了 ${Array.from(unauthorizedWriteTargets).join(", ")}`;
      }

      if (toolError && !isBlockingToolError(toolError)) {
        toolError = null;
      }

      if (isSuccess && !toolError && !formatError) {
        // 自动剥离引用不存在文件的 import（硬约束，防止 LLM 幻觉导致编译失败）
        if (isNodeLikeLanguage(state.spec?.language)) {
          const specFiles = (state.spec?.filesToCreate || []).map(f => f.replace(/\\/g, "/"));
          finalCode = stripInvalidImports(task.fileTarget, finalCode, filesContent, specFiles);
        }
        const filePath = path.join(WORKSPACE, task.fileTarget);
        const previousCode = filesContent[task.fileTarget];
        const previousStatus = task.status;
        const previousError = task.lastError;
        const codeLogStartIndex = codeLogEntries.length;
        try {
          filesContent[task.fileTarget] = finalCode;
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, finalCode);
        task.status = "completed";
        delete task.lastError;
        codeLogEntries.push({
          round: currentRetry,
          file: task.fileTarget,
          taskTitle: task.description.slice(0, 80),
          status: "written",
          generationSource: generationSource || "model",
        });
        const incrementalResult = {
          code: JSON.stringify(filesContent, null, 2),
          subTasks: [...subTasks],
          codeLog: [...(state.codeLog || []), ...codeLogEntries],
          blockedReason: "",
          testResults: "",
          qaFailures: null,
          lastFailedNode: "",
          lastFailureSummary: "",
          failureFingerprint: "",
          sameFailureCount: 0,
        };
        await persistWriteRecoveryIntent(WORKSPACE, {
          taskId: task.id,
          fileTarget: task.fileTarget,
          expectedContent: finalCode,
          nodeName: `coder_task_${task.id}`,
          traceId: (state as any).traceId,
          snapshotState: { ...state, ...incrementalResult } as any,
        });
        await saveBoulder({ ...state, ...incrementalResult }, `coder_task_${task.id}`);
        await clearWriteRecoveryIntent(WORKSPACE, task.id);
        delete localRetryAttempts[task.fileTarget];
        delete localRetryArtifacts[task.fileTarget];
        progressMade = true;
        const checkpointDecision = shouldRequestValidationCheckpoint(state, subTasks as any, codeLogEntries);
        if (checkpointDecision.requested) {
          validationCheckpointRequested = true;
          validationCheckpointReason = checkpointDecision.reason;
          emit("thinking", "System", `[Coder] ${validationCheckpointReason}`, { task });
          break;
        }
        } catch (e: any) {
          await clearWriteRecoveryIntent(WORKSPACE, task.id);
          if (previousCode === undefined) {
            delete filesContent[task.fileTarget];
            await fs.rm(filePath, { force: true }).catch(() => undefined);
          } else {
            filesContent[task.fileTarget] = previousCode;
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, previousCode);
          }
          task.status = "failed";
          task.lastError = `状态保存失败: ${e.message || e}`;
          if (previousError) {
            task.lastError = `${previousError}; ${task.lastError}`;
          }
          codeLogEntries.splice(codeLogStartIndex);
          codeLogEntries.push({ round: currentRetry, file: task.fileTarget, taskTitle: task.description.slice(0, 80), status: "error", error: task.lastError });
          console.error(`${logPrefix("System")} [Coder] 任务失败 (${task.fileTarget}): ${task.lastError}`);
        }
      } else {
        const finalFailureReason = toolError || formatError || extractResult?.error || "代码提取失败或工具执行异常";
        if (
          shouldRetryTaskLocally({
            attempt: taskLocalAttempt,
            toolError,
            formatError,
            extractError: extractResult?.error || "",
            unauthorizedWriteTargets,
          })
        ) {
          localRetryAttempts[task.fileTarget] = taskLocalAttempt + 1;
          localRetryArtifacts[task.fileTarget] = summarizeSelfHealArtifact(finalCode || rawResponseText || "");
          task.status = "pending";
          task.lastError = finalFailureReason;
          progressMade = true;
          emit(
            "thinking",
            "System",
            `[Coder] ${task.fileTarget} 命中内容自愈错误，当前任务内重试一次：${finalFailureReason}`,
            { task }
          );
          continue;
        }

        task.status = "failed";
        task.lastError = finalFailureReason;
        console.error(`${logPrefix("System")} [Coder] 任务失败 (${task.fileTarget}): ${task.lastError}`);
        codeLogEntries.push({ round: currentRetry, file: task.fileTarget, taskTitle: task.description.slice(0, 80), status: "error", error: task.lastError });
        blockedReason = `Coder 阻塞失败: ${task.fileTarget} -> ${task.lastError}`;
        blockedFailedFiles = [task.fileTarget];
        emit("thinking", "System", `[Coder] 阻塞失败，停止本轮后续生成: ${blockedReason}`, { task });
        break;
      }

      // 3. 写一个存一个：每完成一个文件立即持久化状态，防止截断导致全盘丢失
    }

    if (validationCheckpointRequested) {
      break;
    }
  }

  await reconcileCompletedFilesFromDisk(WORKSPACE, subTasks as any, filesContent, codeLogEntries, currentRetry, state.executionProtocol, state.qaFailures?.failedFiles);

  // 清理重复的 jest/vitest 配置文件——优先保留 .cjs（确定性 scaffold 生成的），删除 .js/.ts（LLM 额外生成的）
  const configFiles = Object.keys(filesContent).map(f => f.replace(/\\/g, "/"));
  const jestCjs = configFiles.find(f => /jest\.config\.cjs$/i.test(f));
  if (jestCjs) {
    for (const duplicate of configFiles.filter(f => /^jest\.config\.(js|ts|mjs)$/i.test(path.posix.basename(f)))) {
      console.warn(`${logPrefix("System")} [Coder] 清理重复的 jest 配置: ${duplicate}（保留 ${jestCjs}）`);
      delete filesContent[duplicate];
      await fs.rm(path.join(WORKSPACE, duplicate), { force: true }).catch(() => undefined);
      // 从 subTasks 中也移除
      const idx = subTasks.findIndex(t => t.fileTarget.replace(/\\/g, "/") === duplicate);
      if (idx >= 0) subTasks.splice(idx, 1);
    }
  }

  if (blockedReason && blockedFailedFiles.length > 0) {
    const unresolvedBlockedFiles = blockedFailedFiles.filter((fileTarget) =>
      subTasks.some((task) => task.fileTarget === fileTarget && task.status !== "completed")
    );
    if (unresolvedBlockedFiles.length === 0) {
      blockedReason = "";
      blockedFailedFiles = [];
    }
  }

  if (!blockedReason) {
    const pendingTasks = subTasks.filter((task) => task.status !== "completed");
    const hasLocalSelfHealInFlight = Object.keys(localRetryAttempts).length > 0;
    if (
      pendingTasks.length > 0 &&
      codeLogEntries.filter((entry) => entry.status === "written").length === 0 &&
      !hasLocalSelfHealInFlight
    ) {
      const deadlocked = pendingTasks.map((task) => {
        const unmet = (task.dependencies || []).filter((dependency) => {
          if (filesContent[dependency] !== undefined) return false;
          // jest.config 变体名兼容：.js/.ts/.mjs 依赖在 .cjs 已存在时视为已满足
          if (/jest\.config\.(js|ts|mjs)$/.test(dependency)) {
            const cjsVariant = dependency.replace(/\.(js|ts|mjs)$/, '.cjs');
            if (filesContent[cjsVariant] !== undefined) return false;
          }
          return true;
        });
        return `${task.fileTarget} <- ${unmet.join(", ") || "无可满足依赖"}`;
      });
      blockedReason = `Coder 依赖死锁: ${deadlocked.join(" | ")}`;
      blockedFailedFiles = pendingTasks.map((task) => task.fileTarget);
    }
  }

  const completedList = subTasks.filter(t => t.status === "completed").map(t => t.fileTarget);
  const pendingList = subTasks.filter(t => t.status !== "completed").map(t => t.fileTarget);

  const consensusProgress: ConsensusProgress = {
    completedFiles: completedList,
    pendingFiles: pendingList,
    currentRound: currentRetry,
    openIssues: state.consensusProgress?.openIssues || [],
  };

  const completedCount = codeLogEntries.filter(e => e.status === "written").length;
  const completedFileNames = codeLogEntries.filter(e => e.status === "written").map(e => e.file);
  const noteId = `note-coder-r${currentRetry}`;
  const summary = `第${currentRetry}轮完成 ${completedCount} 个文件：${completedFileNames.slice(0, 3).join(", ")}${completedFileNames.length > 3 ? "..." : ""}`;
  const fullContent = `# Coder 第${currentRetry}轮纪要\n\n## 本轮完成文件\n${completedFileNames.map(f => `- ${f}`).join("\n") || "无"}\n\n## 本轮失败文件\n${codeLogEntries.filter(e => e.status === "error").map(e => `- ${e.file}: ${e.error}`).join("\n") || "无"}\n`;
  const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "coder", currentRetry, summary, fullContent);

  // P1-B：retryCount 由 qa_node 统一管理，coder 不自增
  const result = {
    code: JSON.stringify(filesContent, null, 2),
    subTasks: [...subTasks],
    codeLog: codeLogEntries,
    consensusProgress,
    meetingNotes: [meetingNote],
    blockedReason,
    validationCheckpointRequested,
    validationCheckpointCompleted: state.validationCheckpointCompleted || false,
    validationCheckpointReason,
    resumeAfterValidation: false,
    testResults: blockedReason ? `[Coder 阻塞失败]\n${blockedReason}` : "",
    qaFailures: blockedReason
      ? {
          failedFiles: blockedFailedFiles,
          testErrors: [blockedReason],
          failedTestNames: [],
        }
      : null,
    protocolFailures: blockedReason ? (state.protocolFailures || []) : [],
    lastFailedNode: blockedReason ? "coder" : "",
    lastFailureSummary: blockedReason ? blockedReason : "",
    failureFingerprint: blockedReason ? state.failureFingerprint : "",
    sameFailureCount: blockedReason ? state.sameFailureCount : 0,
  };
  try {
    await saveBoulder({ ...state, ...result }, "coder_final");
  } catch (e) {
    console.error(`${logPrefix("System")} [Coder] 最终状态保存失败: ${e}`);
  }
  return result;
}
