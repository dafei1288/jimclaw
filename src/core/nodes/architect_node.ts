import * as fs from "fs/promises";
import * as path from "path";
import { BaseAgent } from "../agent";
import { ConsensusCore, ConsensusProgress, JimClawState, TechSpecSchema } from "../graph_types";
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
  ensureRequirementDrivenFiles,
  ensureTypeScriptTestBaseline,
  logPrefix,
  normalizeNodeProjectFileLayout,
  writeMeetingNote,
} from "../logic_utils";
import { extractText, parseJsonFromResponse } from "../../utils/common";
import { getTemplateEngine } from "../template_engine";

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

  const response = await agents.architect.chat(
    [{ role: "user", content: architectPrompt }],
    (ev) => emit(ev.type, ev.sender, ev.type === "llm_call_start" ? "正在制定技术规范" : ev.type === "tool_use" ? ev.content : "技术规范已完成", ev),
    { brief: buildSystemContext(state), workspaceDir: WORKSPACE }
  );

  const output = parseJsonFromResponse(extractText(response.content), {});
  const requirementProtocol = state.requirementProtocol || buildRequirementProtocol(state.contract);
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
  const spec = normalizeNodeProjectFileLayout(
    ensureTypeScriptTestBaseline(ensureRequirementDrivenFiles(normalizeNodeDependencyLayout(rawSpec), requirementProtocol))
  );
  const manifest = output.manifest || { services: [], environment: {}, sharedConfig: {} };
  const apiContract = ensureRequirementDrivenApiContract(output.apiContract || { endpoints: [] }, requirementProtocol);
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
    { brief: buildSystemContext(state), workspaceDir: WORKSPACE }
  );

  await fs.writeFile(path.join(WORKSPACE, "spec.json"), JSON.stringify(spec, null, 2));
  await fs.writeFile(path.join(WORKSPACE, "manifest.json"), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(WORKSPACE, "api_contract.json"), JSON.stringify(apiContract, null, 2));
  await fs.writeFile(path.join(WORKSPACE, "README.md"), extractText(readmeResponse.content));

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
  const summary = `架构完成：${spec.language}，${(spec.filesToCreate || []).length}个文件，端口${port}${planningFindings.length > 0 ? `，缺口${planningFindings.length}项` : ""}`;
  const fullContent = `# 架构设计纪要

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
