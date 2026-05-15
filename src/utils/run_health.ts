import * as fs from "fs/promises";
import * as path from "path";

type AnyObject = Record<string, any>;

export interface RunHealthSummary {
  runName: string;
  traceId: string;
  lastNode: string;
  retryCount: number;
  status: "success" | "failed" | "pending";
  agentPendingCount: number;
  qaTimeoutCount: number;
  staticFallbackIssueCount: number;
  openIssueCount: number;
  lastFailureNode: string;
  lastFailureSummary: string;
}

async function readJsonIfExists(filePath: string): Promise<AnyObject | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function countAgentPending(traceIndex: AnyObject | null): number {
  const timeline = Array.isArray(traceIndex?.timeline) ? traceIndex.timeline : [];
  return timeline.filter((item: any) => String(item?.node || "") === "agent_pending").length;
}

function countQaTimeout(traceIndex: AnyObject | null): number {
  const notes = Array.isArray(traceIndex?.meetingNotes) ? traceIndex.meetingNotes : [];
  return notes.filter((note: any) => {
    const phase = String(note?.phase || "");
    const summary = String(note?.summary || "");
    return phase === "qa" && /超时|AgentTimeoutError|调用超时/i.test(summary);
  }).length;
}

function countStaticFallbackIssues(boulder: AnyObject | null): number {
  const issues = Array.isArray(boulder?.state?.issueTracker) ? boulder.state.issueTracker : [];
  return issues.filter((issue: any) =>
    /^(BUG-COMPILE-|BUG-AUTO-|BUG-VERIFIER-|BUG-DEPLOY-|BUG-QA-FALLBACK-)/.test(String(issue?.id || ""))
  ).length;
}

function resolveRunStatus(boulder: AnyObject | null): "success" | "failed" | "pending" {
  const state = boulder?.state || {};
  if (state?.isDone === true && !state?.lastFailedNode && state?.deploymentStatus?.status !== "failed") return "success";
  if (state?.lastFailedNode || state?.deploymentStatus?.status === "failed") return "failed";
  return "pending";
}

export function summarizeRunHealth(runName: string, boulder: AnyObject | null, traceIndex: AnyObject | null): RunHealthSummary {
  return {
    runName,
    traceId: String(traceIndex?.traceId || boulder?.traceId || ""),
    lastNode: String(traceIndex?.lastNode || boulder?.node || ""),
    retryCount: Number(traceIndex?.retryCount || boulder?.state?.retryCount || 0),
    status: resolveRunStatus(boulder),
    agentPendingCount: countAgentPending(traceIndex),
    qaTimeoutCount: countQaTimeout(traceIndex),
    staticFallbackIssueCount: countStaticFallbackIssues(boulder),
    openIssueCount: (Array.isArray(boulder?.state?.issueTracker) ? boulder.state.issueTracker : [])
      .filter((item: any) => item?.status === "open").length,
    lastFailureNode: String(boulder?.state?.lastFailedNode || traceIndex?.lastFailure?.node || ""),
    lastFailureSummary: String(boulder?.state?.lastFailureSummary || traceIndex?.lastFailure?.summary || ""),
  };
}

export async function buildRunHealthSummary(runDir: string): Promise<RunHealthSummary | null> {
  const boulder = await readJsonIfExists(path.join(runDir, "boulder.json"));
  const traceIndex = await readJsonIfExists(path.join(runDir, "trace-index.json"));
  if (!boulder && !traceIndex) return null;
  return summarizeRunHealth(path.basename(runDir), boulder, traceIndex);
}

export async function listRunHealth(workspaceDir: string, limit = 10): Promise<RunHealthSummary[]> {
  const entries = await fs.readdir(workspaceDir, { withFileTypes: true });
  const runDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run_"))
    .map((entry) => path.join(workspaceDir, entry.name));
  const sorted = await Promise.all(
    runDirs.map(async (dir) => ({
      dir,
      mtime: (await fs.stat(dir)).mtimeMs,
    }))
  );
  sorted.sort((a, b) => b.mtime - a.mtime);
  const summaries: RunHealthSummary[] = [];
  for (const item of sorted.slice(0, Math.max(1, limit))) {
    const summary = await buildRunHealthSummary(item.dir);
    if (summary) summaries.push(summary);
  }
  return summaries;
}
