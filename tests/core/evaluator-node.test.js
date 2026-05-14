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
const {
  buildContainerEvaluatorLaunchCommand,
  evaluatorNode,
} = require("../../src/core/nodes/evaluator_node");

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

test("evaluator starts a temporary runtime before http checks when deploy has not run", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalHttpGet = host.httpGet;
  const originalStartBackground = host.startBackground;
  const originalKillProcess = host.killProcess;
  let started = false;
  let killedPid = 0;
  host.startBackground = async (opts) => {
    started = true;
    assert.equal(opts.command, "npm start");
    assert.equal(opts.env.PORT, "4101");
    return 12345;
  };
  host.killProcess = async (pid) => {
    killedPid = pid;
    return true;
  };
  host.httpGet = async (url) => ({ statusCode: 200, body: `ok:${url}` });

  try {
    const result = await evaluatorNode(
      createBaseState({
        executionBackend: "host",
        allocatedHostPort: 4101,
        manifest: { services: [{ name: "app", port: 4101 }], environment: {}, sharedConfig: {} },
        spec: { runCommand: "npm start" },
        activeSprintId: "SP-1",
        sprintContracts: [createSprintContract([{
          id: "CHK-HTTP-1",
          kind: "http",
          description: "验证 GET /api/books",
          method: "GET",
          url: "/api/books",
          expectedStatus: [200],
        }])],
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(started, true);
    assert.equal(killedPid, 12345);
    assert.equal(result.deploymentStatus, undefined);
    assert.equal(result.hostRuntimePid, undefined);
    assert.equal(result.evaluationResults[0].status, "pass");
  } finally {
    host.httpGet = originalHttpGet;
    host.startBackground = originalStartBackground;
    host.killProcess = originalKillProcess;
    await removeTempWorkspace(workspace);
  }
});

test("evaluator waits through transient ECONNRESET before http checks", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalHttpGet = host.httpGet;
  const originalStartBackground = host.startBackground;
  const originalKillProcess = host.killProcess;
  const calls = [];
  const responses = [
    { error: "read ECONNRESET" },
    { error: "read ECONNRESET" },
    { statusCode: 200, body: "runtime ready" },
    { statusCode: 200, body: "books ok" },
  ];
  host.startBackground = async () => 22334;
  host.killProcess = async () => true;
  host.httpGet = async (url) => {
    calls.push(url);
    return responses.shift() || { statusCode: 200, body: "ok" };
  };

  try {
    const result = await evaluatorNode(
      createBaseState({
        executionBackend: "host",
        allocatedHostPort: 4102,
        manifest: { services: [{ name: "app", port: 4102 }], environment: {}, sharedConfig: {} },
        spec: { runCommand: "npm start" },
        activeSprintId: "SP-1",
        sprintContracts: [createSprintContract([{
          id: "CHK-HTTP-1",
          kind: "http",
          description: "验证 GET /api/books",
          method: "GET",
          url: "/api/books",
          expectedStatus: [200],
        }])],
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.evaluationResults[0].status, "pass");
    assert.deepEqual(calls, [
      "http://127.0.0.1:4102",
      "http://127.0.0.1:4102",
      "http://127.0.0.1:4102",
      "http://127.0.0.1:4102/api/books",
    ]);
  } finally {
    host.httpGet = originalHttpGet;
    host.startBackground = originalStartBackground;
    host.killProcess = originalKillProcess;
    await removeTempWorkspace(workspace);
  }
});

test("container evaluator runtime command runs in foreground for docker exec detached mode", () => {
  const command = buildContainerEvaluatorLaunchCommand("npm start", 4000);

  assert.doesNotMatch(command, /nohup/);
  assert.doesNotMatch(command, /& echo/);
  assert.match(command, /echo \$\$ >\/tmp\/jimclaw\/evaluator\.pid/);
  assert.match(command, /exec env PORT=4000 HOST=0\.0\.0\.0 npm start/);
  assert.match(command, />\/tmp\/jimclaw\/evaluator\.log 2>&1/);
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

test("evaluator attributes http 404 to entry and route mounting files", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalHttpGet = host.httpGet;
  const requestedUrls = [];
  host.httpGet = async (url) => {
    requestedUrls.push(url);
    return { statusCode: 404, body: "Cannot GET" };
  };

  try {
    const result = await evaluatorNode(
      createBaseState({
        activeSprintId: "SP-1",
        sprintContracts: [createSprintContract([{
          id: "CHK-HTTP-BOOK-ID",
          kind: "http",
          description: "验证 GET /api/books/:id",
          method: "GET",
          url: "/api/books/:id",
          expectedStatus: [200],
        }])],
        deploymentStatus: { status: "running", url: "http://127.0.0.1:4100" },
        spec: {
          entryPoint: "src/index.ts",
          filesToCreate: ["src/index.ts", "src/routes/books.ts", "src/services/bookService.ts", "tests/books.test.ts"],
        },
        subTasks: [
          { id: "entry", fileTarget: "src/index.ts", description: "entry", dependencies: [], contextRequirement: "", status: "completed" },
          { id: "route", fileTarget: "src/routes/books.ts", description: "route", dependencies: [], contextRequirement: "", status: "completed" },
          { id: "service", fileTarget: "src/services/bookService.ts", description: "service", dependencies: [], contextRequirement: "", status: "completed" },
        ],
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    const suspectedFiles = result.evaluationResults[0].checks[0].suspectedFiles;
    assert.equal(requestedUrls[0], "http://127.0.0.1:4100/api/books/1");
    assert.equal(suspectedFiles.includes("src/index.ts"), true);
    assert.equal(suspectedFiles.includes("src/routes/books.ts"), true);
    assert.equal(result.qaFailures.failedFiles.includes("src/index.ts"), true);
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
