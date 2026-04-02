import { ChatAnthropic } from "@langchain/anthropic";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { Skill } from "./skill";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ModelManager } from "../utils/models";
import { SystemMessage, HumanMessage, AIMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";
import * as fs from "fs/promises";
import * as path from "path";
import { AuditLogger } from "../utils/audit";
import { getBeijingTime } from "../utils/common";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function isRetryableError(err: any): boolean {
  const status = err.status || err.response?.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  const code = err.code || err.cause?.code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "EACCES" || code === "ABORT_ERR") return true;
  const message = (err.message || "").toLowerCase();
  if (
    message.includes("timeout")
    || message.includes("econnreset")
    || message.includes("network error")
    || message.includes("connection error")
    || message.includes("api connection error")
    || message.includes("request was aborted")
    || message.includes("aborterror")
  ) return true;
  return false;
}

function isResourceExhaustedError(err: any): boolean {
  const status = err.status || err.response?.status;
  const code = String(err.code || err.error?.code || err.cause?.code || "").toLowerCase();
  const type = String(err.type || err.error?.type || "").toLowerCase();
  const message = String(err.message || err.error?.message || "").toLowerCase();

  if ((status === 402 || status === 403) && (
    code.includes("insufficient") ||
    code.includes("quota") ||
    type.includes("quota") ||
    message.includes("quota") ||
    message.includes("额度不足") ||
    message.includes("balance exhausted")
  )) {
    return true;
  }

  return false;
}

function formatErrorMessage(err: any): string {
  return err?.message || String(err);
}

function extractTokenUsage(response: any): { inputTokens: number; outputTokens: number; totalTokens: number; model?: string } | null {
  const usage = response?.usage_metadata || response?.response_metadata?.usage || response?.response_metadata?.tokenUsage;
  const inputTokens = Number(
    usage?.input_tokens ??
    usage?.prompt_tokens ??
    usage?.promptTokens ??
    usage?.inputTokens ??
    0
  );
  const outputTokens = Number(
    usage?.output_tokens ??
    usage?.completion_tokens ??
    usage?.completionTokens ??
    usage?.outputTokens ??
    0
  );
  const totalTokens = Number(
    usage?.total_tokens ??
    usage?.totalTokens ??
    inputTokens + outputTokens
  );

  if (inputTokens <= 0 && outputTokens <= 0 && totalTokens <= 0) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    model: response?.response_metadata?.model_name || response?.response_metadata?.model || response?.lc_kwargs?.model,
  };
}

export interface AgentPersona {
  name: string;
  role: string;
  specialty: string;
  personality: string;
  color?: string; // 终端显示的颜色（支持 chalk 颜色名称）
}

export class AgentTimeoutError extends Error {
  code: string;
  timeoutMs: number;

  constructor(agentName: string, timeoutMs: number) {
    super(`${agentName} 调用超时（>${timeoutMs}ms）`);
    this.name = "AgentTimeoutError";
    this.code = "AGENT_TIMEOUT";
    this.timeoutMs = timeoutMs;
  }
}

export class AgentServiceUnavailableError extends Error {
  code: string;
  agentName: string;
  mode?: string;
  cause?: unknown;

  constructor(agentName: string, reason: string, mode?: string, cause?: unknown) {
    super(`${agentName} 模型服务暂不可用：${reason}`);
    this.name = "AgentServiceUnavailableError";
    this.code = "AGENT_SERVICE_UNAVAILABLE";
    this.agentName = agentName;
    this.mode = mode;
    this.cause = cause;
  }
}

export class AgentResourceExhaustedError extends Error {
  code: string;
  agentName: string;
  mode?: string;
  cause?: unknown;

  constructor(agentName: string, reason: string, mode?: string, cause?: unknown) {
    super(`${agentName} 模型额度或资源不足：${reason}`);
    this.name = "AgentResourceExhaustedError";
    this.code = "AGENT_RESOURCE_EXHAUSTED";
    this.agentName = agentName;
    this.mode = mode;
    this.cause = cause;
  }
}

/**
 * BaseAgent: 拟人化智能体基类
 */
export class BaseAgent {
  protected tools: DynamicStructuredTool[] = [];
  protected models: Map<string, BaseChatModel>;

  constructor(
    public persona: AgentPersona,
    skills: Skill<any>[],
    models?: Map<string, BaseChatModel> | BaseChatModel
  ) {
    this.tools = skills.map((skill) => skill.toTool());
    if (models instanceof Map) {
      this.models = models;
    } else {
      const m = models || ModelManager.createModelForAgent("pm");
      this.models = new Map([["default", m]]);
    }
  }

