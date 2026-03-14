import * as fs from "fs/promises";
import * as path from "path";
import { JimClawState, FileChangeEntry, ConsensusProgress } from "../graph_types";
import { BaseAgent } from "../agent";
import {
  buildSystemContext,
  logPrefix,
  writeMeetingNote
} from "../logic_utils";
import { extractText, extractCodeFromResponse } from "../../utils/common";

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

  for (const task of subTasks) {
      // 2. 严格增量：跳过所有已完成且不在修复名单中的任务
      if (task.status === "completed") continue;

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

      // P0-A：注入已完成文件列表，让 Coder 知道哪些文件已就绪、可以 import
      const completedFiles = Object.keys(filesContent);
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

      const response = await agents.coder.chat(
        [{ role: "user", content: prompt }],
        (ev) => {
          emit(ev.type, ev.sender, `正在开发: ${task.fileTarget}`, ev);
          // 深度校验：通过监听工具调用的回显，准确捕获底层工具的报错
          if (ev.type === "tool_use" && ev.content) {
            const contentStr = String(ev.content);
            if (contentStr.includes("Error executing") || contentStr.includes("修复规范时出错") || contentStr.includes("Command failed")) {
              toolError = `工具执行异常: ${contentStr.slice(0, 200)}`;
            } else if (ev.tool === "write_file" && contentStr.includes("Successfully wrote")) {
              fileWrittenByTool = true;
            }
          }
        },
        { mode: "coding", brief: buildSystemContext(state), workspaceDir: WORKSPACE }
      );

      const extractResult = extractCodeFromResponse(extractText(response.content));

      // 额外的质量校验：防止废话污染
      let formatError: string | null = null;
      let finalCode = "";
      let isSuccess = false;

      if (extractResult.isValid) {
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

        if (!formatError && !toolError) isSuccess = true;
      }

      // 核心修复：如果纯文本提取失败，但 Agent 成功调用了 write_file 工具，则从磁盘读取结果作为最终代码
      if (!isSuccess && fileWrittenByTool && !toolError && !formatError) {
         try {
            const filePath = path.join(WORKSPACE, task.fileTarget);
            finalCode = await fs.readFile(filePath, "utf-8");
            isSuccess = true;
            formatError = null; // 清除由提取器产生的假错误
         } catch (e: any) {
            toolError = `尝试读取已由工具写入的文件失败: ${e.message}`;
         }
      }

      if (isSuccess && !toolError && !formatError) {
        filesContent[task.fileTarget] = finalCode;
        const filePath = path.join(WORKSPACE, task.fileTarget);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, finalCode);
        task.status = "completed";
        codeLogEntries.push({ round: currentRetry, file: task.fileTarget, taskTitle: task.description.slice(0, 80), status: "written" });
      } else {
        task.status = "failed";
        task.lastError = toolError || formatError || extractResult.error || "代码提取失败或工具执行异常";
        console.error(`${logPrefix("System")} [Coder] 任务失败 (${task.fileTarget}): ${task.lastError}`);
        codeLogEntries.push({ round: currentRetry, file: task.fileTarget, taskTitle: task.description.slice(0, 80), status: "error", error: task.lastError });
      }

      // 3. 写一个存一个：每完成一个文件立即持久化状态，防止截断导致全盘丢失
      const incrementalResult = {
        code: JSON.stringify(filesContent, null, 2),
        subTasks: [...subTasks],
        codeLog: [...(state.codeLog || []), ...codeLogEntries]
      };
      await saveBoulder({ ...state, ...incrementalResult }, `coder_task_${task.id}`);
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
  };
  await saveBoulder({ ...state, ...result }, "coder_final");
  return result;
}
