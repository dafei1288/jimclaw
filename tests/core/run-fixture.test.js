require("ts-node/register/transpile-only");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const {
  createTempWorkspace,
  removeTempWorkspace,
  createBaseState,
} = require("./test-helpers");
const { buildTraceIndex, buildCheckpointMeta } = require("../../src/core/logic_utils");
const { buildRunFixture, writeRunFixture } = require("../../src/utils/run_fixture");
const { AuditLogger } = require("../../src/utils/audit");

test("structured audit events are persisted as jsonl", async () => {
  const workspace = await createTempWorkspace();

  try {
    await AuditLogger.recordStructuredEvent(workspace, {
      type: "phase-change",
      sender: "System",
      content: "verification",
      timestamp: "2026-03-24 16:20:00",
      metadata: { node: "qa", retryCount: 2 },
    });

    const events = await AuditLogger.loadStructuredEvents(workspace);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "phase-change");
    assert.equal(events[0].metadata.node, "qa");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("run fixture builder extracts boulder trace notes and audits", async () => {
  const workspace = await createTempWorkspace();

  try {
    const checkpoint = buildCheckpointMeta("deploy", 1, "2026-03-24 16:21:00");
    const state = createBaseState({
      retryCount: 1,
      lastFailedNode: "deploy",
      lastFailureSummary: "部署验证失败：无法访问 http://127.0.0.1:4000",
      meetingNotes: [
        { id: "note-deploy-r1", phase: "deploy", round: 1, summary: "Deploy 第1轮：部署验证失败", contentFile: "nodes/note-deploy-r1.md" },
      ],
    });
    const snapshot = {
      node: "deploy",
      timestamp: "2026-03-24 16:21:00",
      traceId: "trace_fixture_build",
      state,
    };
    const traceIndex = buildTraceIndex(state, "deploy", "trace_fixture_build", "2026-03-24 16:21:00", [checkpoint], {
      calls: 3,
      inputTokens: 100,
      outputTokens: 30,
      totalTokens: 130,
      byAgent: {},
    });

    await fs.mkdir(`${workspace}/nodes`, { recursive: true });
    await fs.mkdir(`${workspace}/audit`, { recursive: true });
    await fs.mkdir(`${workspace}/checkpoints`, { recursive: true });
    await fs.writeFile(`${workspace}/boulder.json`, JSON.stringify(snapshot, null, 2));
    await fs.writeFile(`${workspace}/trace-index.json`, JSON.stringify(traceIndex, null, 2));
    await fs.writeFile(`${workspace}/token-usage.json`, JSON.stringify({ summary: traceIndex.tokenUsage, entries: [] }, null, 2));
    await fs.writeFile(`${workspace}/nodes/note-deploy-r1.md`, "# Deploy\n\n部署验证失败：无法访问 http://127.0.0.1:4000\n");
    await fs.writeFile(`${workspace}/audit/Infrastructure.md`, "Deployment Failed Verification\napp crashed on startup\n");
    await fs.writeFile(`${workspace}/audit/events.jsonl`, `${JSON.stringify({ type: "task-error", sender: "System", content: "deploy failed" })}\n`);
    await fs.writeFile(`${workspace}/${checkpoint.file}`, JSON.stringify(snapshot, null, 2));

    const fixture = await buildRunFixture(workspace);
    assert.equal(fixture.boulder.node, "deploy");
    assert.equal(fixture.traceIndex.lastFailure.node, "deploy");
    assert.match(fixture.notes["note-deploy-r1.md"], /部署验证失败/);
    assert.match(fixture.audits["Infrastructure.md"], /Deployment Failed Verification/);
    assert.match(fixture.audits["events.jsonl"], /task-error/);

    const outputFile = `${workspace}/fixture.json`;
    await writeRunFixture(workspace, outputFile);
    const written = JSON.parse(await fs.readFile(outputFile, "utf-8"));
    assert.equal(written.sourceRun.startsWith("jimclaw-test-"), true);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