  /**
   * 根据 mode 选择模型，找不到则 fallback 到 default
   */
  private selectModel(mode?: string): BaseChatModel {
    if (mode && this.models.has(mode)) {
      return this.models.get(mode)!;
    }
    return this.models.get("default")!;
  }

  private buildFallbackChain(mode?: string): string[] {
    const preferred = mode && this.models.has(mode) ? mode : "default";
    const ordered = [preferred];

    if (preferred !== "default" && this.models.has("default")) {
      ordered.push("default");
    }
    if (!ordered.includes("coding") && this.models.has("coding")) {
      ordered.push("coding");
    }
    if (!ordered.includes("reasoning") && this.models.has("reasoning")) {
      ordered.push("reasoning");
    }

    for (const key of this.models.keys()) {
      if (!ordered.includes(key)) {
        ordered.push(key);
      }
    }

    return ordered;
  }

  private async invokeWithRetry(
    model: any,
    messages: BaseMessage[],
    workspaceDir?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const timeoutMs = options?.timeoutMs;
      const upstreamSignal = options?.signal;
      const controller = new AbortController();
      let timeoutHandle: NodeJS.Timeout | null = null;
      let didTimeout = false;
      const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);

      if (upstreamSignal) {
        if (upstreamSignal.aborted) {
          controller.abort(upstreamSignal.reason);
        } else {
          upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
        }
      }

