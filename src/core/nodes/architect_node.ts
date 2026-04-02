import * as fs from "fs/promises";
import * as path from "path";
import { AgentResourceExhaustedError, AgentServiceUnavailableError, AgentTimeoutError, BaseAgent } from "../agent";
import { ConsensusCore, ConsensusProgress, JimClawState, PlanningSource, TechSpecSchema } from "../graph_types";
import {
  buildCustomerApprovalState,
  buildExecutionProtocol,
  buildRepairPlan,
  buildRequirementProtocol,
  buildSolutionProtocol,
  buildSystemContext,
  buildTechnologyDecision,
  buildValidationReport,
  ensureRequirementDrivenApiContract,
  logPrefix,
  stabilizeSpecForExecution,
  writeMeetingNote,
} from "../logic_utils";
import { extractText, parseJsonFromResponse } from "../../utils/common";
import { getTemplateEngine } from "../template_engine";
import { FindFreePortSkill } from "../../skills/find_free_port";

const ARCHITECT_MODEL_TIMEOUT_MS = 60000;
const ARCHITECT_README_TIMEOUT_MS = 30000;

function isRecoverableAgentError(error: unknown): error is AgentTimeoutError | AgentServiceUnavailableError | AgentResourceExhaustedError {
  return (
    error instanceof AgentTimeoutError ||
    error instanceof AgentServiceUnavailableError ||
    error instanceof AgentResourceExhaustedError
  );
}

function singularizeStem(value: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "item";
  if (normalized.endsWith("ies")) return `${normalized.slice(0, -3)}y`;
  if (normalized.endsWith("ses")) return normalized.slice(0, -2);
  if (normalized.endsWith("s") && normalized.length > 1) return normalized.slice(0, -1);
  return normalized;
}

function getPrimaryEntity(requirementProtocol: any): { singular: string; plural: string } {
  const primary = requirementProtocol?.capabilities?.crudEntities?.[0]
    || requirementProtocol?.capabilities?.entities?.[0]
    || "item";
  const singular = singularizeStem(primary);
  const plural = singular.endsWith("s") ? singular : `${singular}s`;
  return { singular, plural };
}

async function buildDeterministicArchitectOutput(state: JimClawState) {
  const requirementProtocol = state.requirementProtocol || buildRequirementProtocol(state.contract);
  const { singular, plural } = getPrimaryEntity(requirementProtocol);
  const detectedPort = Number(await FindFreePortSkill.config.run({ start_port: 4000, end_port: 4999 })) || 4000;
  const filesToCreate = [
    "package.json",
    "tsconfig.json",
    "jest.config.cjs",
    "src/index.ts",
    `src/routes/${plural}.ts`,
    `src/controllers/${singular}Controller.ts`,
    `src/services/${singular}Service.ts`,
    `src/models/${singular}.ts`,
    `tests/${plural}.test.ts`,
    "scripts/verify.ts",
    "Dockerfile",
    "docker-compose.yml",
  ];
  if (requirementProtocol.capabilities.frontendRequired) filesToCreate.push("public/index.html");
  if (requirementProtocol.capabilities.authRequired) filesToCreate.push("src/middleware/auth.ts");
  if (requirementProtocol.capabilities.auditLogRequired) filesToCreate.push("src/logging/logger.ts");

  const spec = stabilizeSpecForExecution(normalizeNodeDependencyLayout({
    architecture: `确定性降级骨架：基于 Express + TypeScript 的单体应用，围绕 ${singular} 资源提供 API、验证脚本与部署入口。`,
    language: "TypeScript",
    framework: "Express.js ^5.0",
    testCommand: "npm test",
    runCommand: "npm start",
    entryPoint: "src/index.ts",
    authScaffoldMode: "compact",
    filesToCreate,
    interfaces: "REST API",
    dependencies: {
      express: "^5.0.0",
      cors: "^2.8.5",
      ...(requirementProtocol.capabilities.authRequired ? { jsonwebtoken: "^9.0.2" } : {}),
    },
    devDependencies: {
      typescript: "^5.0.0",
      "ts-node": "^10.9.2",
      jest: "^29.7.0",
      "ts-jest": "^29.1.1",
      "@types/jest": "^29.5.12",
      "@types/node": "^20.11.30",
      supertest: "^7.0.0",
      "@types/supertest": "^6.0.3",
    },
  }), requirementProtocol);

  const manifest = {
    services: [{ name: "api", port: detectedPort, description: "主应用服务" }],
    environment: {},
    sharedConfig: {},
  };
  const apiContract = ensureRequirementDrivenApiContract({
    endpoints: [
      { path: "/api/health", method: "GET", description: "健康检查" },
      { path: `/api/${plural}`, method: "GET", description: `${singular}列表` },
      { path: `/api/${plural}`, method: "POST", description: `创建${singular}` },
      { path: `/api/${plural}/:id`, method: "GET", description: `${singular}详情` },
      { path: `/api/${plural}/:id`, method: "PUT", description: `更新${singular}` },
      { path: `/api/${plural}/:id`, method: "DELETE", description: `删除${singular}` },
      ...(requirementProtocol.capabilities.authRequired
        ? [{ path: "/api/auth/login", method: "POST", description: "用户登录" }]
        : []),
    ],
  }, requirementProtocol);

  const readme = `# ${state.contract?.title || "项目"}\n\n## 说明\n本次使用确定性降级骨架生成最小可执行方案，以便在模型暂不可用时继续推进流程。\n\n## 技术栈\n- TypeScript\n- Express\n- Jest\n- Docker\n\n## 启动\n- 安装依赖：\`npm install\`\n- 运行测试：\`npm test\`\n- 启动服务：\`npm start\`\n\n## 接口\n- 健康检查：\`GET /api/health\`\n- 主资源：\`GET /api/${plural}\`\n`;

  return { requirementProtocol, spec, manifest, apiContract, readme };
}

