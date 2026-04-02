import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { ChatOllama } from "@langchain/ollama";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

export interface ModelConfig {
  provider: "openai" | "anthropic" | "ollama" | "deepseek";
  modelName: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
}

/**
 * JimClaw 全局配置结构
 */
export interface JimClawConfig {
  llm_configs: Record<string, ModelConfig>;
  // 向下兼容：string 格式等价于 { "default": configId }
  agents: Record<string, string | Record<string, string>>;
  global?: {
    maxRetries?: number;
    workspaceDir?: string;
    enableEvolution?: boolean;
    coderMaxParallel?: number;
    coderExperimentalModelParallel?: boolean;
  };
}

/**
 * 模型工厂：基于映射逻辑
 */
export class ModelManager {
  private static config: JimClawConfig;

  private static attachImplicitFallbacks(
    models: Map<string, BaseChatModel>,
    agentName: string,
    currentConfigIds: Set<string>
  ) {
    const addIfAvailable = (mode: string, configId: string) => {
      if (models.has(mode) || currentConfigIds.has(configId)) return;
      const modelConfig = this.config.llm_configs[configId];
      if (!modelConfig) return;
      models.set(mode, this.createModel(modelConfig));
      currentConfigIds.add(configId);
    };

    // 单模型或缺省配置的 agent 也应具备至少一个跨供应商兜底，避免单点额度耗尽直接终止。
    addIfAvailable("reasoning", "deepseek_reasoning");

    // coder / qa 之外的角色不需要专门 coding mode；其余角色保留一个轻量 openai 兜底即可。
    if (agentName !== "coder" && agentName !== "qa") {
      addIfAvailable("coding", "openai_fast");
    }
  }

  /**
   * 加载配置文件
   */
  static loadConfig() {
    const configPath = path.resolve(process.cwd(), "jimclaw.config.json");
    if (!fs.existsSync(configPath)) {
      throw new Error("jimclaw.config.json not found!");
    }
    this.config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }

  /**
   * 获取全局配置
   */
  static getGlobalConfig() {
    if (!this.config) this.loadConfig();
    return this.config.global;
  }

  /**
   * 获取长期记忆 (KNOWLEDGE.md)
   */
  static getLongTermMemory(): string {
    const knowledgePath = path.resolve(process.cwd(), "KNOWLEDGE.md");
    if (!fs.existsSync(knowledgePath)) {
      return "No previous knowledge recorded.";
    }
    try {
      const content = fs.readFileSync(knowledgePath, "utf-8");
      // 只取最近的 2000 个字符
      return content.slice(-2000);
    } catch (e) {
      return "Error reading knowledge base.";
    }
  }

  /**
   * 为特定 Agent 创建多模型 Map（mode → model）
   * - string 格式: Map { "default" → model }
   * - object 格式: 按 key 逐一建模型实例
   */
  static createModelSetForAgent(agentName: string): Map<string, BaseChatModel> {
    if (!this.config) this.loadConfig();

    const agentConfig = this.config.agents[agentName];
    if (!agentConfig) {
      throw new Error(`No model mapping found for agent: ${agentName}`);
    }

    const models = new Map<string, BaseChatModel>();
    const currentConfigIds = new Set<string>();

    if (typeof agentConfig === "string") {
      // 向下兼容：string 格式 → Map { "default" → model }
      const modelConfig = this.config.llm_configs[agentConfig];
      if (!modelConfig) throw new Error(`LLM config '${agentConfig}' not found`);
      models.set("default", this.createModel(modelConfig));
      currentConfigIds.add(agentConfig);
    } else {
      // object 格式：{ mode → configId }
      for (const [mode, configId] of Object.entries(agentConfig)) {
        const modelConfig = this.config.llm_configs[configId];
        if (!modelConfig) throw new Error(`LLM config '${configId}' not found for agent '${agentName}' mode '${mode}'`);
        models.set(mode, this.createModel(modelConfig));
        currentConfigIds.add(configId);
      }
      if (!models.has("default")) {
        throw new Error(`Agent '${agentName}' config must include a "default" mode`);
      }
    }

    this.attachImplicitFallbacks(models, agentName, currentConfigIds);

    return models;
  }

  /**
   * 为特定 Agent 创建模型（兼容旧接口，返回 default 模型）
   */
  static createModelForAgent(agentName: string): BaseChatModel {
    if (!this.config) this.loadConfig();

    const configId = this.config.agents[agentName];
    if (!configId) {
      throw new Error(`No model mapping found for agent: ${agentName}`);
    }

    const modelConfig = this.config.llm_configs[typeof configId === "string" ? configId : (configId as any).default];
    if (!modelConfig) {
      throw new Error(`LLM configuration not found!`);
    }

    return this.createModel(modelConfig);
  }

  private static resolveValue(val?: string): string | undefined {
    if (!val) return undefined;
    if (val.startsWith("process.env.")) {
      const envVar = val.replace("process.env.", "");
      return process.env[envVar];
    }
    return val;
  }

  private static createModel(config: ModelConfig): BaseChatModel {
    const { provider, modelName, temperature = 0.7 } = config;
    const baseUrl = this.resolveValue(config.baseUrl);
    const apiKey = this.resolveValue(config.apiKey);

    switch (provider) {
      case "anthropic":
        return new ChatAnthropic({
          modelName,
          anthropicApiKey: apiKey,
          clientOptions: baseUrl ? { baseURL: baseUrl } : undefined,
          temperature,
        });

      case "openai":
        // 关键点：对于某些代理，如果不确定是否支持 max_tokens，可以先不设或设为 undefined
        // 同时确保 baseUrl 格式正确
        const openAIConfig: any = {
          modelName,
          apiKey,
          temperature,
          maxTokens: 4096, // 尝试保留，如果仍报错将移除
        };

        if (baseUrl) {
          openAIConfig.configuration = { baseURL: baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/` };
        }

        return new ChatOpenAI(openAIConfig);

      case "ollama":
        return new ChatOllama({
          model: modelName,
          baseUrl: baseUrl || "http://localhost:11434",
          temperature,
        });

      case "deepseek":
        return new ChatOpenAI({
          modelName,
          apiKey: apiKey,
          configuration: { baseURL: baseUrl || "https://api.deepseek.com/v1" },
          temperature,
        });

      default:
        throw new Error(`Unsupported model provider: ${provider}`);
    }
  }
}
