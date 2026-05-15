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

test("sprint contract includes transitive task dependencies even when spec omitted them", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();

  try {
    const result = await sprintContractNode(
      createBaseState({
        activeSprintId: "SP-1",
        sprintPlans: [{
          id: "SP-1",
          title: "可运行骨架",
          goal: "启动服务并提供首页",
          userStoryIds: ["US-1"],
          acceptanceCriteriaIds: ["AC-1"],
          deliverables: ["服务入口"],
          allowedScope: ["package.json", "src/", "tests/"],
          dependencies: [],
          estimatedComplexity: "small",
          doneWhen: ["服务可启动"],
        }],
        apiContract: { endpoints: [{ path: "/api/books", method: "GET", description: "列表" }] },
        spec: {
          language: "TypeScript",
          framework: "Express",
          testCommand: "npm test",
          filesToCreate: ["package.json", "src/index.ts", "tests/books.test.ts"],
        },
        subTasks: [
          {
            id: "task-package",
            description: "pkg",
            fileTarget: "package.json",
            dependencies: [],
            contextRequirement: "",
            status: "pending",
          },
          {
            id: "task-ui",
            description: "ui",
            fileTarget: "public/index.html",
            dependencies: [],
            contextRequirement: "",
            status: "pending",
          },
          {
            id: "task-entry",
            description: "entry",
            fileTarget: "src/index.ts",
            dependencies: ["package.json", "public/index.html"],
            contextRequirement: "",
            status: "pending",
          },
          {
            id: "task-test",
            description: "test",
            fileTarget: "tests/books.test.ts",
            dependencies: ["src/index.ts"],
            contextRequirement: "",
            status: "pending",
          },
        ],
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    const allowedFiles = result.sprintContracts[0].agreedScope.allowedFiles;
    assert.equal(allowedFiles.includes("src/index.ts"), true);
    assert.equal(allowedFiles.includes("tests/books.test.ts"), true);
    assert.equal(allowedFiles.includes("public/index.html"), true);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("sprint contract derives semantic assertions for low stock filter checks", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();

  try {
    const result = await sprintContractNode(
      createBaseState({
        activeSprintId: "SP-2",
        productSpec: {
          version: "v1",
          title: "库存看板",
          userGoal: "查看商品库存",
          userStories: [{ id: "US-1", story: "用户可以查看库存", priority: "must" }],
          acceptanceCriteria: [
            { id: "AC-1", description: "启动应用后，GET /api/products 返回 HTTP 200，响应体为数组，数组元素至少包含 id、name、stock 字段。", verificationKind: "api" },
            { id: "AC-2", description: "启动应用后，当请求 GET /api/products?lowStock=true 时返回 HTTP 200，响应结果仅包含低库存商品，且每个商品的 status 必须标识为低库存。", verificationKind: "api" },
          ],
          nonGoals: [],
        },
        sprintPlans: [{
          id: "SP-2",
          title: "库存 API 闭环",
          goal: "完成库存列表与低库存筛选",
          userStoryIds: ["US-1"],
          acceptanceCriteriaIds: ["AC-1", "AC-2"],
          deliverables: ["库存 API", "低库存筛选"],
          allowedScope: ["src/", "tests/"],
          dependencies: ["SP-1"],
          estimatedComplexity: "medium",
          doneWhen: [
            "启动应用后，GET /api/products 返回 HTTP 200，响应体为数组，数组元素至少包含 id、name、stock 字段。",
            "启动应用后，当请求 GET /api/products?lowStock=true 时返回 HTTP 200，响应结果仅包含低库存商品，且每个商品的 status 必须标识为低库存。",
          ],
        }],
        apiContract: { endpoints: [{ path: "/api/products", method: "GET", description: "商品库存列表" }] },
        spec: {
          language: "TypeScript",
          framework: "Express",
          testCommand: "npm test",
          filesToCreate: ["src/app.ts", "tests/products.test.ts"],
        },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    const checks = result.sprintContracts[0].evaluatorPlan.checks;
    const baseCheck = checks.find((check) => check.url === "/api/products");
    const lowStockCheck = checks.find((check) => check.url === "/api/products?lowStock=true");

    assert.ok(baseCheck);
    assert.ok(lowStockCheck);
    assert.equal(baseCheck.assertions.some((item) => item.type === "jsonArray"), true);
    assert.equal(baseCheck.assertions.some((item) => item.type === "jsonFieldExists" && item.field === "stock"), true);
    assert.equal(lowStockCheck.assertions.some((item) => item.type === "jsonEvery" && item.field === "stock" && item.operator === "lt"), true);
    assert.equal(lowStockCheck.assertions.some((item) => item.type === "jsonFieldExists" && item.field === "status"), true);
    assert.equal(lowStockCheck.assertions.some((item) => item.type === "jsonFieldExists" && item.field === "id"), false);
    assert.equal(lowStockCheck.assertions.some((item) => item.type === "jsonFieldExists" && item.field === "lowStock"), false);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("sprint contract does not apply product semantic assertions to health checks", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();

  try {
    const result = await sprintContractNode(
      createBaseState({
        activeSprintId: "SP-2",
        productSpec: {
          version: "v1",
          title: "库存看板",
          userGoal: "查看商品库存",
          userStories: [{ id: "US-1", story: "用户可以查看库存", priority: "must" }],
          acceptanceCriteria: [
            { id: "AC-1", description: "启动服务后，请求 GET /api/products 返回 200 状态码，响应体为 JSON 数组，数组元素至少包含 name、sku、stock、status 字段。", verificationKind: "api" },
            { id: "AC-2", description: "项目包含可执行的自动化测试脚本，执行后能够验证 /api/products、/products 以及 lowStock=true 筛选行为并返回通过结果。", verificationKind: "unit" },
          ],
          nonGoals: [],
        },
        sprintPlans: [{
          id: "SP-2",
          title: "库存 API 闭环",
          goal: "完成库存列表与低库存筛选",
          userStoryIds: ["US-1"],
          acceptanceCriteriaIds: ["AC-1", "AC-2"],
          deliverables: ["库存 API", "低库存筛选"],
          allowedScope: ["src/", "tests/", "public/"],
          dependencies: ["SP-1"],
          estimatedComplexity: "medium",
          doneWhen: [
            "启动服务后，请求 GET /api/products 返回 200 状态码，响应体为 JSON 数组，数组元素至少包含 name、sku、stock、status 字段。",
            "项目包含可执行的自动化测试脚本，执行后能够验证 /api/products、/products 以及 lowStock=true 筛选行为并返回通过结果。",
          ],
        }],
        apiContract: {
          endpoints: [
            { path: "/api/health", method: "GET", description: "健康检查" },
            { path: "/api/products", method: "GET", description: "商品库存列表" },
            { path: "/products", method: "GET", description: "商品库存页面" },
          ],
        },
        spec: {
          language: "TypeScript",
          framework: "Express",
          testCommand: "npm test",
          filesToCreate: ["src/index.ts", "tests/products.test.ts", "public/index.html"],
        },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    const checks = result.sprintContracts[0].evaluatorPlan.checks;
    const healthCheck = checks.find((check) => check.url === "/api/health");
    const productsCheck = checks.find((check) => check.url === "/api/products");

    assert.ok(healthCheck);
    assert.equal(healthCheck.assertions, undefined);
    assert.equal(productsCheck.assertions.some((item) => item.type === "jsonFieldExists" && item.field === "status"), true);
    assert.equal(productsCheck.assertions.some((item) => item.type === "jsonFieldExists" && item.field === "lowStock"), false);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("sprint contract node advances to the next runnable sprint after current sprint passes", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();

  try {
    const result = await sprintContractNode(
      createBaseState({
        activeSprintId: "SP-1",
        sprintPlans: [
          {
            id: "SP-1",
            title: "基础骨架",
            goal: "基础验证通过",
            userStoryIds: ["US-1"],
            acceptanceCriteriaIds: ["AC-1"],
            deliverables: ["骨架"],
            allowedScope: ["src/"],
            dependencies: [],
            estimatedComplexity: "small",
            doneWhen: ["测试通过"],
          },
          {
            id: "SP-2",
            title: "核心路径",
            goal: "完成用户路径",
            userStoryIds: ["US-1"],
            acceptanceCriteriaIds: ["AC-2"],
            deliverables: ["页面"],
            allowedScope: ["src/", "public/"],
            dependencies: ["SP-1"],
            estimatedComplexity: "medium",
            doneWhen: ["页面可访问"],
          },
        ],
        evaluationResults: [{
          sprintId: "SP-1",
          status: "pass",
          summary: "SP-1 通过",
          checks: [],
          missingEvidence: [],
        }],
        spec: {
          language: "TypeScript",
          framework: "Express",
          testCommand: "npm test",
          filesToCreate: ["src/index.ts", "public/index.html"],
        },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.activeSprintId, "SP-2");
    assert.equal(result.sprintContracts[0].sprintId, "SP-2");
  } finally {
    await removeTempWorkspace(workspace);
  }
});
