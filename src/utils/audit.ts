import * as fs from "fs/promises";
import * as path from "path";
import { TokenUsageEntry, TokenUsageStats, TokenUsageSummary } from "../core/graph_types";

type PersistedTokenUsage = {
  summary: TokenUsageSummary;
  entries: TokenUsageEntry[];
};

type StructuredAuditEvent = {
  type: string;
  sender: string;
  content: string;
  timestamp: string;
  metadata?: any;
};

function createEmptyTokenStats(): TokenUsageStats {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    totalCost: 0,
  };
}

function createEmptyTokenUsage(): PersistedTokenUsage {
  return {
    summary: {
      ...createEmptyTokenStats(),
      byAgent: {},
    },
    entries: [],
  };
}

function addTokenStats(target: TokenUsageStats, source: TokenUsageStats) {
  target.calls += source.calls || 0;
  target.inputTokens += source.inputTokens || 0;
  target.outputTokens += source.outputTokens || 0;
  target.totalTokens += source.totalTokens || 0;
  target.inputCost = (target.inputCost || 0) + (source.inputCost || 0);
  target.outputCost = (target.outputCost || 0) + (source.outputCost || 0);
  target.totalCost = (target.totalCost || 0) + (source.totalCost || 0);
}

// ── 费用计算 ──────────────────────────────────────────────────────────
// 价格单位：USD / 百万 tokens
// 来源：各 provider 官方定价页 + 中转站折扣价
interface ModelPricing { input: number; output: number; }

const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI 官方
  "gpt-5.4":        { input: 2.00,  output: 8.00 },   // 假定与 gpt-4.1 同价（中转站定价）
  "gpt-5":          { input: 2.00,  output: 8.00 },
  "gpt-4o":         { input: 2.50,  output: 10.00 },
  "gpt-4o-mini":    { input: 0.15,  output: 0.60 },
  "gpt-4.1":        { input: 2.00,  output: 8.00 },
  "gpt-4.1-mini":   { input: 0.40,  output: 1.60 },
  "gpt-4.1-nano":   { input: 0.10,  output: 0.40 },
  "gpt-4-turbo":    { input: 10.00, output: 30.00 },
  "gpt-4":          { input: 30.00, output: 60.00 },
  "o3":             { input: 10.00, output: 40.00 },
  "o4-mini":        { input: 1.50,  output: 6.00 },
  // Anthropic
  "claude-sonnet-4":       { input: 3.00,  output: 15.00 },
  "claude-sonnet-4-20250514": { input: 3.00, output: 15.00 },
  "claude-opus-4-6":       { input: 15.00, output: 75.00 },
  "claude-3.5-sonnet":     { input: 3.00,  output: 15.00 },
  // MiniMax（Anthropic 兼容 API）
  "minimax-m2.5":   { input: 1.00,  output: 4.00 },
  // 智谱 GLM
  "glm-5.1":        { input: 2.00,  output: 8.00 },
  "glm-5":          { input: 2.00,  output: 8.00 },
  "glm-4.7":        { input: 0.50,  output: 0.50 },
  "glm-4":          { input: 0.10,  output: 0.10 },
  // DeepSeek
  "deepseek-reasoner": { input: 4.00, output: 16.00 },
  "deepseek-chat":     { input: 0.27, output: 1.10 },
  // Google
  "gemini-2.5-pro":  { input: 1.25, output: 10.00 },
  "gemini-2.5-flash": { input: 0.15, output: 0.60 },
};

/**
 * 模糊匹配 model 名称到定价表
 * 例：gpt-4o-2024-05-13 → gpt-4o, claude-opus-4-6-20250424 → claude-opus-4-6
 */
function findPricing(modelName?: string): ModelPricing | null {
  if (!modelName) return null;
  const lower = modelName.toLowerCase().trim();

  // 精确匹配
  if (MODEL_PRICING[lower]) return MODEL_PRICING[lower];

  // 前缀匹配（去掉日期后缀 -2024-05-13 等）
  for (const key of Object.keys(MODEL_PRICING)) {
    if (lower.startsWith(key)) return MODEL_PRICING[key];
  }

  return null;
}

