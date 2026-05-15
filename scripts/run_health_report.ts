import * as path from "path";
import { listRunHealth } from "../src/utils/run_health";

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value || "");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function printTable(rows: Array<Record<string, any>>) {
  if (!rows.length) {
    console.log("没有可分析的 run 数据。");
    return;
  }
  const headers = ["run", "status", "retry", "agent_pending", "qa_timeout", "static_fallback", "open_issues", "last_node", "last_failure"];
  const formatted = rows.map((row) => ({
    run: row.runName,
    status: row.status,
    retry: row.retryCount,
    agent_pending: row.agentPendingCount,
    qa_timeout: row.qaTimeoutCount,
    static_fallback: row.staticFallbackIssueCount,
    open_issues: row.openIssueCount,
    last_node: row.lastNode,
    last_failure: String(row.lastFailureSummary || "").replace(/\s+/g, " ").slice(0, 72),
  }));

  const widths = headers.map((header) =>
    Math.max(
      header.length,
      ...formatted.map((row) => String((row as any)[header] ?? "").length)
    )
  );

  const renderLine = (cells: string[]) =>
    cells.map((cell, index) => cell.padEnd(widths[index], " ")).join(" | ");

  console.log(renderLine(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("-|-"));
  for (const row of formatted) {
    console.log(renderLine(headers.map((header) => String((row as any)[header] ?? ""))));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const workspaceArg = args[0] && !args[0].startsWith("--") ? args[0] : path.join(process.cwd(), "workspace");
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex >= 0 ? toInt(args[limitIndex + 1], 8) : 8;

  const summaries = await listRunHealth(workspaceArg, limit);
  printTable(summaries);
}

main().catch((error) => {
  console.error("run 健康报告生成失败:", error?.message || error);
  process.exit(1);
});
