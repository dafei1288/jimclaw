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

const { sprintPlannerNode } = require("../../src/core/nodes/sprint_planner_node");

test("sprint planner writes sprint plans and active sprint", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();

  try {
    const result = await sprintPlannerNode(
      createBaseState({
        userGoal: "图书管理",
        contract: {
          title: "图书管理系统",
          requirements: ["用户可以查看图书列表"],
          acceptanceCriteria: ["GET /api/books 返回 200"],
        },
        productSpec: {
          version: "v1",
          title: "图书管理系统",
          userGoal: "图书管理",
          userStories: [{ id: "US-1", story: "用户可以查看图书列表", priority: "must" }],
          acceptanceCriteria: [{ id: "AC-1", description: "GET /api/books 返回 200", verificationKind: "api" }],
          nonGoals: [],
        },
        apiContract: { endpoints: [{ path: "/api/books", method: "GET", description: "列表" }] },
        spec: { language: "TypeScript", framework: "Express", filesToCreate: [] },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.ok(result.sprintPlans.length >= 1);
    assert.equal(result.activeSprintId, result.sprintPlans[0].id);
    assert.ok(result.meetingNotes.length >= 1);
    assert.equal(recorder.snapshots.at(-1).node, "sprint_planner");
  } finally {
    await removeTempWorkspace(workspace);
  }
});
