import { ChatAnthropic } from "@langchain/anthropic";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { Skill } from "./skill";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ModelManager } from "../utils/models";
import { SystemMessage, HumanMessage, AIMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";
import * as fs from "fs/promises";
import * as path from "path";
import { AuditLogger } from "../utils/audit";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function isRetryableError(err: any): boolean {
  const status = err.status || err.response?.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  const code = err.code || err.cause?.code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND") return true;
  const message = (err.message || "").toLowerCase();
  if (message.includes("timeout") || message.includes("econnreset") || message.includes("network error")) return true;
  return false;
}

export interface AgentPersona {
  name: string;
  role: string;
  specialty: string;
  personality: string;
  color?: string; // 终端显示的颜色（支持 chalk 颜色名称）
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
   */
  async chat(messages: any[], eventCallback?: (event: any) => void, options?: { mode?: string; brief?: string[]; workspaceDir?: string }) {
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

    // 按 mode 选模型，绑定工具（如果有）
    // reasoning 模式不绑工具：DeepSeek Reasoner 多轮对话需要 reasoning_content 字段，
    // LangChain 序列化时会丢失该字段导致 400 错误；且推理节点只需分析不需工具调用
    const selectedModel = this.selectModel(options?.mode);
    const shouldBindTools = this.tools.length > 0 && options?.mode !== "reasoning";
    const modelWithTools = shouldBindTools
      ? (selectedModel as any).bindTools(this.tools)
      : selectedModel;

    let response: any;
    let currentMessages = [...formattedMessages];
    const MAX_TOOL_ITERATIONS = 10;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      // 带指数退避的调用重试（最多 3 次）
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await modelWithTools.invoke(currentMessages);
          break;
        } catch (error: any) {
          if (attempt < 2 && isRetryableError(error)) {
            const delay = 1000 * Math.pow(2, attempt);
            console.warn(`[Agent] ${this.persona.name} 第 ${attempt + 1} 次调用失败，${delay}ms 后重试...`);
            await sleep(delay);
            continue;
          }
          console.error(`\n[Critical Error in Agent ${this.persona.name}]:`);
          if (error.response?.data) {
            console.error("Raw API Response Data:", JSON.stringify(error.response.data, null, 2));
            await AuditLogger.log(options?.workspaceDir, this.persona.name, `### [Critical Error]\n\nRaw API Response Data:\n\`\`\`json\n${JSON.stringify(error.response.data, null, 2)}\n\`\`\``);
          } else {
            console.error("Error Detail:", error);
            await AuditLogger.log(options?.workspaceDir, this.persona.name, `### [Critical Error]\n\nError Detail:\n${error.message || error}`);
          }
          throw error;
        }
      }

      const toolCalls = response.tool_calls ?? [];
      
      // 审计记录：模型输出内容
      if (response.content) {
        await AuditLogger.log(options?.workspaceDir, this.persona.name, `### [Response Content]\n\n${response.content}`);
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
