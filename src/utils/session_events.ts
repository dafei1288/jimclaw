import * as fs from "fs/promises";
import * as path from "path";

export interface SessionEvent {
  id: string;
  createdAt: string;
  type: string;
  node: string;
  summary: string;
  payload?: unknown;
}

export async function appendSessionEvent(
  workspace: string,
  event: Omit<SessionEvent, "id" | "createdAt">
): Promise<SessionEvent> {
  const fullEvent: SessionEvent = {
    ...event,
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
  };
  const dir = path.join(workspace, "session");
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, "events.jsonl"), `${JSON.stringify(fullEvent)}\n`, "utf-8");
  return fullEvent;
}
