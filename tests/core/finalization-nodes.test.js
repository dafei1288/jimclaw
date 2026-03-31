const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createTempWorkspace,
  removeTempWorkspace,
  createBaseState,
  createNoopEmit,
  createNoopStartSpan,
  createSnapshotRecorder,
} = require("./test-helpers");
const { postMortemNode } = require("../../src/core/nodes/post_mortem_node");
const { persistenceNode } = require("../../src/core/nodes/persistence_node");

test("post_mortem persists final review snapshot", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    retryCount: 2,
    lastFailedNode: "qa",
    lastFailureSummary: "宿主环境阻塞",
  });

  try {
    const result = await postMortemNode(
      state,
      {
        pm: {
          getPersona() {
            return { name: "观止" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.teamChatLog.length, 1);
    assert.equal(result.teamChatLog[0].sender, "观止");
    assert.equal(recorder.snapshots.at(-1)?.node, "post_mortem");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("persistence persists final cleanup snapshot", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    retryCount: 2,
    isDone: false,
    lastFailedNode: "qa",
    lastFailureSummary: "宿主环境阻塞",
  });

  try {
    const result = await persistenceNode(
      state,
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.isDone, true);
    assert.equal(recorder.snapshots.at(-1)?.node, "persistence");
  } finally {
    await removeTempWorkspace(workspace);
  }
});