/**
 * 根据 model + token 数量计算 USD 费用
 */
export function calculateCost(model: string | undefined, inputTokens: number, outputTokens: number): {
  inputCost: number; outputCost: number; totalCost: number; matched: boolean;
} {
  const pricing = findPricing(model);
  if (!pricing) {
    return { inputCost: 0, outputCost: 0, totalCost: 0, matched: false };
  }
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return { inputCost, outputCost, totalCost: inputCost + outputCost, matched: true };
}

/**
 * 格式化 USD 费用显示
 */
export function formatCost(cost: number | undefined): string {
  if (!cost || cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * 审计日志工具：将系统的所有行为持久化到文件
 */
export class AuditLogger {
  static async log(workspaceDir: string | undefined, senderName: string, content: string) {
    if (!workspaceDir) return;
    try {
      const auditDir = path.join(workspaceDir, "audit");
      await fs.mkdir(auditDir, { recursive: true });
      const logFile = path.join(auditDir, `${senderName}.md`);
      const timestamp = new Date().toLocaleString('zh-CN');
      await fs.appendFile(logFile, `\n\n--- [${timestamp}] ---\n${content}\n`);
    } catch (e) {
      console.error(`[AuditLogger] 写入失败: ${e}`);
    }
  }

  static async recordTokenUsage(workspaceDir: string | undefined, entry: TokenUsageEntry) {
    if (!workspaceDir) return;
    try {
      const usagePath = path.join(workspaceDir, "token-usage.json");
      let persisted = createEmptyTokenUsage();
      try {
        const raw = await fs.readFile(usagePath, "utf-8");
        persisted = JSON.parse(raw) as PersistedTokenUsage;
      } catch {}

      // ── 费用计算 ──
      const cost = calculateCost(entry.model, entry.inputTokens, entry.outputTokens);
      const enrichedEntry: TokenUsageEntry = {
        ...entry,
        inputCost: cost.inputCost,
        outputCost: cost.outputCost,
        totalCost: cost.totalCost,
      };

      persisted.entries.push(enrichedEntry);
      addTokenStats(persisted.summary, enrichedEntry);
      const agentStats = persisted.summary.byAgent[entry.agent] || createEmptyTokenStats();
      addTokenStats(agentStats, enrichedEntry);
      persisted.summary.byAgent[entry.agent] = agentStats;

      await fs.writeFile(usagePath, JSON.stringify(persisted, null, 2), "utf-8");
    } catch (e) {
      console.error(`[AuditLogger] token 用量写入失败: ${e}`);
    }
  }

  static async recordStructuredEvent(workspaceDir: string | undefined, event: StructuredAuditEvent) {
    if (!workspaceDir) return;
    try {
      const auditDir = path.join(workspaceDir, "audit");
      await fs.mkdir(auditDir, { recursive: true });
      const eventFile = path.join(auditDir, "events.jsonl");
      await fs.appendFile(eventFile, `${JSON.stringify(event)}\n`, "utf-8");
    } catch (e) {
      console.error(`[AuditLogger] 结构化事件写入失败: ${e}`);
    }
  }

  static async loadStructuredEvents(workspaceDir: string | undefined): Promise<StructuredAuditEvent[]> {
    if (!workspaceDir) return [];
    try {
      const raw = await fs.readFile(path.join(workspaceDir, "audit", "events.jsonl"), "utf-8");
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as StructuredAuditEvent);
    } catch {
      return [];
    }
  }

  static async loadTokenUsageSummary(workspaceDir: string | undefined): Promise<TokenUsageSummary> {
    if (!workspaceDir) {
      return { ...createEmptyTokenStats(), byAgent: {} };
    }
    try {
      const raw = await fs.readFile(path.join(workspaceDir, "token-usage.json"), "utf-8");
      const parsed = JSON.parse(raw) as PersistedTokenUsage;
      return parsed.summary || { ...createEmptyTokenStats(), byAgent: {} };
    } catch {
      return { ...createEmptyTokenStats(), byAgent: {} };
    }
  }
}
