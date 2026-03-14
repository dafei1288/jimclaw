import { JimClawState, ConsensusProgress } from "../graph_types";
import { BaseAgent } from "../agent";
import {
  buildSystemContext,
  generateFallbackSubTasks,
  writeMeetingNote
} from "../logic_utils";
import { extractText, parseJsonFromResponse } from "../../utils/common";

/**
 * Orchestrator 节点：负责将技术规范拆解为具体的子任务
 */
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

  // P1-A：重写 orchestrator prompt，注入 apiContract 和 SubTask schema，明确 contextRequirement 期望
  const orchestratorPrompt = `请基于以下技术方案和 API 接口契约，将开发任务拆解为有序的文件级子任务列表。

[技术方案]：
${JSON.stringify(state.spec, null, 2)}

[API 接口契约]：
${JSON.stringify(state.apiContract, null, 2)}

[SubTask JSON Schema]：
每个子任务必须包含以下字段：
- id: 唯一标识符（如 "task-001"）
- fileTarget: 要创建/修改的文件路径（相对于项目根目录，如 "src/server.ts"）
- description: 该文件的功能描述（中文，1-2句话）
- dependencies: 依赖的其他文件列表（fileTarget 数组，必须先完成这些文件）
- contextRequirement: 关键上下文说明，**必须包含**：
  * 该文件的输入输出（参数、返回值）
  * 依赖的其他文件和它们导出的内容
  * 该文件涉及的具体 API 端点（路径、方法、请求/响应格式）
  * 任何需要特别注意的技术细节

[输出示例]：
[
  {
    "id": "task-001",
    "fileTarget": "src/types.ts",
    "description": "定义项目全局类型和接口",
    "dependencies": [],
    "contextRequirement": "导出 User 接口（id: number, name: string, email: string）和 ApiResponse<T> 泛型。无外部依赖。"
  },
  {
    "id": "task-002",
    "fileTarget": "src/server.ts",
    "description": "实现 Express HTTP 服务器，包含所有 API 路由",
    "dependencies": ["src/types.ts"],
    "contextRequirement": "导入 src/types.ts 的 User 和 ApiResponse 类型。实现以下端点：GET /api/users（返回 User[]）、POST /api/users（接受 {name, email}，返回创建的 User）。服务器必须监听 0.0.0.0 并使用 manifest 中的端口。"
  }
]

[要求]：
1. 必须覆盖 filesToCreate 中的所有文件：${JSON.stringify(state.spec?.filesToCreate || [])}
2. 任务按依赖顺序排列（被依赖的文件排在前面）
3. contextRequirement 必须具体，让 Coder 无需查阅其他资料即可实现该文件
4. 直接输出 JSON 数组，不要包含任何额外解释`;

  const response = await agents.pm.chat([{ role: "user", content: orchestratorPrompt }], (ev) => emit(ev.type, ev.sender, "正在拆解任务", ev), { brief: buildSystemContext(state), workspaceDir: WORKSPACE });
  let rawSubTasks = parseJsonFromResponse(extractText(response.content), []);

  // 校验逻辑：检查文件覆盖率
  const filesToCreate = state.spec?.filesToCreate || [];
  const createdInTasks = rawSubTasks.map((t: any) => t.fileTarget);
  const missingFiles = filesToCreate.filter(f => !createdInTasks.includes(f));

  if (rawSubTasks.length === 0 || (missingFiles.length > 0 && filesToCreate.length > 0)) {
    const reason = rawSubTasks.length === 0 ? "模型未生成子任务" : `子任务缺失关键文件: ${missingFiles.join(", ")}`;
    console.warn(`[Orchestrator] ${reason}，触发备用任务生成逻辑。`);
    rawSubTasks = generateFallbackSubTasks(state.spec, state.apiContract);
  }

  const subTasks = rawSubTasks.map((t: any) => ({ ...t, status: "pending" }));

  // JS/TS 安全网：独立注入 package.json / tsconfig.json，不依赖 fallback 条件
  // 根因：filesToCreate 可能本身不完整，missingFiles 检查无法覆盖这种情况
  const lang = (state.spec?.language || "").toLowerCase();
  const isJSTS = /typescript|javascript/.test(lang);
  if (isJSTS) {
    const fileTargetSet = new Set(subTasks.map((t: any) => t.fileTarget));
    if (!fileTargetSet.has("package.json")) {
      console.warn("[Orchestrator] JS/TS 项目未包含 package.json 子任务，自动注入。");
      const coreDeps = state.spec?.dependencies || {};
      const coreDevDeps = state.spec?.devDependencies || {};
      const depsHint = Object.keys(coreDeps).length > 0
        ? `\n【架构师指定运行时依赖，直接使用】：${JSON.stringify(coreDeps)}\n【架构师指定开发依赖，直接使用】：${JSON.stringify(coreDevDeps)}`
        : `\n运行时框架放 dependencies，typescript/ts-node/jest 等开发工具放 devDependencies。`;
      subTasks.unshift({
        id: "task-pkg-inject",
        fileTarget: "package.json",
        description: "定义项目依赖和脚本配置（自动注入）",
        dependencies: [],
        contextRequirement: `按架构师规范生成 package.json。scripts 必须包含 start 和 test 命令。${depsHint}\n如有额外依赖可追加，但禁止改变架构师定义的依赖分类。`,
        status: "pending",
      });
    }
    if (!fileTargetSet.has("tsconfig.json") && lang.includes("typescript")) {
      console.warn("[Orchestrator] TypeScript 项目未包含 tsconfig.json 子任务，自动注入。");
      const pkgIdx = subTasks.findIndex((t: any) => t.fileTarget === "package.json");
      subTasks.splice(pkgIdx + 1, 0, {
        id: "task-tsconfig-inject",
        fileTarget: "tsconfig.json",
        description: "TypeScript 编译配置（自动注入）",
        dependencies: ["package.json"],
        contextRequirement: `标准 TypeScript 项目配置：target ES2020，module commonjs，outDir dist，rootDir src，strict true，esModuleInterop true。`,
        status: "pending",
      });
    }
  }

  // 端口校验：从 manifest 获取端口（端口已在 consensusCore 中，此处仅同步回 manifest 确保整数干净）
  let rawPort = state.manifest?.services?.[0]?.port;
  let appPort = state.consensusCore?.port || 8080;

  if (typeof rawPort === 'number' && rawPort > 0 && rawPort < 65535) {
    appPort = rawPort;
  } else if (typeof rawPort === 'string') {
    const parsed = parseInt(String(rawPort).replace(/\D/g, ""), 10);
    if (parsed > 0 && parsed < 65535) appPort = parsed;
  }

  // 强制同步回 manifest，确保后续节点看到的都是纯净的整数端口
  const updatedManifest = state.manifest ? { ...state.manifest } : { services: [{ name: "default", port: appPort }], environment: {}, sharedConfig: {} };
  if (updatedManifest.services?.[0]) {
    updatedManifest.services[0].port = appPort;
  }

  const fileTargets = subTasks.map((t: any) => t.fileTarget);
  const consensusProgress: ConsensusProgress = {
    completedFiles: state.consensusProgress?.completedFiles || [],
    pendingFiles: fileTargets,
    currentRound: 0,
    openIssues: state.consensusProgress?.openIssues || [],
  };

  const fileList = fileTargets.slice(0, 5).join(", ") + (fileTargets.length > 5 ? ` 等${fileTargets.length}个` : "");
  const noteId = "note-orchestrator-r0";
  const summary = `拆解为 ${subTasks.length} 个子任务：${fileList}`;
  const fullContent = `# 任务拆解纪要\n\n## 子任务列表\n\`\`\`json\n${JSON.stringify(subTasks, null, 2)}\n\`\`\`\n`;
  const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "orchestrator", 0, summary, fullContent);

  const result = {
    subTasks,
    manifest: updatedManifest,
    consensusProgress,
    meetingNotes: [meetingNote],
  };
  await saveBoulder({ ...state, ...result }, "orchestrator");
  return result;
}