      if (timeoutMs && timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          didTimeout = true;
          controller.abort(new AgentTimeoutError(this.persona.name, timeoutMs));
        }, timeoutMs);
      }

      try {
        return await model.invoke(messages, { signal: controller.signal } as any);
      } catch (error: any) {
        if (didTimeout) {
          throw new AgentTimeoutError(this.persona.name, timeoutMs!);
        }
        if (attempt < 2 && isRetryableError(error)) {
          const delay = 1000 * Math.pow(2, attempt);
          console.warn(`[Agent] ${this.persona.name} 第 ${attempt + 1} 次调用失败，${delay}ms 后重试...`);
          await sleep(delay);
          continue;
        }
        throw error;
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (upstreamSignal) {
          upstreamSignal.removeEventListener("abort", abortFromUpstream);
        }
      }
    }
  }

  private async invokeWithFallback(
    messages: BaseMessage[],
    mode: string | undefined,
    workspaceDir?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ) {
    const chain = this.buildFallbackChain(mode);
    let lastError: any;

    for (let idx = 0; idx < chain.length; idx++) {
      const candidateMode = chain[idx];
      const selectedModel = this.selectModel(candidateMode);
      const shouldBindTools = this.tools.length > 0 && candidateMode !== "reasoning";
      const modelWithTools = shouldBindTools
        ? (selectedModel as any).bindTools(this.tools)
        : selectedModel;

      try {
        const response = await this.invokeWithRetry(modelWithTools, messages, workspaceDir, options);
        return { response, usedMode: candidateMode };
      } catch (error: any) {
        lastError = error;
        const hasMoreCandidates = idx < chain.length - 1;
        if (!hasMoreCandidates && isResourceExhaustedError(error)) {
          const wrapped = new AgentResourceExhaustedError(
            this.persona.name,
            formatErrorMessage(error),
            candidateMode,
            error
          );
          console.error(`\n[Critical Error in Agent ${this.persona.name}]:`);
          console.error("Error Detail:", wrapped);
          await AuditLogger.log(
            workspaceDir,
            this.persona.name,
            `### [Agent Resource Exhausted]\n\n${wrapped.message}\n\n最后尝试模式：${candidateMode}`
          );
          throw wrapped;
        }
        if (!hasMoreCandidates && isRetryableError(error)) {
          const wrapped = new AgentServiceUnavailableError(
            this.persona.name,
            formatErrorMessage(error),
            candidateMode,
            error
          );
          console.error(`\n[Critical Error in Agent ${this.persona.name}]:`);
          console.error("Error Detail:", wrapped);
          await AuditLogger.log(
            workspaceDir,
            this.persona.name,
            `### [Agent Unavailable]\n\n${wrapped.message}\n\n最后尝试模式：${candidateMode}`
          );
          throw wrapped;
        }
        if (!hasMoreCandidates || (!isRetryableError(error) && !isResourceExhaustedError(error))) {
          console.error(`\n[Critical Error in Agent ${this.persona.name}]:`);
          if (error.response?.data) {
            console.error("Raw API Response Data:", JSON.stringify(error.response.data, null, 2));
            await AuditLogger.log(workspaceDir, this.persona.name, `### [Critical Error]\n\nRaw API Response Data:\n\`\`\`json\n${JSON.stringify(error.response.data, null, 2)}\n\`\`\``);
          } else {
            console.error("Error Detail:", error);
            await AuditLogger.log(workspaceDir, this.persona.name, `### [Critical Error]\n\nError Detail:\n${formatErrorMessage(error)}`);
          }
          throw error;
        }
        const nextMode = chain[idx + 1];
        const fallbackMessage = `模型 ${candidateMode} 调用失败（${formatErrorMessage(error)}），切换到 ${nextMode} 继续。`;
        console.warn(`[Agent] ${this.persona.name} ${fallbackMessage}`);
        await AuditLogger.log(workspaceDir, this.persona.name, `### [Model Fallback]\n\n${fallbackMessage}`);
      }
    }

    throw lastError;
  }

  /**
   * 生成 System Prompt，可选注入团队共识 (projectBrief) 和工作空间路径
   */
  protected getSystemPrompt(brief?: string[], workspaceDir?: string): string {
    const memory = ModelManager.getLongTermMemory();
    const briefSection = brief && brief.length > 0
      ? `\n--- 团队共识（本次项目的约束与决策，优先级高于个人判断）---\n${brief.map(e => `• ${e}`).join("\n")}\n-------------------------------------------`
      : "";
    const workspaceSection = workspaceDir
      ? `\n--- 当前工作空间 ---\n路径：${workspaceDir}\n重要：所有 shell 命令对项目文件的操作（find、cat、ls 等）必须限定在此目录内，禁止在此路径之外搜索项目源代码。\n-------------------------------------------`
      : "";
    return `
--- 最高优先级语言指令 ---
所有回复、思考过程、日志消息、团队沟通必须使用中文（简体）。代码标识符、变量名、函数名、技术术语保持英文，遵循工程惯例。此指令优先于任何其他设定。
--------------------------

You are ${this.persona.name}, a ${this.persona.role} in a world-class AI software team.
Your specialty is: ${this.persona.specialty}.
Your personality: ${this.persona.personality}.
${briefSection}${workspaceSection}
--- LANGUAGE SETTING ---
IMPORTANT: You MUST communicate exclusively in Chinese (中文). All thoughts, logs, and team chat messages must be in Chinese. However, code comments and technical identifiers should follow standard engineering practices (usually English).

--- DEVELOPMENT STANDARDS (开发规范) ---
1. CLEAN CODE: 遵循整洁代码原则，变量命名语义化，函数单一职责。
2. TYPE SAFETY: TypeScript 代码必须使用严格类型，使用 'lsp_diagnose' 获取实时反馈，严禁忽略 ERROR。
3. ERROR HANDLING: 必须包含健壮的错误处理逻辑，提供有意义的错误信息。
4. DOCUMENTATION: 核心逻辑和公共 API 必须包含 JSDoc 注释。
5. TESTING: 编写功能代码的同时，应考虑其可测试性。
6. LINTING: 提交代码前，必须确保符合项目的规范，并使用 'lint_fix' 自动修复。
--- ENGINEERING GUIDELINES ---
1. ACCURACY: Code must be syntactically correct and follow the provided spec exactly.
2. CONTEXT: Always consider the existing files and state before generating new content.
3. LOGIC: Ensure your thoughts are coherent. Do not contradict previous decisions unless explicitly correcting an error.
4. FORMAT: When asked for JSON, provide ONLY valid JSON. When asked for code, ensure it's clean and well-documented.

--- LONG-TERM MEMORY (PAST LESSONS) ---
${memory}
-----------------------------------------

Always stay in character. You are persistent, professional, and obsessed with quality.
If you find a contradiction in the requirements or spec, speak up in the team chat.
`.trim();
  }

  /**
   * 鲁棒的聊天接口（支持工具调用循环）
   * @param options.mode         选择使用哪个能力模型（coding/reasoning/default）
   * @param options.brief        团队共识条目，注入 system prompt 让所有 agent 共享上下文
   * @param options.workspaceDir 当前运行的 workspace 路径，注入 system prompt 防止 agent 在错误目录操作
   * @param options.timeoutMs    单次模型调用超时时间，超时后主动中断请求
   * @param options.signal       外部中断信号，可用于提前取消当前模型调用
   */
  async chat(messages: any[], eventCallback?: (event: any) => void, options?: {
    mode?: string;
    brief?: string[];
    workspaceDir?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) {
    const systemPrompt = this.getSystemPrompt(options?.brief, options?.workspaceDir);
    const formattedMessages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
      ...messages.map(m => m.role === 'user' ? new HumanMessage(m.content) : m)
    ];

    // 审计记录：输入 Prompt
    await AuditLogger.log(options?.workspaceDir, this.persona.name, `### [Input Prompt]\n\n**System Prompt:**\n${systemPrompt}\n\n**User Messages:**\n${messages[messages.length - 1]?.content || "(Initial)"}`);

    if (eventCallback) {
      eventCallback({
        type: "llm_call_start",
        sender: this.persona.name,
        role: this.persona.role,
        prompt: messages[messages.length - 1]?.content || "(Initial)",
        system: systemPrompt,
      });
    }

    let response: any;
    let currentMessages = [...formattedMessages];
    const MAX_TOOL_ITERATIONS = 10;
    let activeMode = options?.mode;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const invoked = await this.invokeWithFallback(currentMessages, activeMode, options?.workspaceDir, {
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
      });
      response = invoked.response;
      activeMode = invoked.usedMode;

      const toolCalls = response.tool_calls ?? [];
      
      // 审计记录：模型输出内容
      if (response.content) {
        await AuditLogger.log(options?.workspaceDir, this.persona.name, `### [Response Content]\n\n${response.content}`);
        if (eventCallback) {
          eventCallback({
            type: "llm_content",
            sender: this.persona.name,
            role: this.persona.role,
            content: response.content,
          });
        }
      }

      const tokenUsage = extractTokenUsage(response);
      if (tokenUsage) {
        await AuditLogger.recordTokenUsage(options?.workspaceDir, {
          timestamp: getBeijingTime(),
          agent: this.persona.name,
          mode: activeMode || "default",
          model: tokenUsage.model,
          calls: 1,
          inputTokens: tokenUsage.inputTokens,
          outputTokens: tokenUsage.outputTokens,
          totalTokens: tokenUsage.totalTokens,
        });
      }

      if (toolCalls.length === 0) break;

      currentMessages.push(response as AIMessage);

      for (const toolCall of toolCalls) {
        const tool = this.tools.find(t => t.name === toolCall.name);
        let result: string;
        
        // 解析 args：LangChain 传过来的 args 可能是被冻结的对象，也可能是一个 JSON 字符串
        let toolArgs: any = {};
        if (typeof toolCall.args === "string") {
          try {
            toolArgs = JSON.parse(toolCall.args);
          } catch (e) {
            toolArgs = toolCall.args;
          }
        } else {
          toolArgs = JSON.parse(JSON.stringify(toolCall.args || {}));
        }
        
        // 关键逻辑：自动补全文件路径，防止 Agent 在根目录乱搞
        if (options?.workspaceDir && typeof toolArgs === "object") {
          if (typeof toolArgs.file_path === "string" && !path.isAbsolute(toolArgs.file_path)) {
            toolArgs.file_path = path.join(options.workspaceDir, toolArgs.file_path);
          }
          if (typeof toolArgs.path === "string" && !path.isAbsolute(toolArgs.path)) {
            toolArgs.path = path.join(options.workspaceDir, toolArgs.path);
          }
        }

        // 审计记录：工具调用请求
        await AuditLogger.log(options?.workspaceDir, this.persona.name, `### [Tool Call: ${toolCall.name}]\n\n**Args:**\n\`\`\`json\n${JSON.stringify(toolArgs, null, 2)}\n\`\`\``);

        if (tool) {
          try {
            // 将修改后的参数传给工具（LangChain 的 invoke 支持对象格式输入）
            result = await tool.invoke(toolArgs);
          } catch (e: any) {
            result = `Error: ${e.message}`;
          }
        } else {
          result = `Unknown tool: ${toolCall.name}`;
        }

        console.log(`[Agent:${this.persona.name}] 工具调用: ${toolCall.name}(${JSON.stringify(toolArgs)}) → ${String(result).slice(0, 300)}`);

        // 审计记录：工具调用结果
        await AuditLogger.log(options?.workspaceDir, this.persona.name, `### [Tool Result: ${toolCall.name}]\n\n**Output:**\n${String(result)}`);

        if (eventCallback) {
          eventCallback({
            type: "tool_use",
            sender: this.persona.name,
            content: String(result),
            tool: toolCall.name
          });
        }

        currentMessages.push(new ToolMessage({
          content: String(result),
          tool_call_id: toolCall.id ?? toolCall.name,
        }));
      }
    }

    if (eventCallback) {
      eventCallback({
        type: "llm_call_end",
        sender: this.persona.name,
        role: this.persona.role,
        response: response.content,
      });
    }

    return response;
  }

  getModel(): BaseChatModel {
    return this.models.get("default")!;
  }

  getModels(): Map<string, BaseChatModel> {
    return this.models;
  }

  getTools() {
    return this.tools;
  }

  getPersona() {
    return this.persona;
  }
}
