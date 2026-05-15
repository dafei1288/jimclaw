const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const {
  createTempWorkspace,
  removeTempWorkspace,
} = require("./test-helpers");
require("ts-node/register/transpile-only");

const { appendSessionEvent } = require("../../src/utils/session_events");

test("appendSessionEvent writes jsonl events in order", async () => {
  const workspace = await createTempWorkspace();

  try {
    const first = await appendSessionEvent(workspace, {
      type: "sprint_planned",
      node: "sprint_planner",
      summary: "拆分 Sprint",
      payload: { sprintCount: 2 },
    });
    const second = await appendSessionEvent(workspace, {
      type: "evaluation_completed",
      node: "evaluator",
      summary: "验收通过",
      payload: { sprintId: "SP-1" },
    });

    const raw = await fs.readFile(path.join(workspace, "session", "events.jsonl"), "utf-8");
    const events = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line));

    assert.equal(events.length, 2);
    assert.equal(events[0].id, first.id);
    assert.equal(events[1].id, second.id);
    assert.equal(events[0].type, "sprint_planned");
    assert.equal(events[1].type, "evaluation_completed");
    assert.equal(Boolean(events[0].createdAt), true);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
