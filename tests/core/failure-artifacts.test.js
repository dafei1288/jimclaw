const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const {
  createTempWorkspace,
  removeTempWorkspace,
  createBaseState,
} = require("./test-helpers");
const { createJimClawGraph } = require("../../src/core/graph");
const {
  recordNodeFailure,
  buildTraceIndex,
  shouldPersistCheckpoint,
  buildCheckpointMeta,
  loadTraceIndex,
  loadCheckpointSnapshot,
  buildReplayStateFromSnapshot,
  getResumeNodeFromCheckpoint,
  prepareReplayStateFromCheckpoint,
  validateWorkspaceArtifacts,
} = require("../../src/core/logic_utils");

test("node failure recorder writes fallback meeting note and summary", async () => {
  const workspace = await createTempWorkspace();

  try {
    const { failure, meetingNotes } = await recordNodeFailure(
      workspace,
      { retryCount: 2, meetingNotes: [] },
      "coder",
      new Error("simulated coder crash")
    );

    assert.equal(failure.node, "coder");
    assert.equal(failure.round, 2);
    assert.match(failure.summary, /coder/i);
    assert.equal(meetingNotes.length, 1);
    assert.equal(meetingNotes[0].id, "note-coder-r2");

    const noteContent = await fs.readFile(`${workspace}/nodes/note-coder-r2.md`, "utf-8");
    assert.match(noteContent, /simulated coder crash/);
    assert.match(noteContent, /轮次：2/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("trace index summarizes nodes, notes, file changes and failure state", async () => {
  const state = createBaseState({
    retryCount: 1,
    codeLog: [
      { round: 0, file: "src/index.ts", taskTitle: "entry", status: "written" },
      { round: 1, file: "src/routes/userRoutes.ts", taskTitle: "routes", status: "error", error: "contract drift" },
    ],
    meetingNotes: [
      { id: "note-pm-r0", phase: "pm", round: 0, summary: "pm summary", contentFile: "nodes/note-pm-r0.md" },
      { id: "note-coder-r1", phase: "coder", round: 1, summary: "coder summary", contentFile: "nodes/note-coder-r1.md" },
    ],
    lastFailedNode: "verifier",
    lastFailureSummary: "verifier 节点异常：contract drift",
  });

  const checkpoints = [buildCheckpointMeta("orchestrator", 0, "2026-03-23 19:58:00")];
  const index = buildTraceIndex(state, "verifier", "trace_123", "2026-03-23 20:00:00", checkpoints);

  assert.equal(index.traceId, "trace_123");
  assert.equal(index.lastNode, "verifier");
  assert.equal(index.retryCount, 1);
  assert.equal(index.lastFailure.node, "verifier");
  assert.equal(index.fileChanges.length, 2);
  assert.equal(index.files["src/index.ts"].lastStatus, "written");
  assert.equal(index.files["src/routes/userRoutes.ts"].lastStatus, "error");
  assert.equal(index.files["src/routes/userRoutes.ts"].lastError, "contract drift");
  assert.equal(index.meetingNotes.length, 2);
  assert.equal(index.checkpoints.length, 1);
  assert.equal(index.checkpoints[0].node, "orchestrator");
  assert.equal(index.timeline[index.timeline.length - 1].node, "verifier");
});

test("checkpoint rules only keep stable success anchors", () => {
  assert.equal(shouldPersistCheckpoint("orchestrator"), true);
  assert.equal(shouldPersistCheckpoint("coder_final"), true);
  assert.equal(shouldPersistCheckpoint("verifier"), true);
  assert.equal(shouldPersistCheckpoint("qa"), true);
  assert.equal(shouldPersistCheckpoint("deploy"), true);
  assert.equal(shouldPersistCheckpoint("pm"), false);
  assert.equal(shouldPersistCheckpoint("coder_crash"), false);

  const checkpoint = buildCheckpointMeta("coder_final", 2, "2026-03-23 20:30:00");
  assert.equal(checkpoint.id, "coder_final-r2");
  assert.equal(checkpoint.file, "checkpoints/coder_final-r2.json");
});

test("checkpoint loader returns snapshot and sanitized replay state", async () => {
  const workspace = await createTempWorkspace();

  try {
    const checkpoint = buildCheckpointMeta("coder_final", 2, "2026-03-23 20:30:00");
    const state = createBaseState({
      retryCount: 2,
      messages: [{ id: "m1" }],
      teamChatLog: [{ sender: "QA", content: "old" }],
      testResults: "old failure",
      qaFailures: { failedFiles: ["src/index.ts"], testErrors: ["boom"], failedTestNames: ["x"] },
      lastFailedNode: "qa",
      lastFailureSummary: "old summary",
      blockedReason: "missing deps",
      recoveredEnvironment: true,
      envReady: false,
      containerId: "jimclaw_test",
      allocatedHostPort: 3100,
      failureFingerprint: "fp",
      sameFailureCount: 3,
      subTasks: [{ id: "t1", description: "x", fileTarget: "src/index.ts", dependencies: [], contextRequirement: "", status: "completed" }],
    });
    const traceIndex = buildTraceIndex(state, "coder_final", "trace_restore", "2026-03-23 20:30:00", [checkpoint]);

    await fs.mkdir(`${workspace}/checkpoints`, { recursive: true });
    await fs.writeFile(`${workspace}/trace-index.json`, JSON.stringify(traceIndex, null, 2));
    await fs.writeFile(`${workspace}/${checkpoint.file}`, JSON.stringify({
      node: "coder_final",
      timestamp: "2026-03-23 20:30:00",
      traceId: "trace_restore",
      state,
    }, null, 2));

    const loadedIndex = await loadTraceIndex(workspace);
    assert.equal(loadedIndex.checkpoints.length, 1);

    const snapshot = await loadCheckpointSnapshot(workspace, "coder_final-r2");
    assert.equal(snapshot.node, "coder_final");

    const replayState = buildReplayStateFromSnapshot(snapshot.state);
    assert.equal(replayState.retryCount, 2);
    assert.equal(Array.isArray(replayState.messages), true);
    assert.equal(replayState.messages.length, 0);
    assert.equal(replayState.teamChatLog.length, 0);
    assert.equal(replayState.testResults, "");
    assert.equal(replayState.qaFailures, null);
    assert.equal(replayState.lastFailedNode, "");
    assert.equal(replayState.resumeFromNode, "");
    assert.equal(replayState.containerId, "");
    assert.equal(replayState.subTasks[0].status, "completed");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("checkpoint resume mapping targets the next executable node", () => {
  assert.equal(getResumeNodeFromCheckpoint("orchestrator"), "coder");
  assert.equal(getResumeNodeFromCheckpoint("coder_final"), "env_guard");
  assert.equal(getResumeNodeFromCheckpoint("verifier"), "qa");
  assert.equal(getResumeNodeFromCheckpoint("qa"), "qa_resume_router");
  assert.equal(getResumeNodeFromCheckpoint("deploy"), "post_mortem");
  assert.equal(getResumeNodeFromCheckpoint("unknown"), "pm");
});

test("checkpoint replay state includes resume target", () => {
  const replayState = prepareReplayStateFromCheckpoint({
    node: "coder_final",
    state: createBaseState({ retryCount: 3, subTasks: [{ id: "t1", description: "x", fileTarget: "src/a.ts", dependencies: [], contextRequirement: "", status: "completed" }] }),
  });

  assert.equal(replayState.retryCount, 3);
  assert.equal(replayState.resumeFromNode, "env_guard");
  assert.equal(replayState.subTasks[0].status, "completed");
});

test("replay graph reuses provided workspace and trace context", async () => {
  const workspace = await createTempWorkspace();

  try {
    const events = [];
    await createJimClawGraph(
      { pm: {}, architect: {}, coder: {}, qa: {} },
      (event) => events.push(event),
      { workspacePath: workspace, traceId: "trace_replay_existing" }
    );

    assert.equal(events.length > 0, true);
    assert.equal(events[0].type, "workspace-ready");
    assert.equal(events[0].metadata.workspacePath, workspace);
    assert.equal(events[0].metadata.traceId, "trace_replay_existing");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("workspace artifact validator accepts consistent replay artifacts", async () => {
  const workspace = await createTempWorkspace();

  try {
    const checkpoint = buildCheckpointMeta("verifier", 2, "2026-03-23 21:00:00");
    const state = createBaseState({
      retryCount: 2,
      subTasks: [
        { id: "t1", description: "entry", fileTarget: "src/index.ts", dependencies: [], contextRequirement: "", status: "completed" },
      ],
      codeLog: [
        { round: 2, file: "src/index.ts", taskTitle: "entry", status: "written" },
      ],
    });
    const snapshot = {
      node: "verifier",
      timestamp: "2026-03-23 21:00:00",
      traceId: "trace_consistent",
      state,
    };
    const traceIndex = buildTraceIndex(state, "verifier", "trace_consistent", "2026-03-23 21:00:00", [checkpoint]);

    await fs.mkdir(`${workspace}/checkpoints`, { recursive: true });
    await fs.writeFile(`${workspace}/boulder.json`, JSON.stringify(snapshot, null, 2));
    await fs.writeFile(`${workspace}/trace-index.json`, JSON.stringify(traceIndex, null, 2));
    await fs.writeFile(`${workspace}/${checkpoint.file}`, JSON.stringify(snapshot, null, 2));

    const result = await validateWorkspaceArtifacts(workspace);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("workspace artifact validator detects checkpoint trace drift", async () => {
  const workspace = await createTempWorkspace();

  try {
    const checkpoint = buildCheckpointMeta("verifier", 2, "2026-03-23 21:00:00");
    const state = createBaseState({ retryCount: 2 });
    const snapshot = {
      node: "verifier",
      timestamp: "2026-03-23 21:00:00",
      traceId: "trace_consistent",
      state,
    };
    const traceIndex = buildTraceIndex(state, "verifier", "trace_consistent", "2026-03-23 21:00:00", [checkpoint]);

    await fs.mkdir(`${workspace}/checkpoints`, { recursive: true });
    await fs.writeFile(`${workspace}/boulder.json`, JSON.stringify(snapshot, null, 2));
    await fs.writeFile(`${workspace}/trace-index.json`, JSON.stringify(traceIndex, null, 2));
    await fs.writeFile(`${workspace}/${checkpoint.file}`, JSON.stringify({
      ...snapshot,
      traceId: "trace_other",
    }, null, 2));

    const result = await validateWorkspaceArtifacts(workspace);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /trace/i);
    assert.match(result.errors.join("\n"), /checkpoint/i);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("workspace artifact validator detects completed subtask without written file summary", async () => {
  const workspace = await createTempWorkspace();

  try {
    const checkpoint = buildCheckpointMeta("verifier", 1, "2026-03-24 00:30:00");
    const state = createBaseState({
      retryCount: 1,
      subTasks: [
        { id: "t1", description: "entry", fileTarget: "src/index.ts", dependencies: [], contextRequirement: "", status: "completed" },
      ],
      codeLog: [],
    });
    const snapshot = {
      node: "verifier",
      timestamp: "2026-03-24 00:30:00",
      traceId: "trace_subtask_gap",
      state,
    };
    const traceIndex = buildTraceIndex(state, "verifier", "trace_subtask_gap", "2026-03-24 00:30:00", [checkpoint]);

    await fs.mkdir(`${workspace}/checkpoints`, { recursive: true });
    await fs.writeFile(`${workspace}/boulder.json`, JSON.stringify(snapshot, null, 2));
    await fs.writeFile(`${workspace}/trace-index.json`, JSON.stringify(traceIndex, null, 2));
    await fs.writeFile(`${workspace}/${checkpoint.file}`, JSON.stringify(snapshot, null, 2));

    const result = await validateWorkspaceArtifacts(workspace);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /src\/index\.ts/);
    assert.match(result.errors.join("\n"), /completed/i);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("workspace artifact validator detects failed subtask that still looks written", async () => {
  const workspace = await createTempWorkspace();

  try {
    const checkpoint = buildCheckpointMeta("verifier", 1, "2026-03-24 00:35:00");
    const state = createBaseState({
      retryCount: 1,
      subTasks: [
        { id: "t1", description: "entry", fileTarget: "src/index.ts", dependencies: [], contextRequirement: "", status: "failed", lastError: "syntax" },
      ],
      codeLog: [
        { round: 1, file: "src/index.ts", taskTitle: "entry", status: "written" },
      ],
    });
    const snapshot = {
      node: "verifier",
      timestamp: "2026-03-24 00:35:00",
      traceId: "trace_subtask_conflict",
      state,
    };
    const traceIndex = buildTraceIndex(state, "verifier", "trace_subtask_conflict", "2026-03-24 00:35:00", [checkpoint]);

    await fs.mkdir(`${workspace}/checkpoints`, { recursive: true });
    await fs.writeFile(`${workspace}/boulder.json`, JSON.stringify(snapshot, null, 2));
    await fs.writeFile(`${workspace}/trace-index.json`, JSON.stringify(traceIndex, null, 2));
    await fs.writeFile(`${workspace}/${checkpoint.file}`, JSON.stringify(snapshot, null, 2));

    const result = await validateWorkspaceArtifacts(workspace);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /src\/index\.ts/);
    assert.match(result.errors.join("\n"), /failed/i);
    assert.match(result.errors.join("\n"), /written/i);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
