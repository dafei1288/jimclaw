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

function createRateLimitError(message = "429 余额不足或无可用资源包,请充值。") {
  const error = new Error(message);
  error.status = 429;
  return error;
}

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

test("fix plan uses coding mode for coder and qa collaboration", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const failingFile = "src/middleware/authMiddleware.ts";
  const observedModes = [];
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
    assert.equal(result.fixPlan.length, 1);
    assert.equal(result.fixPlan[0].fileTarget, failingFile);
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
