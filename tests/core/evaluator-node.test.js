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

const { host } = require("../../src/infra");
const { evaluatorNode } = require("../../src/core/nodes/evaluator_node");

function createSprintContract(checks) {
  return {
    version: "v1",
    sprintId: "SP-1",
    builderPlan: {
      intent: "完成图书列表 API",
      filesLikelyTouched: ["src/routes/books.ts", "src/controllers/bookController.ts"],
      implementationSteps: ["实现 API", "补测试"],
      selfChecks: ["npm test"],
      assumptions: [],
    },
    evaluatorPlan: {
      checks,
      requiredEvidence: checks.map((check) => check.description),
      passThreshold: "all",
      concerns: [],
    },
    agreedScope: {
      allowedFiles: ["src/routes/books.ts", "src/controllers/bookController.ts", "tests/books.test.ts"],
      forbiddenFiles: ["node_modules/", "dist/", ".git/"],
      maxNewFiles: 4,
    },
    status: "agreed",
  };
}

test("evaluator passes an http check with concrete evidence", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalHttpGet = host.httpGet;
  host.httpGet = async (url) => ({ statusCode: 200, body: `ok:${url}` });

  try {
    const result = await evaluatorNode(
      createBaseState({
        activeSprintId: "SP-1",
        sprintContracts: [createSprintContract([{
          id: "CHK-HTTP-1",
          kind: "http",
          description: "验证 GET /api/books",
          method: "GET",
          url: "/api/books",
          expectedStatus: [200],
        }])],
        deploymentStatus: { status: "running", url: "http://127.0.0.1:4100" },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.evaluationResults[0].status, "pass");
    assert.equal(result.evaluationResults[0].checks[0].evidence.httpStatus, 200);
    assert.match(result.evaluationResults[0].checks[0].reproSteps[0], /http:\/\/127\.0\.0\.1:4100\/api\/books/);
    assert.equal(result.validationReport.status, "pass");
  } finally {
    host.httpGet = originalHttpGet;
    await removeTempWorkspace(workspace);
  }
});

test("evaluator http failure records suspected files and validation report", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalHttpGet = host.httpGet;
  host.httpGet = async () => ({ statusCode: 500, body: "server error" });

  try {
    const result = await evaluatorNode(
      createBaseState({
        activeSprintId: "SP-1",
        sprintContracts: [createSprintContract([{
          id: "CHK-HTTP-1",
          kind: "http",
          description: "验证 GET /api/books",
          method: "GET",
          url: "/api/books",
          expectedStatus: [200],
        }])],
        deploymentStatus: { status: "running", url: "http://127.0.0.1:4100" },
        subTasks: [
          { id: "route", fileTarget: "src/routes/books.ts", description: "route", dependencies: [], contextRequirement: "", status: "completed" },
          { id: "controller", fileTarget: "src/controllers/bookController.ts", description: "controller", dependencies: [], contextRequirement: "", status: "completed" },
        ],
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.evaluationResults[0].status, "fail");
    assert.equal(result.validationReport.status, "fail");
    assert.equal(result.validationReport.failureType, "runtime_gap");
    assert.equal(result.evaluationResults[0].checks[0].suspectedFiles.includes("src/routes/books.ts"), true);
    assert.equal(result.qaFailures.failedFiles.includes("src/routes/books.ts"), true);
  } finally {
    host.httpGet = originalHttpGet;
    await removeTempWorkspace(workspace);
  }
});

test("evaluator does not pass command checks without evidence", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();

  try {
    const result = await evaluatorNode(
      createBaseState({
        activeSprintId: "SP-1",
        sprintContracts: [createSprintContract([{
          id: "CHK-CMD-1",
          kind: "command",
          description: "运行项目测试命令",
          command: "npm test",
        }])],
        testResults: "",
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.evaluationResults[0].status, "fail");
    assert.match(result.evaluationResults[0].checks[0].evidence.error, /缺少命令验收证据/);
    assert.equal(result.validationReport.status, "fail");
  } finally {
    await removeTempWorkspace(workspace);
  }
});
