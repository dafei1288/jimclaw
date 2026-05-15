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

function createEvaluationResult(
  evidence = { httpStatus: 200, httpBodySnippet: "GET /api/books 返回 200" },
  reproSteps = ["GET /api/books"]
) {
  return {
    version: "v1",
    sprintId: "SP-1",
    status: "pass",
    checks: [{
      checkId: "CHK-1",
      status: "pass",
      evidence,
      reproSteps,
      suspectedFiles: [],
    }],
    summary: "SP-1 验收通过",
  };
}

function createHttpEvaluationResult(path, evidence = {}) {
  return createEvaluationResult({
    httpStatus: 200,
    httpBodySnippet: "ok",
    ...evidence,
  }, [`GET ${path}`]);
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

test("release gate fails when only health endpoint has passing evidence", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();

  try {
    const result = await releaseGateNode(
      createBaseState({
        productSpec: createProductSpec([
          { id: "AC-API", description: "GET /api/books 返回 200", verificationKind: "api" },
        ]),
        apiContract: {
          endpoints: [
            { method: "GET", path: "/api/health" },
            { method: "GET", path: "/api/books" },
          ],
        },
        sprintPlans: [{
          id: "SP-1",
          title: "核心 API",
          goal: "完成图书列表 API",
          userStoryIds: ["US-1"],
          acceptanceCriteriaIds: ["AC-API"],
          deliverables: ["API"],
          allowedScope: ["src/", "tests/"],
          dependencies: [],
          estimatedComplexity: "small",
          doneWhen: ["GET /api/books 返回 200"],
        }],
        evaluationResults: [createEvaluationResult(
          { httpStatus: 200, httpBodySnippet: "{\"status\":\"ok\"}" },
          ["GET /api/health"]
        )],
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.isDone, false);
    assert.equal(result.validationReport.status, "fail");
    assert.match(result.lastFailureSummary, /\/api\/books|业务端点|GET/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("release gate accepts html http evidence for frontend acceptance", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();

  try {
    const result = await releaseGateNode(
      createBaseState({
        productSpec: createProductSpec([
          { id: "AC-UI", description: "用户可以通过页面查看图书列表", verificationKind: "ui" },
        ]),
        apiContract: {
          endpoints: [
            { method: "GET", path: "/products" },
          ],
        },
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
        evaluationResults: [createEvaluationResult(
          { httpStatus: 200, httpBodySnippet: "<!doctype html><html><body>图书列表</body></html>" },
          ["GET /products"]
        )],
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.isDone, true);
    assert.equal(result.validationReport.status, "pass");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("release gate fails semantic acceptance without semantic evidence", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();

  try {
    const result = await releaseGateNode(
      createBaseState({
        productSpec: createProductSpec([
          { id: "AC-LOW-STOCK", description: "GET /api/products?lowStock=true 仅返回低库存商品", verificationKind: "api" },
        ]),
        apiContract: {
          endpoints: [
            { method: "GET", path: "/api/products" },
          ],
        },
        sprintPlans: [{
          id: "SP-1",
          title: "低库存筛选",
          goal: "完成低库存筛选 API",
          userStoryIds: ["US-1"],
          acceptanceCriteriaIds: ["AC-LOW-STOCK"],
          deliverables: ["API"],
          allowedScope: ["src/", "tests/"],
          dependencies: [],
          estimatedComplexity: "small",
          doneWhen: ["GET /api/products?lowStock=true 仅返回低库存商品"],
        }],
        evaluationResults: [createHttpEvaluationResult(
          "/api/products?lowStock=true",
          { httpBodySnippet: "[{\"name\":\"Low stock\",\"stock\":3}]" }
        )],
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.isDone, false);
    assert.equal(result.validationReport.status, "fail");
    assert.match(result.lastFailureSummary, /语义证据|semantic|筛选|lowStock/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("release gate passes semantic acceptance with passing semantic evidence", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();

  try {
    const result = await releaseGateNode(
      createBaseState({
        productSpec: createProductSpec([
          { id: "AC-LOW-STOCK", description: "GET /api/products?lowStock=true 仅返回低库存商品", verificationKind: "api" },
        ]),
        apiContract: {
          endpoints: [
            { method: "GET", path: "/api/products" },
          ],
        },
        sprintPlans: [{
          id: "SP-1",
          title: "低库存筛选",
          goal: "完成低库存筛选 API",
          userStoryIds: ["US-1"],
          acceptanceCriteriaIds: ["AC-LOW-STOCK"],
          deliverables: ["API"],
          allowedScope: ["src/", "tests/"],
          dependencies: [],
          estimatedComplexity: "small",
          doneWhen: ["GET /api/products?lowStock=true 仅返回低库存商品"],
        }],
        evaluationResults: [createHttpEvaluationResult(
          "/api/products?lowStock=true",
          {
            httpBodySnippet: "[{\"name\":\"Low stock\",\"stock\":3}]",
            assertions: [
              { id: "A-array", type: "jsonArray", status: "pass", message: "响应体是 JSON 数组" },
              { id: "A-stock-low", type: "jsonEvery", status: "pass", message: "所有元素满足 stock lt 10" },
            ],
          }
        )],
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.isDone, true);
    assert.equal(result.validationReport.status, "pass");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("release gate ignores stale failed evaluation when the same sprint later passes", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();

  try {
    const staleFailure = {
      version: "v1",
      sprintId: "SP-2",
      status: "fail",
      checks: [{
        checkId: "CHK-LOW-STOCK",
        status: "fail",
        evidence: {
          httpStatus: 200,
          httpBodySnippet: "[]",
          assertions: [
            { id: "A-array", type: "jsonArray", status: "pass", message: "响应体是 JSON 数组" },
            { id: "A-non-empty", type: "jsonNonEmpty", status: "fail", message: "响应体 JSON 数组为空" },
          ],
        },
        reproSteps: ["GET /api/products?lowStock=true"],
        suspectedFiles: ["src/services/productService.ts"],
      }],
      summary: "SP-2 验收失败：CHK-LOW-STOCK",
    };
    const latestPass = {
      ...staleFailure,
      status: "pass",
      checks: [{
        checkId: "CHK-LOW-STOCK",
        status: "pass",
        evidence: {
          httpStatus: 200,
          httpBodySnippet: "[{\"name\":\"低库存商品A\",\"stock\":3}]",
          assertions: [
            { id: "A-array", type: "jsonArray", status: "pass", message: "响应体是 JSON 数组" },
            { id: "A-non-empty", type: "jsonNonEmpty", status: "pass", message: "响应体 JSON 数组非空" },
            { id: "A-stock-low", type: "jsonEvery", status: "pass", message: "所有元素满足 stock lt 10" },
          ],
        },
        reproSteps: ["GET /api/products?lowStock=true"],
        suspectedFiles: [],
      }],
      summary: "SP-2 验收通过",
    };

    const result = await releaseGateNode(
      createBaseState({
        productSpec: createProductSpec([
          { id: "AC-LOW-STOCK", description: "GET /api/products?lowStock=true 仅返回低库存商品", verificationKind: "api" },
        ]),
        apiContract: {
          endpoints: [
            { method: "GET", path: "/api/products" },
          ],
        },
        sprintPlans: [{
          id: "SP-2",
          title: "低库存筛选",
          goal: "完成低库存筛选 API",
          userStoryIds: ["US-1"],
          acceptanceCriteriaIds: ["AC-LOW-STOCK"],
          deliverables: ["API"],
          allowedScope: ["src/", "tests/"],
          dependencies: [],
          estimatedComplexity: "small",
          doneWhen: ["GET /api/products?lowStock=true 仅返回低库存商品"],
        }],
        evaluationResults: [staleFailure, latestPass],
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
