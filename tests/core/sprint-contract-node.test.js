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
require("ts-node/register/transpile-only");

const { sprintContractNode } = require("../../src/core/nodes/sprint_contract_node");

test("sprint contract node writes an agreed contract for active sprint", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();

  try {
    const result = await sprintContractNode(
      createBaseState({
        activeSprintId: "SP-2",
        sprintPlans: [{
          id: "SP-2",
          title: "核心 API 闭环",
          goal: "完成图书列表 API",
          userStoryIds: ["US-1"],
          acceptanceCriteriaIds: ["AC-1"],
          deliverables: ["图书列表 API", "API 测试"],
          allowedScope: ["src/", "tests/"],
          dependencies: ["SP-1"],
          estimatedComplexity: "medium",
          doneWhen: ["GET /api/books 返回 200"],
        }],
        apiContract: { endpoints: [{ path: "/api/books", method: "GET", description: "列表" }] },
        spec: {
          language: "TypeScript",
          framework: "Express",
          testCommand: "npm test",
          filesToCreate: ["src/index.ts", "tests/books.test.ts"],
        },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.sprintContracts.length, 1);
    assert.equal(result.sprintContracts[0].sprintId, "SP-2");
    assert.equal(result.sprintContracts[0].status, "agreed");
    assert.ok(result.sprintContracts[0].evaluatorPlan.checks.length >= 1);
    assert.deepEqual(result.sprintContracts[0].agreedScope.allowedFiles, ["src/index.ts", "tests/books.test.ts"]);
    assert.ok(result.meetingNotes.length >= 1);
    assert.equal(recorder.snapshots.at(-1).node, "sprint_contract");
  } finally {
    await removeTempWorkspace(workspace);
  }
});
