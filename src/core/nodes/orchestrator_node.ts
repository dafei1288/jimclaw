import { AgentResourceExhaustedError, AgentServiceUnavailableError, AgentTimeoutError, BaseAgent } from "../agent";
import { ConsensusProgress, JimClawState, PlanningSource } from "../graph_types";
import {
  buildExecutionPlan,
  buildExecutionProtocol,
  buildRepairPlan,
  buildRequirementProtocol,
  buildSystemContext,
  buildValidationReport,
  findExecutionPlanGaps,
  generateFallbackSubTasks,
  normalizeNodeJestTestFilePath,
  stabilizeSpecForExecution,
  writeMeetingNote,
} from "../logic_utils";
import { extractText, parseJsonFromResponse } from "../../utils/common";

const ORCHESTRATOR_MODEL_TIMEOUT_MS = 90000;

function isRecoverableAgentError(error: unknown): error is AgentTimeoutError | AgentServiceUnavailableError | AgentResourceExhaustedError {
  return (
    error instanceof AgentTimeoutError ||
    error instanceof AgentServiceUnavailableError ||
    error instanceof AgentResourceExhaustedError
  );
}

export async function orchestratorNode(
  state: JimClawState,
  agents: { pm: BaseAgent },
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("orchestrator");
  emit("phase-change", "System", "planning");

  const requirementProtocol = state.requirementProtocol || buildRequirementProtocol(state.contract);
  const spec = stabilizeSpecForExecution(state.spec, requirementProtocol);
  const executionProtocol = state.executionProtocol || buildExecutionProtocol(spec, state.manifest, state.apiContract, requirementProtocol);

  const orchestratorPrompt = `请基于以下技术方案和 API 契约，将开发任务拆解为有序的文件级子任务列表。

[技术方案]
${JSON.stringify(spec, null, 2)}

[API 契约]
${JSON.stringify(state.apiContract, null, 2)}

[需求协议]
${JSON.stringify(requirementProtocol, null, 2)}

[执行协议]
${JSON.stringify(executionProtocol, null, 2)}

每个子任务必须包含：
- id
- fileTarget
- description
- dependencies
- contextRequirement

要求：
1. 必须覆盖 filesToCreate 中的所有文件，只生成 spec.filesToCreate 中列出的文件
2. 依赖顺序必须合理
3. 不要生成 spec.filesToCreate 之外的文件（奥卡姆剃刀原则）

直接输出 JSON 数组，不要额外解释。`;

  let rawSubTasks: any[] = [];
  let orchestrationSource: PlanningSource = "model";
  try {
    const response = await agents.pm.chat(
      [{ role: "user", content: orchestratorPrompt }],
      (ev) => emit(ev.type, ev.sender, "正在拆解任务", ev),
      {
        brief: buildSystemContext(state),
        workspaceDir: WORKSPACE,
        timeoutMs: ORCHESTRATOR_MODEL_TIMEOUT_MS,
        retryAttempts: 1,
        fallbackModeLimit: 1,
      }
    );
    rawSubTasks = parseJsonFromResponse(extractText(response.content), []);
  } catch (error: any) {
    if (!isRecoverableAgentError(error)) throw error;
    emit("thinking", "System", `任务拆解模型暂不可用，改用确定性子任务骨架继续执行：${error.message || error}`, {});
    rawSubTasks = generateFallbackSubTasks(spec, state.apiContract);
    orchestrationSource = "deterministic-fallback";
  }
  const filesToCreate = spec?.filesToCreate || [];
  const createdInTasks = rawSubTasks.map((task: any) => task.fileTarget);
  const missingFiles = filesToCreate.filter((file: string) => !createdInTasks.includes(file));

  if (rawSubTasks.length === 0 || (missingFiles.length > 0 && filesToCreate.length > 0)) {
    rawSubTasks = generateFallbackSubTasks(spec, state.apiContract);
    orchestrationSource = "deterministic-fallback";
  }

  // ── 奥卡姆剃刀：subTasks 的 fileTarget 必须在 spec.filesToCreate 内 ──
  // LLM 可能无视 spec 生成多余的 CRUD subTasks，必须硬性裁剪
  const specFileSet = new Set(filesToCreate.map((f: string) => f.replace(/\\/g, "/")));
  if (specFileSet.size > 0 && rawSubTasks.length > 0) {
    const before = rawSubTasks.length;
    rawSubTasks = rawSubTasks.filter((task: any) => {
      const target = String(task.fileTarget || "").replace(/\\/g, "/");
      // 允许 test 文件（不以 src/ 开头的文件通常不需要在 spec 里声明）
      if (/^tests?\//i.test(target) || /\.(test|spec)\./i.test(target)) return true;
      return specFileSet.has(target);
    });
    if (rawSubTasks.length < before) {
      emit("thinking", "System", `[Orchestrator] 奥卡姆剃刀：${before} → ${rawSubTasks.length} subTasks（裁剪了 ${before - rawSubTasks.length} 个不在 spec.filesToCreate 中的任务）`, {});
    }
  }

  const subTasks = rawSubTasks.map((task: any) => {
    const normalizedTarget = normalizeNodeJestTestFilePath(task.fileTarget);
    // 保留之前已完成的 status：如果磁盘上文件存在，保持 completed
    const previousTask = (state.subTasks || []).find(
      (t: any) => normalizeNodeJestTestFilePath(t.fileTarget) === normalizedTarget
    );
    const previousStatus = previousTask?.status;
    const wasCompleted = previousStatus === "completed";
    // 增量修改模式：已有文件标记为 completed，但 modifyFilesToOverwrite 中的文件除外
    const isExistingFile = state.existingFiles && normalizedTarget in state.existingFiles;
    const isOverwrite = state.modifyFilesToOverwrite && state.modifyFilesToOverwrite.includes(normalizedTarget);
    const shouldBeCompleted = (wasCompleted || isExistingFile) && !isOverwrite;
    return {
      ...task,
      fileTarget: normalizedTarget,
      dependencies: (task.dependencies || []).map((dep: string) => normalizeNodeJestTestFilePath(dep)),
      status: shouldBeCompleted ? "completed" : "pending" as const,
      // 自动推断 role：测试文件标记为 test 角色
      role: task.role || (/^tests?\//i.test(normalizedTarget) ? "test" : task.role || "implement"),
    };
  });

  if (requirementProtocol.capabilities.frontendRequired) {
    // 混合项目（spec.frontend 存在）已通过 scaffold 生成 frontend/ 目录，不需要 public/index.html
    const isMixedProject = Boolean((spec as any)?.frontend);
    const hasFrontendTask = subTasks.some((task: any) => /^public\/.+/i.test(task.fileTarget));
    if (!isMixedProject && !hasFrontendTask) {
      subTasks.push({
        id: "task-frontend-index-inject",
        fileTarget: "public/index.html",
        description: "实现前端页面入口（自动注入）",
        dependencies: ["src/index.ts"].filter((dep) => filesToCreate.includes(dep)),
        contextRequirement: "用户明确要求前后端。生成单文件前端页面，基于 API 契约提供列表、新增、编辑、删除交互，使用相对路径 fetch('/api/...') 调用后端。",
        status: "pending",
      });
    }
  }

  const lang = String(spec?.language || "").toLowerCase();
  const isJSTS = /typescript|javascript/.test(lang);
  const fileTargetSet = new Set(subTasks.map((task: any) => task.fileTarget));

  if (isJSTS && !fileTargetSet.has("package.json")) {
    subTasks.unshift({
      id: "task-pkg-inject",
      fileTarget: "package.json",
      description: "定义项目依赖和脚本配置（自动注入）",
      dependencies: [],
      contextRequirement: "生成 package.json，包含 start、test、build（如需要）脚本，并遵守架构师定义的 dependencies/devDependencies 分类。",
      status: "pending",
    });
  }

  if (isJSTS && lang.includes("typescript") && !fileTargetSet.has("tsconfig.json")) {
    subTasks.splice(1, 0, {
      id: "task-tsconfig-inject",
      fileTarget: "tsconfig.json",
      description: "TypeScript 编译配置（自动注入）",
      dependencies: ["package.json"],
      contextRequirement: "生成标准 TypeScript 项目配置：target ES2020、module commonjs、rootDir src、outDir dist、strict true、esModuleInterop true。",
      status: "pending",
    });
  }

  if (isJSTS && /npm test|jest/.test(String(spec?.testCommand || "").toLowerCase()) && !fileTargetSet.has("jest.config.cjs")) {
    subTasks.push({
      id: "task-jest-config-inject",
      fileTarget: "jest.config.cjs",
      description: "Jest 测试配置（自动注入）",
      dependencies: ["package.json"],
      contextRequirement: "生成最小可运行的 ts-jest 配置，roots 对齐 tests，testMatch 覆盖业务测试文件。",
      status: "pending",
    });
  }

  if (isJSTS && /npm test|jest/.test(String(spec?.testCommand || "").toLowerCase()) && !fileTargetSet.has("tests/setup.test.ts")) {
    subTasks.push({
      id: "task-jest-smoke-test-inject",
      fileTarget: "tests/setup.test.ts",
      description: "Jest 基线烟雾测试（自动注入）",
      dependencies: ["package.json", "jest.config.cjs"],
      contextRequirement: "生成一个最小 Jest 烟雾测试文件，保证测试基线可运行。",
      status: "pending",
    });
  }

  const executionPlan = buildExecutionPlan(spec, subTasks, requirementProtocol, executionProtocol);
  const planningGaps = findExecutionPlanGaps(executionPlan, requirementProtocol);
  const validationReport = buildValidationReport(planningGaps, {
    failureType: "planning_gap",
    status: planningGaps.length > 0 ? "fail" : "pass",
    blocking: planningGaps.length > 0,
  });
  const repairPlan = buildRepairPlan(validationReport);

  const rawPort = state.manifest?.services?.[0]?.port;
  let appPort = state.consensusCore?.port || 8080;
  if (typeof rawPort === "number" && rawPort > 0 && rawPort < 65535) {
    appPort = rawPort;
  } else if (typeof rawPort === "string") {
    const parsed = parseInt(String(rawPort).replace(/\D/g, ""), 10);
    if (parsed > 0 && parsed < 65535) appPort = parsed;
  }

  const updatedManifest = state.manifest
    ? { ...state.manifest, services: [...(state.manifest.services || [])] }
    : { services: [{ name: "default", port: appPort }], environment: {}, sharedConfig: {} };
  if (!updatedManifest.services?.length) {
    updatedManifest.services = [{ name: "default", port: appPort }];
  } else if (updatedManifest.services[0]) {
    updatedManifest.services[0].port = appPort;
  }

  const fileTargets = subTasks.map((task: any) => task.fileTarget);
  const consensusProgress: ConsensusProgress = {
    completedFiles: state.consensusProgress?.completedFiles || [],
    pendingFiles: fileTargets,
    currentRound: 0,
    openIssues: validationReport.findings.map((finding) => finding.summary),
  };

  const fileList = fileTargets.slice(0, 5).join(", ") + (fileTargets.length > 5 ? ` 等${fileTargets.length}个` : "");
  const noteId = "note-orchestrator-r0";
  const summary = `拆解为 ${subTasks.length} 个子任务：${fileList}${planningGaps.length > 0 ? `，缺口${planningGaps.length}项` : ""}`;
  const fullContent = `# 任务拆解纪要

## 来源
- ${orchestrationSource === "model" ? "模型生成" : "确定性降级骨架"}

## 子任务列表
\`\`\`json
${JSON.stringify(subTasks, null, 2)}
\`\`\`

## ExecutionPlan
\`\`\`json
${JSON.stringify(executionPlan, null, 2)}
\`\`\`

## ValidationReport
\`\`\`json
${JSON.stringify(validationReport, null, 2)}
\`\`\`
`;
  const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "orchestrator", 0, summary, fullContent);

  const result = {
    subTasks,
    orchestrationSource,
    manifest: updatedManifest,
    requirementProtocol,
    executionPlan,
    solutionProtocol: executionProtocol.solution,
    executionProtocol,
    validationReport,
    repairPlan,
    consensusProgress,
    meetingNotes: [meetingNote],
  };
  await saveBoulder({ ...state, ...result }, "orchestrator");

  // ── 缺口不阻塞：转为警告，允许管道继续执行 ──
  // 历史数据表明 33% 的失败源于此处误报（简单 API 不需要 CRUD 分层）
  // gaps 仅作为 meeting note 记录，供 QA 参考而不再直接抛异常
  if (validationReport.blocking) {
    emit("thinking", "Orchestrator", `[Orchestrator] 规划缺口警告（非阻塞）：${validationReport.findings.map(f => f.summary).join("；")}`, {});
  }

  return result;
}
