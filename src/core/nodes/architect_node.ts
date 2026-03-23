import * as fs from "fs/promises";
import * as path from "path";
import { JimClawState, TechSpecSchema, ConsensusCore, ConsensusProgress } from "../graph_types";
import { BaseAgent } from "../agent";
import {
  logPrefix,
  buildSystemContext,
  ensureTypeScriptTestBaseline,
  writeMeetingNote
} from "../logic_utils";
import { extractText, parseJsonFromResponse } from "../../utils/common";
import { getTemplateEngine } from "../template_engine";
import { REQUIRED_MIDDLEWARE, MiddlewareSpec } from "../middleware_standards";

function normalizeNodeDependencyLayout(spec: any): any {
  const language = String(spec?.language || "").toLowerCase();
  if (!/typescript|javascript|node/.test(language)) return spec;

  const dependencies = { ...(spec?.dependencies || {}) } as Record<string, string>;
  const devDependencies = { ...(spec?.devDependencies || {}) } as Record<string, string>;

  // @types/* 只应存在于 devDependencies
  for (const pkg of Object.keys(dependencies)) {
    if (pkg.startsWith("@types/")) {
      devDependencies[pkg] = dependencies[pkg];
      delete dependencies[pkg];
    }
  }

  // mongoose 自带类型定义，保留会导致 npm ETARGET（7.x 不存在）
  if ("@types/mongoose" in devDependencies) {
    delete devDependencies["@types/mongoose"];
  }

  return {
    ...spec,
    dependencies,
    devDependencies,
  };
}

/**
 * Architect 节点：负责系统架构设计和技术规范制定
 */
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

  const response = await agents.architect.chat([
    { role: "user", content: `基于此契约：${JSON.stringify(state.contract)}，设计技术方案。

  要求：
  1. **端口预检（关键）**：在定义方案前，必须调用 'find_free_port' 技能查找一个宿主机上真实的空闲端口（建议从 10000 开始扫描）。
  2. 深入分析功能需求，确保架构设计涵盖所有 requirement。
  3. 必须包含所有 API 接口的设计（路径、方法、请求/响应结构）。
  4. **技术选型（团队共识基准）**：
     - 明确指定主框架及版本，如 "Express.js ^4.18"、"FastAPI ^0.110"
     - 明确列出所有核心运行时依赖（dependencies）和开发依赖（devDependencies），带精确版本号
     - 这些依赖将作为团队共识写入 spec，Coder 以此为基准实现，可追加但不得擅自更改分类
  5. **filesToCreate 必须完整**：必须列出项目所有需要创建的文件，包括：
     - Node.js/TypeScript 项目：package.json、tsconfig.json、所有 .ts/.js 源文件、测试文件
     - Python 项目：requirements.txt、所有 .py 源文件、测试文件
     - 容器化文件：Dockerfile、docker-compose.yml
  6. 在输出的 manifest 中，必须使用你通过工具找出的那个真实空闲端口作为服务的运行端口。

  请严格按照以下 JSON 格式输出，不要包含多余字段：
  {
  "spec": {
    "architecture": "...",
    "language": "TypeScript",
    "framework": "Express.js ^4.18",
    "testCommand": "npm test",
    "runCommand": "npm start",
    "entryPoint": "src/index.ts",
    "filesToCreate": ["package.json", "tsconfig.json", "src/index.ts", "..."],
    "interfaces": "...",
    "dependencies": {
      "express": "^4.18.2",
      "cors": "^2.8.5"
    },
    "devDependencies": {
      "typescript": "^5.3.3",
      "ts-node": "^10.9.2",
      "@types/express": "^4.17.21",
      "jest": "^29.7.0",
      "ts-jest": "^29.1.1",
      "@types/jest": "^29.5.11",
      "@types/node": "^20.10.0"
    }
  },
  "manifest": {
    "services": [{"name": "...", "port": 你找出的空闲端口, "description": "..."}],
    "environment": {},
    "sharedConfig": {}
  },
  "apiContract": {
    "endpoints": [{"path": "...", "method": "...", "description": "..."}]
  }
  }

  请确保内容使用中文描述。` }
  ], (ev) => emit(ev.type, ev.sender, ev.type === 'llm_call_start' ? "正在制定技术规范" : ev.type === 'tool_use' ? ev.content : "技术规范已完成", ev), { brief: buildSystemContext(state), workspaceDir: WORKSPACE });


  const output = parseJsonFromResponse(extractText(response.content), {});
  const rawSpec = output.spec || { architecture: "未知", language: "TypeScript", testCommand: "npm test", runCommand: "npm start", entryPoint: "http://localhost:3000", filesToCreate: [] };
  const spec = ensureTypeScriptTestBaseline(normalizeNodeDependencyLayout(rawSpec));
  const manifest = output.manifest || { services: [], environment: {} };
  const apiContract = output.apiContract || { endpoints: [] };

  const specValidation = TechSpecSchema.safeParse(spec);
  if (!specValidation.success) console.warn("[Architect] TechSpec 校验失败:", specValidation.error.message);

  // P0-C：注入设计产出，确保 README 与实际架构一致
  const readmeResponse = await agents.architect.chat([{ role: "user", content: `基于以下设计，生成一份中文的 README.md：

项目规范：${JSON.stringify(spec, null, 2)}
API 接口：${JSON.stringify(apiContract, null, 2)}
服务配置：${JSON.stringify(manifest, null, 2)}

请包含：项目简介、快速开始、API 文档（包含每个端点的路径、方法、说明）、架构说明。` }], (ev) => emit(ev.type, ev.sender, "正在生成 README", ev), { brief: buildSystemContext(state), workspaceDir: WORKSPACE });

  await fs.writeFile(path.join(WORKSPACE, "spec.json"), JSON.stringify(spec, null, 2));
  await fs.writeFile(path.join(WORKSPACE, "manifest.json"), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(WORKSPACE, "api_contract.json"), JSON.stringify(apiContract, null, 2));
  await fs.writeFile(path.join(WORKSPACE, "README.md"), extractText(readmeResponse.content));

  const architectName = agents.architect.getPersona().name;

  const language = spec.language || "TypeScript";
  const templateEngine = getTemplateEngine();
  await templateEngine.loadTemplates();
  const template = templateEngine.recommendTemplate(language, []);

  const port = manifest.services?.[0]?.port || 0;
  const criticalDecisions: string[] = ["单元测试文件只能测导出的纯函数"];
  if (template) {
    criticalDecisions.push(`推荐模板: ${template.name}`);
  }

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
    openIssues: [],
  };

  const noteId = "note-architect-r0";
  const summary = `架构师完成设计：${spec.language}，${(spec.filesToCreate || []).length}个文件，端口${port}`;
  const fullContent = `# 架构设计纪要\n\n## 技术规范\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n\n## 服务清单\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\n## API 契约\n\`\`\`json\n${JSON.stringify(apiContract, null, 2)}\n\`\`\`\n`;
  const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "architect", 0, summary, fullContent);

  emit("artifact", architectName, "技术方案已完成。", { spec, manifest, apiContract });
  const result = {
    templateId: template?.id,
    spec,
    manifest,
    apiContract,
    consensusCore,
    consensusProgress,
    meetingNotes: [meetingNote],
    teamChatLog: [{ sender: architectName, content: "我已完成系统设计。" }],
  };
  await saveBoulder({ ...state, ...result }, "architect");
  return result;
}
