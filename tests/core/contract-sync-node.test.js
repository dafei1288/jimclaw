const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const {
  createTempWorkspace,
  removeTempWorkspace,
  createBaseState,
  createNoopEmit,
  createNoopStartSpan,
  createSnapshotRecorder,
} = require("./test-helpers");
const { contractSyncNode } = require("../../src/core/nodes/contract_sync_node");
const { AgentTimeoutError } = require("../../src/core/agent");

function createArchitectAgent(handler) {
  return {
    getPersona() {
      return { name: "测试架构师" };
    },
    async chat(...args) {
      return handler(...args);
    },
  };
}

test("contract_sync persists validated contract snapshot", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    contract: { title: "图书管理系统", requirements: [], acceptanceCriteria: [] },
    apiContract: {
      endpoints: [
        { method: "GET", path: "/api/books", description: "图书列表" },
      ],
    },
  });
  const architect = createArchitectAgent(async () => ({
    content: JSON.stringify({
      endpoints: [
        { method: "GET", path: "/api/books", description: "图书列表" },
        { method: "POST", path: "/api/books", description: "新增图书" },
      ],
    }),
  }));

  try {
    const result = await contractSyncNode(
      state,
      { architect },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.apiContract.endpoints.length, 2);
    assert.equal(recorder.snapshots.length, 1);
    assert.equal(recorder.snapshots[0].node, "contract_sync");
    assert.equal(recorder.snapshots[0].state.apiContract.endpoints.length, 2);

    const raw = await fs.readFile(path.join(workspace, "api_contract_validated.json"), "utf-8");
    const saved = JSON.parse(raw);
    assert.equal(saved.endpoints.length, 2);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("contract_sync falls back to current api contract on recoverable agent timeout", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    contract: { title: "图书管理系统", requirements: [], acceptanceCriteria: [] },
    apiContract: {
      endpoints: [
        { method: "GET", path: "/api/books", description: "图书列表" },
      ],
    },
  });
  const architect = createArchitectAgent(async () => {
    throw new AgentTimeoutError("测试架构师", 1234);
  });

  try {
    const result = await contractSyncNode(
      state,
      { architect },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.deepEqual(result.apiContract, state.apiContract);
    assert.equal(recorder.snapshots.length, 1);
    assert.equal(recorder.snapshots[0].node, "contract_sync");
  } finally {
    await removeTempWorkspace(workspace);
  }
});
