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
const { orchestratorNode } = require("../../src/core/nodes/orchestrator_node");
const { buildRequirementProtocol, buildExecutionProtocol } = require("../../src/core/logic_utils");

function createPmAgent(response) {
  return {
    getPersona() {
      return { name: "测试PM" };
    },
    async chat() {
      return { content: response };
    },
  };
}

test("orchestrator emits execution plan when task graph covers frontend and backend roles", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const requirementProtocol = buildRequirementProtocol({
    title: "电器销售系统",
    requirements: ["需要前端页面和后端 API"],
    acceptanceCriteria: ["用户可以在前端管理商品"],
  });
  const state = createBaseState({
    requirementProtocol,
    spec: {
      language: "TypeScript",
      testCommand: "npm test",
      entryPoint: "src/index.ts",
      filesToCreate: [
        "package.json",
        "tsconfig.json",
        "src/index.ts",
        "src/routes/products.ts",
        "src/controllers/productController.ts",
        "src/services/productService.ts",
        "src/models/productModel.ts",
        "public/index.html",
        "tests/products.test.ts",
      ],
    },
    manifest: { services: [{ name: "api", port: 10000 }], environment: {}, sharedConfig: {} },
    apiContract: { endpoints: [{ method: "GET", path: "/api/products", description: "商品列表" }] },
  });
  state.executionProtocol = buildExecutionProtocol(state.spec, state.manifest, state.apiContract, requirementProtocol);

  const agent = createPmAgent(JSON.stringify([
    { id: "task-1", fileTarget: "src/models/productModel.ts", description: "模型", dependencies: [], contextRequirement: "模型定义" },
    { id: "task-2", fileTarget: "src/services/productService.ts", description: "服务", dependencies: ["src/models/productModel.ts"], contextRequirement: "服务逻辑" },
    { id: "task-3", fileTarget: "src/controllers/productController.ts", description: "控制器", dependencies: ["src/services/productService.ts"], contextRequirement: "控制器逻辑" },
    { id: "task-4", fileTarget: "src/routes/products.ts", description: "路由", dependencies: ["src/controllers/productController.ts"], contextRequirement: "路由挂载" },
    { id: "task-5", fileTarget: "src/index.ts", description: "入口", dependencies: ["src/routes/products.ts"], contextRequirement: "挂载服务" },
    { id: "task-6", fileTarget: "public/index.html", description: "前端页面", dependencies: ["src/index.ts"], contextRequirement: "前端页面" },
    { id: "task-7", fileTarget: "tests/products.test.ts", description: "测试", dependencies: ["src/index.ts"], contextRequirement: "业务测试" },
  ]));

  try {
    const result = await orchestratorNode(
      state,
      { pm: agent },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );
    assert.equal(result.executionPlan.tasks.length >= 7, true);
    assert.equal(result.validationReport.status, "pass");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("orchestrator backfills incomplete task graph into executable plan", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const requirementProtocol = buildRequirementProtocol({
    title: "电器销售系统",
    requirements: ["需要前端页面和后端 API"],
    acceptanceCriteria: ["用户可以在前端管理商品"],
  });
  const state = createBaseState({
    requirementProtocol,
    spec: {
      language: "TypeScript",
      testCommand: "npm test",
      entryPoint: "src/index.ts",
      filesToCreate: ["package.json", "src/index.ts", "public/index.html"],
    },
    manifest: { services: [{ name: "api", port: 10000 }], environment: {}, sharedConfig: {} },
    apiContract: { endpoints: [] },
  });
  state.executionProtocol = buildExecutionProtocol(state.spec, state.manifest, state.apiContract, requirementProtocol);

  const agent = createPmAgent(JSON.stringify([
    { id: "task-1", fileTarget: "public/index.html", description: "前端页面", dependencies: [], contextRequirement: "前端页面" },
    { id: "task-2", fileTarget: "src/models/product.ts", description: "模型", dependencies: [], contextRequirement: "商品模型" },
    { id: "task-3", fileTarget: "src/services/productService.ts", description: "服务", dependencies: ["src/models/product.ts"], contextRequirement: "商品服务" },
    { id: "task-4", fileTarget: "src/controllers/productController.ts", description: "控制器", dependencies: ["src/services/productService.ts"], contextRequirement: "商品控制器" },
    { id: "task-5", fileTarget: "src/routes/products.ts", description: "路由", dependencies: ["src/controllers/productController.ts"], contextRequirement: "商品路由" },
    { id: "task-6", fileTarget: "src/index.ts", description: "入口", dependencies: ["src/routes/products.ts"], contextRequirement: "启动服务" },
  ]));

  try {
    const result = await orchestratorNode(
      state,
      { pm: agent },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );
    assert.equal(result.validationReport.status, "pass");
    assert.equal(result.executionPlan.tasks.some((task) => task.role === "route"), true);
    assert.equal(result.executionPlan.tasks.some((task) => task.role === "test"), true);
    assert.equal(result.executionPlan.tasks.some((task) => task.role === "ui"), true);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
