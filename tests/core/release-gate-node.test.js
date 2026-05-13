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

const { releaseGateNode } = require("../../src/core/nodes/release_gate_node");

function createProductSpec(criteria) {
  return {
    version: "v1",
    title: "图书管理系统",
    userGoal: "用户可以管理图书",
    userStories: [{ id: "US-1", story: "用户可以查看图书列表", priority: "must" }],
    acceptanceCriteria: criteria,
    nonGoals: [],
  };
}

function createEvaluationResult(evidence = { httpStatus: 200, httpBodySnippet: "GET /api/books 返回 200" }) {
  return {
    version: "v1",
    sprintId: "SP-1",
    status: "pass",
    checks: [{
      checkId: "CHK-1",
      status: "pass",
      evidence,
      reproSteps: ["GET /api/books"],
      suspectedFiles: [],
    }],
    summary: "SP-1 验收通过",
  };
}

test("release gate passes when all acceptance criteria have passing sprint evidence", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();

  try {
    const result = await releaseGateNode(
      createBaseState({
        productSpec: createProductSpec([
          { id: "AC-1", description: "GET /api/books 返回 200", verificationKind: "api" },
        ]),
        sprintPlans: [{
          id: "SP-1",
          title: "核心 API",
          goal: "完成图书列表 API",
          userStoryIds: ["US-1"],
          acceptanceCriteriaIds: ["AC-1"],
          deliverables: ["API"],
          allowedScope: ["src/", "tests/"],
          dependencies: [],
          estimatedComplexity: "small",
          doneWhen: ["GET /api/books 返回 200"],
        }],
        evaluationResults: [createEvaluationResult()],
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.isDone, true);
    assert.equal(result.validationReport.status, "pass");
    assert.equal(result.lastFailedNode, "");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("release gate fails when acceptance criteria are not covered by evidence", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();

  try {
    const result = await releaseGateNode(
      createBaseState({
        productSpec: createProductSpec([
          { id: "AC-1", description: "GET /api/books 返回 200", verificationKind: "api" },
          { id: "AC-2", description: "POST /api/books 可以新增图书", verificationKind: "api" },
        ]),
        sprintPlans: [{
          id: "SP-1",
          title: "核心 API",
          goal: "完成图书列表 API",
          userStoryIds: ["US-1"],
          acceptanceCriteriaIds: ["AC-1"],
          deliverables: ["API"],
          allowedScope: ["src/", "tests/"],
          dependencies: [],
          estimatedComplexity: "small",
          doneWhen: ["GET /api/books 返回 200"],
        }],
        evaluationResults: [createEvaluationResult()],
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.isDone, false);
    assert.equal(result.validationReport.status, "fail");
    assert.equal(result.validationReport.failureType, "planning_gap");
    assert.equal(result.lastFailedNode, "release_gate");
    assert.match(result.lastFailureSummary, /AC-2/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("release gate fails when frontend acceptance lacks ui evidence", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();

  try {
    const result = await releaseGateNode(
      createBaseState({
        productSpec: createProductSpec([
          { id: "AC-UI", description: "用户可以通过页面查看图书列表", verificationKind: "ui" },
        ]),
        sprintPlans: [{
          id: "SP-1",
          title: "前端闭环",
          goal: "完成图书页面",
          userStoryIds: ["US-1"],
          acceptanceCriteriaIds: ["AC-UI"],
          deliverables: ["页面"],
          allowedScope: ["frontend/", "public/"],
          dependencies: [],
          estimatedComplexity: "medium",
          doneWhen: ["用户可以通过页面查看图书列表"],
        }],
        evaluationResults: [createEvaluationResult({ httpStatus: 200, httpBodySnippet: "[]" })],
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.isDone, false);
    assert.equal(result.validationReport.status, "fail");
    assert.match(result.lastFailureSummary, /UI 证据|前端/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
