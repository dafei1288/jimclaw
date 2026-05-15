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
const { fixPlanNode } = require("../../src/core/nodes/fix_plan_node");
const { AgentTimeoutError } = require("../../src/core/agent");

function createRateLimitError(message = "429 余额不足或无可用资源包,请充值。") {
  const error = new Error(message);
  error.status = 429;
  return error;
}

test("fix plan creates repair contract from failed evaluation result", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const failingFile = "src/routes/books.ts";
  await fs.mkdir(path.join(workspace, "src", "routes"), { recursive: true });
  await fs.writeFile(path.join(workspace, failingFile), "export default {};\n", "utf8");

  const state = createBaseState({
    retryCount: 1,
    activeSprintId: "SP-1",
    sprintContracts: [{
      version: "v1",
      sprintId: "SP-1",
      builderPlan: {
        intent: "完成图书列表 API",
        filesLikelyTouched: [failingFile],
        implementationSteps: ["修复路由"],
        selfChecks: ["npm test"],
        assumptions: [],
      },
      evaluatorPlan: {
        checks: [{
          id: "CHK-HTTP-1",
          kind: "http",
          description: "验证 GET /api/books",
          method: "GET",
          url: "/api/books",
          expectedStatus: [200],
        }],
        requiredEvidence: ["验证 GET /api/books"],
        passThreshold: "all",
        concerns: [],
      },
      agreedScope: {
        allowedFiles: [failingFile],
        forbiddenFiles: ["node_modules/", "dist/", ".git/"],
        maxNewFiles: 2,
      },
      status: "agreed",
    }],
    evaluationResults: [{
      version: "v1",
      sprintId: "SP-1",
      status: "fail",
      checks: [{
        checkId: "CHK-HTTP-1",
        status: "fail",
        evidence: { httpStatus: 500, httpBodySnippet: "server error" },
        reproSteps: ["GET /api/books"],
        suspectedFiles: [failingFile, "src/admin.ts"],
      }],
      summary: "SP-1 验收失败：CHK-HTTP-1",
    }],
    subTasks: [
      {
        id: "task-route",
        fileTarget: failingFile,
        description: "实现图书路由",
        dependencies: [],
        contextRequirement: "none",
        status: "completed",
      },
    ],
  });

  const agents = {
    coder: {
      getPersona() { return { name: "星河" }; },
      async chat() {
        return {
          content: '{"overall_diagnosis":"HTTP 验收失败","items":[{"file":"src/routes/books.ts","issue_id":"BUG-EVAL-SP-1-CHK-HTTP-1","my_understanding":"路由没有正确返回 200","proposed_change":"修复 GET /api/books 的路由响应","confidence":"high"}]}',
        };
      },
    },
    qa: {
      getPersona() { return { name: "清扬" }; },
      async chat() {
        return {
          content: '{"overall_assessment":"方案可执行","items":[{"file":"src/routes/books.ts","approved":true,"feedback":""}],"additional_fixes":[]}',
        };
      },
    },
  };

  try {
    const result = await fixPlanNode(
      state,
      agents,
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.repairContracts.length, 1);
    assert.equal(result.repairContracts[0].sprintId, "SP-1");
    assert.deepEqual(result.repairContracts[0].failedChecks, ["CHK-HTTP-1"]);
    assert.deepEqual(result.repairContracts[0].repairScope, [failingFile]);
    assert.deepEqual(result.repairContracts[0].allowedRepairFiles, [failingFile]);
    assert.deepEqual(result.repairContracts[0].suspectedFiles, [failingFile, "src/admin.ts"]);
    assert.deepEqual(result.repairContracts[0].reproSteps, ["GET /api/books"]);
    assert.deepEqual(result.repairContracts[0].rerunChecks, ["CHK-HTTP-1"]);
    assert.match(result.repairContracts[0].instructions[0], /GET \/api\/books/);
    assert.equal(result.subTasks.find((task) => task.fileTarget === failingFile).status, "pending");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("fix plan falls back to deterministic repair plan when model calls are exhausted", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const failingFile = "src/middleware/authMiddleware.ts";
  await fs.mkdir(path.join(workspace, "src", "middleware"), { recursive: true });
  await fs.writeFile(path.join(workspace, failingFile), "export const auth = true;\n", "utf8");

  const state = createBaseState({
    retryCount: 2,
    testResults: "[Coder 阻塞失败]\nCoder 阻塞失败: src/middleware/authMiddleware.ts -> 429",
    qaFailures: {
      failedFiles: [failingFile],
      testErrors: ["Coder 阻塞失败: src/middleware/authMiddleware.ts -> 429"],
      failedTestNames: [],
    },
    issueTracker: [
      {
        id: "BUG-CODER-BLOCK-1",
        title: "src/middleware/authMiddleware.ts 阻塞了本轮生成",
        description: "需要补齐认证中间件实现，并确保不要再次输出非代码文本。",
        severity: "major",
        status: "open",
        relatedFiles: [failingFile],
        detectedRound: 2,
      },
    ],
    subTasks: [
      {
        id: "task-010",
        fileTarget: failingFile,
        description: "实现用户认证的中间件",
        dependencies: ["package.json"],
        contextRequirement: "使用 jsonwebtoken 验证用户 token。",
        status: "failed",
        lastError: "429",
      },
    ],
  });

  const agents = {
    coder: {
      getPersona() {
        return { name: "星河" };
      },
      async chat() {
        throw createRateLimitError();
      },
    },
    qa: {
      getPersona() {
        return { name: "清扬" };
      },
      async chat() {
        throw createRateLimitError();
      },
    },
  };

  try {
    const result = await fixPlanNode(
      state,
      agents,
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.fixPlan.length, 1);
    assert.equal(result.fixPlan[0].fileTarget, failingFile);
    assert.equal(result.fixPlan[0].qaApproval, "approved");
    assert.match(result.fixPlan[0].diagnosis, /阻塞|认证中间件|429/);
    assert.equal(result.subTasks[0].status, "pending");
    assert.equal(recorder.snapshots.at(-1).node, "fix_plan");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("fix plan treats coder timeout as recoverable and still produces deterministic repair plan", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const failingFile = "src/models/book.ts";
  await fs.mkdir(path.join(workspace, "src", "models"), { recursive: true });
  await fs.writeFile(path.join(workspace, failingFile), "export interface Book {}\n", "utf8");

  const state = createBaseState({
    retryCount: 1,
    testResults: "Coder 阻塞失败: src/models/book.ts -> 单文件生成超时",
    qaFailures: {
      failedFiles: [failingFile],
      testErrors: ["Coder 阻塞失败: src/models/book.ts -> 单文件生成超时"],
      failedTestNames: [],
    },
    issueTracker: [
      {
        id: "BUG-CODER-BLOCK-1",
        title: "src/models/book.ts 阻塞了本轮生成",
        description: "模型文件生成超时，需要先收敛为最小可用实体定义。",
        severity: "major",
        status: "open",
        relatedFiles: [failingFile],
        detectedRound: 1,
      },
    ],
    subTasks: [
      {
        id: "task-model",
        fileTarget: failingFile,
        description: "实现图书模型",
        dependencies: [],
        contextRequirement: "定义图书实体",
        status: "failed",
        lastError: "单文件生成超时",
      },
    ],
  });

  const agents = {
    coder: {
      getPersona() {
        return { name: "星河" };
      },
      async chat() {
        throw new AgentTimeoutError("星河", 20000);
      },
    },
    qa: {
      getPersona() {
        return { name: "清扬" };
      },
      async chat() {
        throw new Error("qa should not be called after fallback");
      },
    },
  };

  try {
    const result = await fixPlanNode(
      state,
      agents,
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.fixPlan.length, 1);
    assert.equal(result.fixPlan[0].fileTarget, failingFile);
    assert.equal(result.fixPlan[0].qaApproval, "approved");
    assert.equal(result.subTasks[0].status, "pending");
    assert.equal(recorder.snapshots.at(-1).node, "fix_plan");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("fix plan bypasses llm collaboration when qa already marked static fallback issues", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const failingFile = "src/controllers/bookController.ts";
  await fs.mkdir(path.join(workspace, "src", "controllers"), { recursive: true });
  await fs.writeFile(path.join(workspace, failingFile), "export const x = 1;\n", "utf8");

  const state = createBaseState({
    retryCount: 5,
    testResults: "src/controllers/bookController.ts(41,27): error TS2345: bad type",
    qaFailures: {
      failedFiles: [failingFile],
      testErrors: ["TS2345"],
      failedTestNames: [],
    },
    issueTracker: [
      {
        id: "BUG-COMPILE-1",
        title: "src/controllers/bookController.ts 编译失败",
        description: "TS2345: bad type；QA 模型不可用，已启用静态兜底。",
        severity: "major",
        status: "open",
        relatedFiles: [failingFile],
        detectedRound: 5,
      },
    ],
    subTasks: [
      {
        id: "task-controller",
        fileTarget: failingFile,
        description: "controller",
        dependencies: [],
        contextRequirement: "none",
        status: "failed",
      },
    ],
  });

  const agents = {
    coder: {
      getPersona() {
        return { name: "星河" };
      },
      async chat() {
        throw new Error("coder chat should not be called in static bypass mode");
      },
    },
    qa: {
      getPersona() {
        return { name: "清扬" };
      },
      async chat() {
        throw new Error("qa chat should not be called in static bypass mode");
      },
    },
  };

  try {
    const result = await fixPlanNode(
      state,
      agents,
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.fixPlan.length, 1);
    assert.equal(result.fixPlan[0].fileTarget, failingFile);
    assert.equal(result.fixPlan[0].qaApproval, "approved");
    assert.equal(result.subTasks[0].status, "pending");
    assert.equal(recorder.snapshots.at(-1).node, "fix_plan");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("fix plan uses coding mode for coder and qa collaboration", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const failingFile = "src/middleware/authMiddleware.ts";
  const observedModes = [];
  const observedTimeouts = [];
  await fs.mkdir(path.join(workspace, "src", "middleware"), { recursive: true });
  await fs.writeFile(path.join(workspace, failingFile), "export const auth = true;\n", "utf8");

  const state = createBaseState({
    retryCount: 1,
    testResults: "FAIL tests/auth.test.ts\nToken invalid",
    qaFailures: {
      failedFiles: [failingFile],
      testErrors: ["Token invalid"],
      failedTestNames: [],
    },
    issueTracker: [
      {
        id: "BUG-001",
        title: "auth middleware 测试失败",
        description: "需要修复 token 校验逻辑。",
        severity: "major",
        status: "open",
        relatedFiles: [failingFile],
        detectedRound: 1,
      },
    ],
    subTasks: [
      {
        id: "task-010",
        fileTarget: failingFile,
        description: "实现用户认证的中间件",
        dependencies: ["package.json"],
        contextRequirement: "使用 jsonwebtoken 验证用户 token。",
        status: "failed",
        lastError: "Token invalid",
      },
    ],
  });

  const agents = {
    coder: {
      getPersona() {
        return { name: "星河" };
      },
      async chat(_messages, _onEvent, options) {
        observedModes.push(options?.mode || "");
        observedTimeouts.push(Number(options?.timeoutMs || 0));
        return {
          content: '{"overall_diagnosis":"token 校验逻辑不完整","items":[{"file":"src/middleware/authMiddleware.ts","issue_id":"BUG-001","my_understanding":"缺少 token 校验与 user 注入","proposed_change":"补全 token 解析、校验和 req.user 注入","confidence":"high"}]}',
        };
      },
    },
    qa: {
      getPersona() {
        return { name: "清扬" };
      },
      async chat(_messages, _onEvent, options) {
        observedModes.push(options?.mode || "");
        observedTimeouts.push(Number(options?.timeoutMs || 0));
        return {
          content: '{"overall_assessment":"方案可行","items":[{"file":"src/middleware/authMiddleware.ts","approved":true,"feedback":""}],"additional_fixes":[]}',
        };
      },
    },
  };

  try {
    const result = await fixPlanNode(
      state,
      agents,
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.deepEqual(observedModes, ["coding", "coding"]);
    assert.equal(observedTimeouts.every((value) => value > 0), true);
    assert.equal(result.fixPlan.length, 1);
    assert.equal(result.fixPlan[0].fileTarget, failingFile);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("fix plan backfills missed reopen files from qa failures even when agents only discuss one file", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  await fs.writeFile(path.join(workspace, "package.json"), "{\n  \"name\": \"demo\"\n}\n", "utf8");
  await fs.mkdir(path.join(workspace, "tests"), { recursive: true });
  await fs.writeFile(path.join(workspace, "tests", "books.test.ts"), "describe('books', () => {});\n", "utf8");

  const state = createBaseState({
    retryCount: 3,
    testResults: "FAIL tests/books.test.ts\nCannot find module 'express' from src/app.ts",
    qaFailures: {
      failedFiles: ["tests/books.test.ts", "package.json"],
      testErrors: ["依赖缺失：package.json 中缺少 express"],
      failedTestNames: [],
    },
    issueTracker: [
      {
        id: "BUG-001",
        title: "依赖缺失导致测试失败",
        description: "package.json 中缺少 express 运行时依赖，tests/books.test.ts 因此失败。",
        severity: "major",
        status: "open",
        relatedFiles: ["tests/books.test.ts", "package.json"],
        detectedRound: 3,
      },
    ],
    subTasks: [
      {
        id: "task-package",
        fileTarget: "package.json",
        description: "配置依赖",
        dependencies: [],
        contextRequirement: "声明运行时依赖",
        status: "completed",
      },
      {
        id: "task-books-test",
        fileTarget: "tests/books.test.ts",
        description: "图书测试",
        dependencies: ["package.json"],
        contextRequirement: "验证图书接口",
        status: "completed",
      },
    ],
  });

  const agents = {
    coder: {
      getPersona() {
        return { name: "星河" };
      },
      async chat() {
        return {
          content: '{"overall_diagnosis":"测试文件直接暴露了依赖缺失问题","items":[{"file":"tests/books.test.ts","issue_id":"BUG-001","my_understanding":"需要修正测试用例以匹配当前服务入口","proposed_change":"更新 tests/books.test.ts 的导入和断言","confidence":"medium"}]}',
        };
      },
    },
    qa: {
      getPersona() {
        return { name: "清扬" };
      },
      async chat() {
        return {
          content: '{"overall_assessment":"测试文件方案不完整，还需要补齐配置文件，但这里先保持原样输出","items":[{"file":"tests/books.test.ts","approved":true,"feedback":""}],"additional_fixes":[]}',
        };
      },
    },
  };

  try {
    const result = await fixPlanNode(
      state,
      agents,
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.fixPlan.some((item) => item.fileTarget === "tests/books.test.ts"), true);
    assert.equal(result.fixPlan.some((item) => item.fileTarget === "package.json"), true);
    assert.equal(result.subTasks.find((task) => task.fileTarget === "package.json").status, "pending");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("fix plan can parse conversational json code blocks without collapsing into empty plans", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const failingFile = "src/routes/books.ts";
  await fs.mkdir(path.join(workspace, "src", "routes"), { recursive: true });
  await fs.writeFile(path.join(workspace, failingFile), "export default {};\n", "utf8");

  const state = createBaseState({
    retryCount: 3,
    testResults: "[Coder 阻塞失败]\nCoder 阻塞失败: src/routes/books.ts -> contract drift",
    qaFailures: {
      failedFiles: [failingFile],
      testErrors: ["Coder 阻塞失败: src/routes/books.ts -> contract drift"],
      failedTestNames: [],
    },
    issueTracker: [
      {
        id: "BUG-CODER-BLOCK-1",
        title: "src/routes/books.ts 阻塞了本轮生成",
        description: "路由文件与控制器命名导出契约不一致。",
        severity: "major",
        status: "open",
        relatedFiles: [failingFile],
        detectedRound: 3,
      },
    ],
    subTasks: [
      {
        id: "task-route",
        fileTarget: failingFile,
        description: "实现图书路由",
        dependencies: [],
        contextRequirement: "保持命名导出与控制器一致",
        status: "failed",
        lastError: "contract drift",
      },
    ],
  });

  const agents = {
    coder: {
      getPersona() {
        return { name: "星河" };
      },
      async chat() {
        return {
          content: `现在我完全理解了问题的根因。让我输出修复计划：

\`\`\`json
{
  "overall_diagnosis": "路由层引用的控制器命名导出与现有实现不一致",
  "items": [
    {
      "file": "src/routes/books.ts",
      "issue_id": "BUG-CODER-BLOCK-1",
      "my_understanding": "当前路由文件需要对齐控制器导出名称",
      "proposed_change": "更新 routes/books.ts 的导入与绑定，使用控制器中实际存在的导出或新增别名导出",
      "confidence": "high"
    }
  ]
}
\`\`\``,
        };
      },
    },
    qa: {
      getPersona() {
        return { name: "清扬" };
      },
      async chat() {
        return {
          content: '{"overall_assessment":"方案可执行","items":[{"file":"src/routes/books.ts","approved":true,"feedback":""}],"additional_fixes":[]}',
        };
      },
    },
  };

  try {
    const result = await fixPlanNode(
      state,
      agents,
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.fixPlan.length, 1);
    assert.equal(result.fixPlan[0].fileTarget, failingFile);
    assert.match(result.fixPlan[0].diagnosis, /命名导出|控制器/);
    assert.match(result.fixPlan[0].proposedChange, /routes\/books\.ts/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("fix plan emits protocol patches alongside approved file fixes", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const failingFile = "src/routes/users.ts";
  await fs.mkdir(path.join(workspace, "src", "routes"), { recursive: true });
  await fs.writeFile(path.join(workspace, failingFile), "export default {};\n", "utf8");

  const state = createBaseState({
    retryCount: 1,
    executionProtocol: {
      version: "v1",
      project: {
        language: "TypeScript",
        framework: "Express",
        runtime: "node",
        workspaceLayout: {
          sourceRoots: ["src"],
          testRoots: ["tests"],
          entryFiles: ["src/index.ts"],
          configFiles: ["package.json"],
          infraFiles: [],
        },
      },
      contracts: {
        api: {
          endpoints: [{ method: "GET", path: "/api/users" }],
        },
        files: {
          [failingFile]: {
            role: "route",
            allowedDependencyRoles: ["controller", "service", "middleware", "model", "other"],
            ownedEndpoints: [],
          },
        },
      },
      runtime: {},
      workflow: { blockingRules: [], recoveryRules: [] },
      validation: { layoutRules: [], dependencyRules: [], runtimeRules: [], acceptanceRules: [] },
    },
    apiContract: {
      endpoints: [{ method: "GET", path: "/api/users", description: "list users" }],
    },
    qaFailures: {
      failedFiles: [failingFile],
      testErrors: ["route drift"],
      failedTestNames: [],
    },
    issueTracker: [
      {
        id: "BUG-ROUTE-1",
        title: "users route drift",
        description: "route endpoint ownership drift",
        severity: "major",
        status: "open",
        relatedFiles: [failingFile],
        detectedRound: 1,
      },
    ],
    subTasks: [
      {
        id: "task-route",
        fileTarget: failingFile,
        description: "实现 users route",
        dependencies: [],
        contextRequirement: "none",
        status: "failed",
      },
    ],
  });

  const agents = {
    coder: {
      getPersona() { return { name: "星河" }; },
      async chat() {
        return {
          content: '{"overall_diagnosis":"route drift","items":[{"file":"src/routes/users.ts","issue_id":"BUG-ROUTE-1","my_understanding":"users route should own GET /api/users","proposed_change":"align route with contract","confidence":"high"}]}',
        };
      },
    },
    qa: {
      getPersona() { return { name: "清扬" }; },
      async chat() {
        return {
          content: '{"overall_assessment":"可执行","items":[{"file":"src/routes/users.ts","approved":true,"feedback":""}],"additional_fixes":[]}',
        };
      },
    },
  };

  try {
    const result = await fixPlanNode(
      state,
      agents,
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(Array.isArray(result.protocolPatches), true);
    assert.equal(result.protocolPatches.length > 0, true);
    assert.equal(result.protocolPatches[0].target, "contracts");
    assert.match(result.protocolPatches[0].path, /ownedEndpoints/);
    assert.deepEqual(
      result.executionProtocol.contracts.files[failingFile].ownedEndpoints,
      ["GET /api/users"]
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("fix plan skips implementation planning when repair plan is non-implementation", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();

  const state = createBaseState({
    retryCount: 3,
    repairPlan: {
      version: "v1",
      repairType: "planning",
      targets: ["src/routes/products.ts"],
      allowedEdits: ["src/routes/products.ts"],
      expectedEvidence: ["缺少 route 规划"],
    },
    qaFailures: {
      failedFiles: ["src/routes/products.ts"],
      testErrors: ["缺少 route 规划"],
      failedTestNames: [],
    },
    issueTracker: [
      {
        id: "BUG-PROTOCOL-1",
        title: "route 规划缺失",
        description: "backendRequired 但没有 route 任务",
        severity: "major",
        status: "open",
        relatedFiles: ["src/routes/products.ts"],
        detectedRound: 3,
      },
    ],
  });

  try {
    const result = await fixPlanNode(
      state,
      {
        coder: {
          getPersona() { return { name: "星河" }; },
          async chat() {
            throw new Error("coder chat should not be called for planning repair");
          },
        },
        qa: {
          getPersona() { return { name: "清扬" }; },
          async chat() {
            throw new Error("qa chat should not be called for planning repair");
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.deepEqual(result.fixPlan, []);
    assert.equal(recorder.snapshots.at(-1).node, "fix_plan");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("fix plan trims oversized test output and file context before sending prompts", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const failingFile = "src/routes/products.ts";
  await fs.mkdir(path.join(workspace, "src", "routes"), { recursive: true });
  await fs.writeFile(path.join(workspace, failingFile), "export default {};\n" + "x".repeat(6000), "utf8");
  const longTestOutput = "FAIL tests/products.test.ts\n" + "E".repeat(12000);
  const observedPrompts = [];

  const state = createBaseState({
    retryCount: 1,
    testResults: longTestOutput,
    qaFailures: {
      failedFiles: [failingFile],
      testErrors: ["route drift"],
      failedTestNames: [],
    },
    issueTracker: [
      {
        id: "BUG-ROUTE-TRIM-1",
        title: "products route drift",
        description: "需要基于接口契约修正产品路由与测试。",
        severity: "major",
        status: "open",
        relatedFiles: [failingFile],
        detectedRound: 1,
      },
    ],
    subTasks: [
      {
        id: "task-products-route",
        fileTarget: failingFile,
        description: "实现 products route",
        dependencies: [],
        contextRequirement: "none",
        status: "failed",
      },
    ],
  });

  const agents = {
    coder: {
      getPersona() { return { name: "星河" }; },
      async chat(messages) {
        observedPrompts.push(messages[0].content);
        return {
          content: '{"overall_diagnosis":"route drift","items":[{"file":"src/routes/products.ts","issue_id":"BUG-ROUTE-TRIM-1","my_understanding":"products route should own GET /api/products","proposed_change":"align route with contract","confidence":"high"}]}',
        };
      },
    },
    qa: {
      getPersona() { return { name: "清扬" }; },
      async chat(messages) {
        observedPrompts.push(messages[0].content);
        return {
          content: '{"overall_assessment":"方案可行","items":[{"file":"src/routes/products.ts","approved":true,"feedback":""}],"additional_fixes":[]}',
        };
      },
    },
  };

  try {
    await fixPlanNode(
      state,
      agents,
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(observedPrompts.length, 2);
    assert.match(observedPrompts[0], /\[已截断 \d+ 字符]/);
    assert.match(observedPrompts[1], /\[已截断 \d+ 字符]/);
    assert.ok(observedPrompts[0].length < 8000);
    assert.ok(observedPrompts[1].length < 8000);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("fix plan derives repair targets from blocking protocol failures when issue tracker is empty", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const failingFile = "tests/user.test.ts";
  await fs.mkdir(path.join(workspace, "tests"), { recursive: true });
  await fs.writeFile(path.join(workspace, failingFile), "describe('user', () => {});\n", "utf8");

  const state = createBaseState({
    retryCount: 2,
    qaFailures: {
      failedFiles: [failingFile],
      testErrors: ["声明的业务测试未被 Jest roots 覆盖"],
      failedTestNames: [],
    },
    protocolFailures: [
      {
        type: "test_discovery_gap",
        node: "verifier",
        file: failingFile,
        summary: "声明的业务测试未被 Jest roots 覆盖",
        evidence: ["roots=tests", "declared=tests/user.test.ts"],
        blocking: true,
      },
    ],
    issueTracker: [],
    subTasks: [
      {
        id: "task-test",
        fileTarget: failingFile,
        description: "实现 user 测试",
        dependencies: [],
        contextRequirement: "none",
        status: "failed",
      },
    ],
  });

  const agents = {
    coder: {
      getPersona() { return { name: "星河" }; },
      async chat() {
        return {
          content: '{"overall_diagnosis":"测试目录与 Jest roots 错位","items":[{"file":"tests/user.test.ts","issue_id":"BUG-PROTOCOL-1","my_understanding":"测试文件已声明但未被测试发现","proposed_change":"统一测试文件位置与 Jest roots","confidence":"high"}]}',
        };
      },
    },
    qa: {
      getPersona() { return { name: "清扬" }; },
      async chat() {
        return {
          content: '{"overall_assessment":"可执行","items":[{"file":"tests/user.test.ts","approved":true,"feedback":""}],"additional_fixes":[]}',
        };
      },
    },
  };

  try {
    const result = await fixPlanNode(
      state,
      agents,
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.fixPlan.length, 1);
    assert.equal(result.fixPlan[0].fileTarget, failingFile);
    assert.match(result.fixPlan[0].diagnosis, /Jest roots|测试/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
