import * as fs from "fs/promises";
import * as path from "path";
import * as ts from "typescript";
import { JimClawState, FileChangeEntry, ConsensusProgress } from "../graph_types";
import { BaseAgent } from "../agent";
import {
  buildSystemContext,
  getProtocolFileContract,
  getDeterministicTemplateScaffold,
  logPrefix,
  writeMeetingNote,
  persistWriteRecoveryIntent,
  clearWriteRecoveryIntent
} from "../logic_utils";
import { extractText, extractCodeFromResponse } from "../../utils/common";

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

function normalizeStructuralDependencies(
  subTasks: Array<{ fileTarget: string; dependencies?: string[] }>
): void {
  const controllerTargets = subTasks.map((task) => normalizeTaskFileTarget(task.fileTarget)).filter(isControllerFile);
  const middlewareTargets = subTasks.map((task) => normalizeTaskFileTarget(task.fileTarget)).filter(isMiddlewareFile);
  const modelTargets = subTasks.map((task) => normalizeTaskFileTarget(task.fileTarget)).filter(isModelFile);
  const serviceTargets = subTasks.map((task) => normalizeTaskFileTarget(task.fileTarget)).filter(isServiceFile);

  for (const task of subTasks) {
    const fileTarget = normalizeTaskFileTarget(task.fileTarget);
    const nextDependencies = new Set((task.dependencies || []).map((dependency) => normalizeTaskFileTarget(dependency)));

    if (isControllerFile(fileTarget)) {
      for (const dependency of Array.from(nextDependencies)) {
        if (isRouteFile(dependency)) {
          nextDependencies.delete(dependency);
        }
      }
      for (const dependency of [...modelTargets, ...serviceTargets, ...middlewareTargets]) {
        if (dependency !== fileTarget) {
          nextDependencies.add(dependency);
        }
      }
    }

    if (isMiddlewareFile(fileTarget)) {
      for (const dependency of Array.from(nextDependencies)) {
        if (isControllerFile(dependency) || isRouteFile(dependency)) {
          nextDependencies.delete(dependency);
        }
      }
      for (const dependency of [...modelTargets, ...serviceTargets]) {
        if (dependency !== fileTarget) {
          nextDependencies.add(dependency);
        }
      }
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
      for (const dependency of modelTargets) {
        if (dependency !== fileTarget) {
          nextDependencies.add(dependency);
        }
      }
    }

    if (isRouteFile(fileTarget)) {
      for (const dependency of Array.from(nextDependencies)) {
        if (dependency.endsWith("src/index.ts") || dependency.endsWith("/index.ts") || dependency.endsWith("/index.js")) {
          nextDependencies.delete(dependency);
        }
      }
      for (const dependency of [...controllerTargets, ...middlewareTargets]) {
        if (dependency !== fileTarget) {
          nextDependencies.add(dependency);
        }
      }
    }

    task.dependencies = Array.from(nextDependencies);
  }
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
  const availableFiles = Object.keys(filesContent);
  const focused = new Set<string>();

  for (const dependency of task.dependencies || []) {
    const normalizedDependency = dependency.replace(/\\/g, "/");
    if (filesContent[normalizedDependency] !== undefined) {
      focused.add(normalizedDependency);
    }
  }

  if (!isTestFile(task.fileTarget)) {
    return Array.from(focused);
  }

  const normalizedTarget = task.fileTarget.replace(/\\/g, "/");
  const fileName = path.basename(normalizedTarget).replace(/(\.test|\.spec)\.[^.]+$/i, "");
  const domainStem = fileName.replace(/(controller|service|route|routes|middleware)$/i, "");

  for (const candidate of availableFiles) {
    const normalizedCandidate = candidate.replace(/\\/g, "/");
    const candidateBaseName = path.basename(normalizedCandidate, path.extname(normalizedCandidate));
    if (candidateBaseName === fileName) {
      focused.add(normalizedCandidate);
      continue;
    }

    if (domainStem && candidateBaseName === domainStem) {
      focused.add(normalizedCandidate);
    }
  }

  return Array.from(focused);
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

function validateImportContracts(
  fileTarget: string,
  content: string,
  filesContent: Record<string, string>
): string[] {
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

    if (!targetFile) continue;

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
    if (!currentContract.allowedDependencyRoles.includes(dependencyContract.role)) {
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
  protocol: JimClawState["executionProtocol"]
): Promise<void> {
  for (const task of subTasks) {
    if (task.status === "completed") continue;

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
  let blockedReason = "";
  let blockedFailedFiles: string[] = [];

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

  normalizeStructuralDependencies(subTasks as any);
  let progressMade = true;
  while (progressMade && !blockedReason) {
    progressMade = false;
    for (const task of subTasks) {
      // 2. 严格增量：跳过所有已完成且不在修复名单中的任务
      if (task.status === "completed") continue;
      if (!areTaskDependenciesSatisfied(task, subTasks as any, filesContent)) {
        emit("thinking", "System", `[Coder] 暂缓 ${task.fileTarget}，其依赖尚未完成: ${(task.dependencies || []).join(", ")}`, { task });
        continue;
      }

      emit("thinking", agents.coder.getPersona().name, `正在实现: ${task.fileTarget}`, { task });

      // 检查是否有 QA-Coder 协商后的修复计划
      const fixPlanItem = (state.fixPlan || []).find(p => p.fileTarget === task.fileTarget);

      let prompt = fixPlanItem
        // 有协商计划：直接按计划执行，不再靠自己猜
        ? `请修复 ${task.fileTarget}。\n\n[与QA协商后的修复方案（必须严格按此执行）]：\n- 根因：${fixPlanItem.diagnosis}\n- 具体修改：${fixPlanItem.proposedChange}${fixPlanItem.qaFeedback ? `\n- QA的纠正意见：${fixPlanItem.qaFeedback}` : ""}\n\n规范：${JSON.stringify(state.spec)}\n上下文：${task.contextRequirement}`
        // 无协商计划：首轮正常实现
        : `请实现 ${task.fileTarget}。\n规范：${JSON.stringify(state.spec)}\n上下文：${task.contextRequirement}`;

      // P0-A：注入 API 接口契约
      if (state.apiContract?.endpoints?.length) {
        prompt += `\n\n[API 接口契约]：\n${JSON.stringify(state.apiContract, null, 2)}`;
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
        prompt += `\n\n[测试文件直连上下文 - 只允许优先使用这些已完成文件，不要反复读取其他已完成文件]\n${focusedContextFiles.map(f => `- ${f}`).join("\n")}`;
        prompt += `\n\n[测试文件直连上下文内容]\n${focusedContextFiles.map(f => `### ${f}\n\`\`\`\n${filesContent[f]}\n\`\`\``).join("\n\n")}`;
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
1. **Jest Mock 污染防护**：如果 beforeEach 中调用了 mock 函数（如 register、setup 等会触发 mockResponse.json 的函数），必须在该 beforeEach 末尾添加 mock 重置，例如：
   \`\`\`typescript
   (mockResponse.json as jest.Mock).mockClear();
   (mockResponse.status as jest.Mock).mockClear();
   \`\`\`
   否则后续测试中 mock.calls[0][0] 会取到 setup 阶段的调用结果，导致断言失败。
2. **TypeScript 严格模式**：项目开启了 noUnusedLocals，任何 import 的类型或变量如果未在文件中使用，必须删除，否则整个测试套件将无法运行（TS6133 错误）。
3. **断言数据来源**：使用 mock.calls[N][0] 时，N 必须对应测试逻辑中第 N+1 次调用。如果 beforeEach 已经触发了一次调用，则测试中的第一次调用结果在 mock.calls[1][0] 而非 mock.calls[0][0]。`;
      }

      prompt += `\n\n[输出质量铁律 - 必须严格遵守]：
1. **代码包裹**：必须将实现的代码包裹在 Markdown 代码块中（例如 \`\`\`typescript 或 \`\`\`json）。
2. **拒绝废话**：严禁在代码块前后输出任何解释性文字。对于 JSON 文件，必须确保其为严格合法的 JSON 格式。
3. **按需引用**：严禁对当前 [行动清单] 中尚未生成的文件调用 read_file。请根据 [接口契约 (ApiContract)] 直接生成引用代码。
4. **防御性编程**：不要因为无法读取到某个物理文件而中断任务。你应该相信契约并继续完成你的当前任务。`;

      let toolError: string | null = null;
      let fileWrittenByTool = false;
      let diagnosticsPassed = false;
      let lintPassed = false;
      let missingTargetDiagnostic = false;
      const unauthorizedWriteTargets = new Set<string>();

      const normalizeWriteTarget = (rawTarget: string) => {
        const trimmed = rawTarget.trim().replace(/^["']|["']$/g, "");
        if (!trimmed) return "";
        const absolute = path.isAbsolute(trimmed) ? trimmed : path.join(WORKSPACE, trimmed);
        const relative = path.relative(WORKSPACE, absolute).replace(/\\/g, "/");
        return relative.startsWith("..") ? trimmed.replace(/\\/g, "/") : relative;
      };

      const deterministicScaffold = getDeterministicTemplateScaffold(state, task.fileTarget);
      const extractResult = deterministicScaffold
        ? { isValid: true, code: deterministicScaffold, error: "" }
        : extractCodeFromResponse(
            extractText(
              (
                await agents.coder.chat(
                  [{ role: "user", content: prompt }],
                  (ev) => {
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
                  { mode: "coding", brief: buildSystemContext(state), workspaceDir: WORKSPACE }
                )
              ).content
            )
          );

      if (deterministicScaffold) {
        emit("thinking", "System", `[Coder] 使用模板骨架直接生成 ${task.fileTarget}`, { task });
      }

      // 额外的质量校验：防止废话污染
      let formatError: string | null = null;
      let finalCode = "";
      let isSuccess = false;
      const shouldTrustDiskOutput =
        fileWrittenByTool &&
        unauthorizedWriteTargets.size === 0 &&
        (diagnosticsPassed || lintPassed || missingTargetDiagnostic);

      if (shouldTrustDiskOutput) {
        const diskResult = await tryLoadValidatedDiskOutput(WORKSPACE, task.fileTarget, filesContent, state.executionProtocol);
        if (diskResult.ok) {
          finalCode = diskResult.code || "";
          isSuccess = true;
          toolError = null;
          formatError = null;
        } else {
          const diskError = diskResult.error || "尝试读取已由工具写入的文件失败";
          if (missingTargetDiagnostic && /读取已由工具写入的文件失败/.test(diskError)) {
            toolError = null;
          } else {
            formatError = diskError;
          }
        }
      }

      if (!isSuccess && extractResult.isValid) {
        finalCode = extractResult.code;
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

        if (!formatError) isSuccess = true;
      }

      // 核心修复：如果纯文本提取失败，但 Agent 成功调用了 write_file 工具，则从磁盘读取结果作为最终代码
      if (!isSuccess && fileWrittenByTool && !formatError) {
         const diskResult = await tryLoadValidatedDiskOutput(WORKSPACE, task.fileTarget, filesContent, state.executionProtocol);
         if (diskResult.ok) {
            finalCode = diskResult.code || "";
            isSuccess = true;
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
        codeLogEntries.push({ round: currentRetry, file: task.fileTarget, taskTitle: task.description.slice(0, 80), status: "written" });
        const incrementalResult = {
          code: JSON.stringify(filesContent, null, 2),
          subTasks: [...subTasks],
          codeLog: [...(state.codeLog || []), ...codeLogEntries]
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
        progressMade = true;
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
        task.status = "failed";
        task.lastError = toolError || formatError || extractResult.error || "代码提取失败或工具执行异常";
        console.error(`${logPrefix("System")} [Coder] 任务失败 (${task.fileTarget}): ${task.lastError}`);
        codeLogEntries.push({ round: currentRetry, file: task.fileTarget, taskTitle: task.description.slice(0, 80), status: "error", error: task.lastError });
        blockedReason = `Coder 阻塞失败: ${task.fileTarget} -> ${task.lastError}`;
        blockedFailedFiles = [task.fileTarget];
        emit("thinking", "System", `[Coder] 阻塞失败，停止本轮后续生成: ${blockedReason}`, { task });
        break;
      }

      // 3. 写一个存一个：每完成一个文件立即持久化状态，防止截断导致全盘丢失
  }

  }

  await reconcileCompletedFilesFromDisk(WORKSPACE, subTasks as any, filesContent, codeLogEntries, currentRetry, state.executionProtocol);

  if (!blockedReason) {
    const pendingTasks = subTasks.filter((task) => task.status !== "completed");
    if (pendingTasks.length > 0 && codeLogEntries.filter((entry) => entry.status === "written").length === 0) {
      const deadlocked = pendingTasks.map((task) => {
        const unmet = (task.dependencies || []).filter((dependency) => filesContent[dependency] === undefined);
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