function normalizeNodeDependencyLayout(spec: any): any {
  const language = String(spec?.language || "").toLowerCase();
  if (!/typescript|javascript|node/.test(language)) return spec;

  const dependencies = { ...(spec?.dependencies || {}) } as Record<string, string>;
  const devDependencies = { ...(spec?.devDependencies || {}) } as Record<string, string>;

  for (const pkg of Object.keys(dependencies)) {
    if (pkg.startsWith("@types/")) {
      devDependencies[pkg] = dependencies[pkg];
      delete dependencies[pkg];
    }
  }

  if ("@types/mongoose" in devDependencies) {
    delete devDependencies["@types/mongoose"];
  }

  return {
    ...spec,
    dependencies,
    devDependencies,
  };
}

export async function architectNode(
  state: JimClawState,
  agents: { architect: BaseAgent },
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("architect");
  console.log(`${logPrefix(agents.architect.getPersona().name)} 正在制定技术规范...`);
  emit("phase-change", "System", "design");
  emit("thinking", agents.architect.getPersona().name, "正在制定技术规范...");

  const architectPrompt = `基于此任务契约：${JSON.stringify(state.contract)}，设计技术方案。

要求：
1. 先调用 find_free_port，为服务选择真实空闲端口。
2. 方案必须覆盖所有用户需求，尤其是前端/后端/测试/部署要求。
3. 明确主框架、核心 dependencies、devDependencies、测试命令、运行命令、入口文件。
4. filesToCreate 必须完整列出项目需要创建的文件，包括配置、源码、测试、Docker 文件。
5. 需要同时输出 spec、manifest、apiContract 三部分。

严格按以下 JSON 输出：
{
  "spec": {
    "architecture": "...",
    "language": "TypeScript",
    "framework": "Express.js ^4.18",
    "testCommand": "npm test",
    "runCommand": "npm start",
    "entryPoint": "src/index.ts",
    "filesToCreate": ["package.json", "tsconfig.json", "src/index.ts"],
    "interfaces": "...",
    "dependencies": {},
    "devDependencies": {}
  },
  "manifest": {
    "services": [{ "name": "api", "port": 10000, "description": "..." }],
    "environment": {},
    "sharedConfig": {}
  },
  "apiContract": {
    "endpoints": [{ "path": "/api/health", "method": "GET", "description": "健康检查" }]
  }
}`;

  let requirementProtocol = state.requirementProtocol || buildRequirementProtocol(state.contract);
  let spec: any;
  let manifest: any;
  let apiContract: any;
  let readmeContent = "";
  let designSource: PlanningSource = "model";

  try {
    const response = await agents.architect.chat(
      [{ role: "user", content: architectPrompt }],
      (ev) => emit(ev.type, ev.sender, ev.type === "llm_call_start" ? "正在制定技术规范" : ev.type === "tool_use" ? ev.content : "技术规范已完成", ev),
      {
        brief: buildSystemContext(state),
        workspaceDir: WORKSPACE,
        timeoutMs: ARCHITECT_MODEL_TIMEOUT_MS,
      }
    );

    const output = parseJsonFromResponse(extractText(response.content), {});
    const rawSpec = output.spec || {
      architecture: "未知",
      language: "TypeScript",
      framework: "Express.js ^4.18",
      testCommand: "npm test",
      runCommand: "npm start",
      entryPoint: "src/index.ts",
      filesToCreate: [],
      interfaces: "",
      dependencies: {},
      devDependencies: {},
    };
    spec = stabilizeSpecForExecution(normalizeNodeDependencyLayout(rawSpec), requirementProtocol);
    manifest = output.manifest || { services: [], environment: {}, sharedConfig: {} };
    apiContract = ensureRequirementDrivenApiContract(output.apiContract || { endpoints: [] }, requirementProtocol);
  } catch (error: any) {
    if (!isRecoverableAgentError(error)) throw error;
    designSource = "deterministic-fallback";
    emit("thinking", "System", `架构师模型暂不可用，改用确定性技术骨架继续执行：${error.message || error}`, {});
    const fallback = await buildDeterministicArchitectOutput(state);
    requirementProtocol = fallback.requirementProtocol;
    spec = fallback.spec;
    manifest = fallback.manifest;
    apiContract = fallback.apiContract;
    readmeContent = fallback.readme;
  }

  const technologyDecision = buildTechnologyDecision(requirementProtocol, spec);
  const solutionProtocol = buildSolutionProtocol(requirementProtocol, spec, apiContract);
  const executionProtocol = buildExecutionProtocol(spec, manifest, apiContract, requirementProtocol);
  const customerApprovalState = buildCustomerApprovalState({
    autoApprove: state.customerApprovalState?.autoApprove,
    summaries: {
      requirements: state.customerApprovalState?.checkpoints?.find((item) => item.stage === "requirements")?.summary || `${state.contract?.title || "项目"}需求已确认`,
      solution: `${spec.framework || spec.language || "方案"}，文件 ${spec.filesToCreate?.length || 0} 个，服务 ${manifest.services?.length || 0} 个`,
      deploy: state.customerApprovalState?.checkpoints?.find((item) => item.stage === "deploy")?.summary || "",
    },
  });

  const planningFindings = [
    ...solutionProtocol.coverage.uncoveredRequirements.map((requirement) => ({
      summary: `方案未覆盖需求：${requirement}`,
      evidence: [`未覆盖需求：${requirement}`],
    })),
    ...solutionProtocol.coverage.uncoveredAcceptanceCriteria.map((criteria) => ({
      summary: `方案未覆盖验收：${criteria}`,
      evidence: [`未覆盖验收：${criteria}`],
    })),
  ];
  if (requirementProtocol.capabilities.frontendRequired && !solutionProtocol.coverage.frontendPlanned) {
    planningFindings.push({
      summary: "方案未覆盖需求：用户要求前端，但方案中缺少前端页面入口",
      evidence: ["frontendRequired=true", `filesToCreate=${JSON.stringify(spec.filesToCreate || [])}`],
    });
  }
  if (requirementProtocol.capabilities.backendRequired && !solutionProtocol.coverage.backendPlanned) {
    planningFindings.push({
      summary: "方案未覆盖需求：用户要求后端 API，但方案中缺少后端入口或接口规划",
      evidence: ["backendRequired=true", `filesToCreate=${JSON.stringify(spec.filesToCreate || [])}`, `apiEndpoints=${JSON.stringify(apiContract.endpoints || [])}`],
    });
  }
  if (requirementProtocol.capabilities.authRequired && !solutionProtocol.coverage.authPlanned) {
    planningFindings.push({
      summary: "方案未覆盖需求：用户要求认证能力，但方案中缺少认证模块规划",
      evidence: ["authRequired=true"],
    });
  }
  if (requirementProtocol.capabilities.auditLogRequired && !solutionProtocol.coverage.auditLogPlanned) {
    planningFindings.push({
      summary: "方案未覆盖需求：用户要求日志审计，但方案中缺少日志模块规划",
      evidence: ["auditLogRequired=true"],
    });
  }
  const validationReport = buildValidationReport(planningFindings, {
    failureType: "planning_gap",
    status: planningFindings.length > 0 ? "fail" : "pass",
    blocking: planningFindings.length > 0,
  });
  const repairPlan = buildRepairPlan(validationReport);

  const specValidation = TechSpecSchema.safeParse(spec);
  if (!specValidation.success) {
    console.warn("[Architect] TechSpec 校验失败:", specValidation.error.message);
  }

  if (!readmeContent) {
    try {
      const readmeResponse = await agents.architect.chat(
        [{
          role: "user",
          content: `基于以下设计，生成一份中文 README.md：

项目规范：${JSON.stringify(spec, null, 2)}
API 接口：${JSON.stringify(apiContract, null, 2)}
服务配置：${JSON.stringify(manifest, null, 2)}

请包含：项目简介、快速开始、API 文档、架构说明。`,
        }],
        (ev) => emit(ev.type, ev.sender, "正在生成 README", ev),
        {
          brief: buildSystemContext(state),
          workspaceDir: WORKSPACE,
          timeoutMs: ARCHITECT_README_TIMEOUT_MS,
        }
      );
      readmeContent = extractText(readmeResponse.content);
    } catch (error: any) {
      if (!isRecoverableAgentError(error)) throw error;
      designSource = "deterministic-fallback";
      readmeContent = `# ${state.contract?.title || "项目"}\n\n## 说明\nREADME 由确定性降级骨架生成，因为架构师 README 补充阶段超时或暂不可用。\n\n## 启动\n- npm install\n- npm test\n- npm start\n`;
    }
  }

  await fs.writeFile(path.join(WORKSPACE, "spec.json"), JSON.stringify(spec, null, 2));
  await fs.writeFile(path.join(WORKSPACE, "manifest.json"), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(WORKSPACE, "api_contract.json"), JSON.stringify(apiContract, null, 2));
  await fs.writeFile(path.join(WORKSPACE, "README.md"), readmeContent);

  const architectName = agents.architect.getPersona().name;
  const templateEngine = getTemplateEngine();
  await templateEngine.loadTemplates();
  const template = templateEngine.recommendTemplate(spec.language || "TypeScript", []);
  const port = manifest.services?.[0]?.port || 0;
  const criticalDecisions: string[] = ["单元测试文件只能测试导出的纯函数"];
  if (template) {
    criticalDecisions.push(`推荐模板: ${template.name}`);
  }
  criticalDecisions.push("需求协议/技术决策/方案协议/执行协议已建立，用户需求优先于架构收缩");

  const consensusCore: ConsensusCore = {
    projectTitle: state.consensusCore?.projectTitle || state.contract?.title || "",
    requirements: state.consensusCore?.requirements || state.contract?.requirements || [],
    architectureSummary: spec.architecture || "",
    techStack: `${spec.language}${spec.framework ? ` + ${spec.framework}` : ""}`,
    framework: spec.framework || "",
    port,
    coreDependencies: spec.dependencies || {},
    coreDevDependencies: spec.devDependencies || {},
    criticalDecisions,
  };

  const consensusProgress: ConsensusProgress = {
    completedFiles: [],
    pendingFiles: spec.filesToCreate || [],
    currentRound: 0,
    openIssues: planningFindings.map((finding) => finding.summary),
  };

  const noteId = "note-architect-r0";
  const summary = `${designSource === "model" ? "架构完成" : "架构降级完成"}：${spec.language}，${(spec.filesToCreate || []).length}个文件，端口${port}${planningFindings.length > 0 ? `，缺口${planningFindings.length}项` : ""}`;
  const fullContent = `# 架构设计纪要

## 来源
- ${designSource === "model" ? "模型生成" : "确定性降级骨架"}

## 需求协议
\`\`\`json
${JSON.stringify(requirementProtocol, null, 2)}
\`\`\`

## 技术决策
\`\`\`json
${JSON.stringify(technologyDecision, null, 2)}
\`\`\`

## 技术规范
\`\`\`json
${JSON.stringify(spec, null, 2)}
\`\`\`

## 服务清单
\`\`\`json
${JSON.stringify(manifest, null, 2)}
\`\`\`

## API 契约
\`\`\`json
${JSON.stringify(apiContract, null, 2)}
\`\`\`

## 方案协议
\`\`\`json
${JSON.stringify(solutionProtocol, null, 2)}
\`\`\`

## 执行协议
\`\`\`json
${JSON.stringify(executionProtocol, null, 2)}
\`\`\`

## 验证报告
\`\`\`json
${JSON.stringify(validationReport, null, 2)}
\`\`\`
`;
  const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "architect", 0, summary, fullContent);

  emit("artifact", architectName, "技术方案已完成。", {
    requirementProtocol,
    technologyDecision,
    solutionProtocol,
    spec,
    manifest,
    apiContract,
    executionProtocol,
    validationReport,
    customerApprovalState,
  });

  const result = {
    templateId: template?.id,
    designSource,
    spec,
    manifest,
    apiContract,
    requirementProtocol,
    technologyDecision,
    solutionProtocol,
    executionProtocol,
    validationReport,
    repairPlan,
    customerApprovalState,
    consensusCore,
    consensusProgress,
    meetingNotes: [meetingNote],
    teamChatLog: [{ sender: architectName, content: "我已经完成系统设计。" }],
  };
  await saveBoulder({ ...state, ...result }, "architect");

  if (validationReport.blocking) {
    throw new Error(validationReport.findings.map((finding) => finding.summary).join("；"));
  }

  return result;
}
