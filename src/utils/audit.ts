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

      persisted.entries.push(entry);
      addTokenStats(persisted.summary, entry);
      const agentStats = persisted.summary.byAgent[entry.agent] || createEmptyTokenStats();
      addTokenStats(agentStats, entry);
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
