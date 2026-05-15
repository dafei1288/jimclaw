import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

type ModelConfig = {
  provider: string;
  modelName: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
};

type JimClawConfig = {
  llm_configs: Record<string, ModelConfig>;
  agents: Record<string, string | Record<string, string>>;
};

function resolveValue(val?: string): string | undefined {
  if (!val) return undefined;
  if (val.startsWith("process.env.")) {
    return process.env[val.replace("process.env.", "")];
  }
  return val;
}

function loadConfig(): JimClawConfig {
  const configPath = path.resolve(process.cwd(), "jimclaw.config.json");
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function formatError(error: any): string {
  const payload = {
    name: error?.name,
    message: error?.message,
    code: error?.code,
    errno: error?.errno,
    syscall: error?.syscall,
    address: error?.address,
    port: error?.port,
    stack: error?.stack,
    cause: error?.cause
      ? {
          name: error.cause?.name,
          message: error.cause?.message,
          code: error.cause?.code,
          errno: error.cause?.errno,
          syscall: error.cause?.syscall,
          address: error.cause?.address,
          port: error.cause?.port,
          stack: error.cause?.stack,
        }
      : undefined,
  };
  return JSON.stringify(payload, null, 2);
}

function getAgentConfig(config: JimClawConfig, agentName: string, mode = "default") {
  const agent = config.agents[agentName];
  if (!agent) {
    throw new Error(`未找到 agent 配置: ${agentName}`);
  }

  const configId = typeof agent === "string" ? agent : agent[mode] || agent.default;
  if (!configId) {
    throw new Error(`agent ${agentName} 未配置 mode=${mode}`);
  }

  const llmConfig = config.llm_configs[configId];
  if (!llmConfig) {
    throw new Error(`未找到 llm_configs.${configId}`);
  }

  return {
    configId,
    provider: llmConfig.provider,
    modelName: llmConfig.modelName,
    baseUrl: resolveValue(llmConfig.baseUrl),
    apiKey: resolveValue(llmConfig.apiKey),
    temperature: llmConfig.temperature ?? 0,
  };
}

async function main() {
  const agentName = process.argv[2] || "pm";
  const mode = process.argv[3] || "default";
  const config = loadConfig();
  const resolved = getAgentConfig(config, agentName, mode);

  console.log("=== Agent Probe ===");
  console.log(JSON.stringify({
    agentName,
    mode,
    configId: resolved.configId,
    provider: resolved.provider,
    modelName: resolved.modelName,
    baseUrl: resolved.baseUrl,
    hasApiKey: Boolean(resolved.apiKey),
    apiKeyPrefix: resolved.apiKey ? resolved.apiKey.slice(0, 8) : "",
  }, null, 2));

  if (!resolved.baseUrl) {
    throw new Error("baseUrl 为空，无法探测");
  }
  if (!resolved.apiKey) {
    throw new Error("apiKey 为空，无法探测");
  }

  const normalizedBaseUrl = resolved.baseUrl.endsWith("/")
    ? resolved.baseUrl.slice(0, -1)
    : resolved.baseUrl;

  const modelsUrl = `${normalizedBaseUrl}/models`;
  const chatUrl = `${normalizedBaseUrl}/chat/completions`;

  console.log("\n=== Probe 1: GET /models ===");
  try {
    const response = await fetch(modelsUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${resolved.apiKey}`,
      },
    });
    const text = await response.text();
    console.log(`status=${response.status}`);
    console.log(text.slice(0, 2000));
  } catch (error: any) {
    console.log("GET /models failed:");
    console.log(formatError(error));
  }

  console.log("\n=== Probe 2: POST /chat/completions ===");
  try {
    const response = await fetch(chatUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify({
        model: resolved.modelName,
        temperature: resolved.temperature,
        messages: [
          { role: "system", content: "你是一个连通性探针，只返回 ok。" },
          { role: "user", content: "返回 ok" },
        ],
        max_tokens: 16,
      }),
    });
    const text = await response.text();
    console.log(`status=${response.status}`);
    console.log(text.slice(0, 4000));
  } catch (error: any) {
    console.log("POST /chat/completions failed:");
    console.log(formatError(error));
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
