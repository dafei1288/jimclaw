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
const { AgentTimeoutError } = require("../../src/core/agent");

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

test("orchestrator injected frontend task follows GET-only API contract", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const requirementProtocol = buildRequirementProtocol({
    title: "商品目录应用",
    requirements: ["需要前端页面", "提供商品列表 API GET /api/products"],
    acceptanceCriteria: ["页面展示商品列表。"],
  });
  const state = createBaseState({
    requirementProtocol,
    spec: {
      language: "TypeScript",
      testCommand: "npm test",
      entryPoint: "src/index.ts",
      filesToCreate: ["package.json", "src/index.ts", "public/index.html", "tests/products.test.ts"],
    },
    manifest: { services: [{ name: "api", port: 10000 }], environment: {}, sharedConfig: {} },
    apiContract: { endpoints: [{ method: "GET", path: "/api/products", description: "商品列表" }] },
  });
  state.executionProtocol = buildExecutionProtocol(state.spec, state.manifest, state.apiContract, requirementProtocol);

  const agent = createPmAgent(JSON.stringify([
    { id: "task-1", fileTarget: "src/index.ts", description: "入口", dependencies: [], contextRequirement: "启动服务" },
    { id: "task-2", fileTarget: "tests/products.test.ts", description: "测试", dependencies: ["src/index.ts"], contextRequirement: "业务测试" },
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

    const frontendTask = result.subTasks.find((task) => task.fileTarget === "public/index.html");
    assert.ok(frontendTask);
    assert.match(frontendTask.contextRequirement, /API 契约/);
    assert.doesNotMatch(frontendTask.contextRequirement, /新增|编辑|删除/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("orchestrator normalizes aliased task graph and keeps simple CRUD plan within budget", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const requirementProtocol = buildRequirementProtocol({
    title: "图书管理系统",
    requirements: [
      "实现一个图书管理系统：包含前端页面和后端 API",
      "支持图书列表、添加图书、借阅/归还状态切换",
      "提供 /api/health 健康检查",
      "必须带基础测试与 Docker 部署",
      "需要基础权限管理和审计日志",
    ],
    acceptanceCriteria: ["界面可直接在浏览器访问"],
  });
  const state = createBaseState({
    requirementProtocol,
    spec: {
      language: "TypeScript",
      framework: "Express.js ^4.18",
      testCommand: "vitest run",
      runCommand: "npm start",
      entryPoint: "src/index.ts",
      filesToCreate: [
        "package.json",
        "tsconfig.json",
        ".env.example",
        "README.md",
        "Dockerfile",
        "docker-compose.yml",
        "vitest.config.ts",
        "src/index.ts",
        "src/app.ts",
        "src/public/index.html",
        "src/public/styles.css",
        "src/public/app.js",
        "public/index.html",
        "src/routes/book-routes.ts",
        "src/routes/books.ts",
        "src/controllers/book-controller.ts",
        "src/controllers/bookController.ts",
        "src/services/book-service.ts",
        "src/services/bookService.ts",
        "src/models/book.ts",
        "src/repositories/book-repository.ts",
        "src/middleware/authenticate.ts",
        "src/routes/auth.ts",
        "src/logging/logger.ts",
        "src/errors.ts",
        "src/scripts/verify.ts",
        "tests/health.test.ts",
        "tests/books.test.ts",
        "tests/auth.test.ts",
        "jest.config.cjs",
        "tests/setup.test.ts",
      ],
    },
    manifest: { services: [{ name: "api", port: 10000 }], environment: {}, sharedConfig: {} },
    apiContract: {
      endpoints: [
        { method: "GET", path: "/api/health", description: "健康检查" },
        { method: "GET", path: "/api/books", description: "图书列表" },
        { method: "POST", path: "/api/books", description: "新增图书" },
      ],
    },
  });
  state.executionProtocol = buildExecutionProtocol(state.spec, state.manifest, state.apiContract, requirementProtocol);

  const agent = createPmAgent(JSON.stringify([
    { id: "task-1", fileTarget: "src/public/index.html", description: "前端页面", dependencies: [], contextRequirement: "前端页面" },
    { id: "task-2", fileTarget: "src/routes/book-routes.ts", description: "图书路由", dependencies: [], contextRequirement: "图书路由" },
    { id: "task-3", fileTarget: "src/routes/books.ts", description: "图书路由别名", dependencies: [], contextRequirement: "图书路由" },
    { id: "task-4", fileTarget: "src/controllers/book-controller.ts", description: "控制器", dependencies: ["src/routes/book-routes.ts"], contextRequirement: "控制器" },
    { id: "task-5", fileTarget: "src/controllers/bookController.ts", description: "控制器别名", dependencies: ["src/routes/books.ts"], contextRequirement: "控制器" },
    { id: "task-6", fileTarget: "src/services/book-service.ts", description: "服务", dependencies: ["src/controllers/book-controller.ts"], contextRequirement: "服务" },
    { id: "task-7", fileTarget: "src/services/bookService.ts", description: "服务别名", dependencies: ["src/controllers/bookController.ts"], contextRequirement: "服务" },
    { id: "task-8", fileTarget: "jest.config.cjs", description: "Jest 配置", dependencies: ["package.json"], contextRequirement: "测试配置" },
    { id: "task-9", fileTarget: "tests/setup.test.ts", description: "Jest 冒烟测试", dependencies: ["jest.config.cjs"], contextRequirement: "测试配置" },
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

    const fileTargets = result.subTasks.map((task) => task.fileTarget);
    assert.equal(fileTargets.includes("src/public/index.html"), false);
    assert.equal(fileTargets.includes("src/routes/book-routes.ts"), false);
    assert.equal(fileTargets.includes("src/controllers/book-controller.ts"), false);
    assert.equal(fileTargets.includes("src/services/book-service.ts"), false);
    assert.equal(fileTargets.includes("jest.config.cjs"), false);
    assert.equal(fileTargets.includes("tests/setup.test.ts"), false);
    assert.equal(fileTargets.includes("public/index.html"), true);
    assert.equal(fileTargets.includes("src/routes/books.ts"), true);
    assert.equal(fileTargets.includes("src/controllers/bookController.ts"), true);
    assert.equal(fileTargets.includes("src/services/bookService.ts"), true);
    assert.equal(fileTargets.includes("src/services/bookQueryService.ts"), true);
    assert.equal(fileTargets.includes("src/services/bookMutationService.ts"), true);
    assert.equal(fileTargets.includes("src/services/bookInventoryService.ts"), true);
    assert.equal(fileTargets.includes("src/services/authSessionService.ts"), true);
    assert.equal(fileTargets.includes("src/services/authCredentialService.ts"), true);
    assert.equal(fileTargets.includes("src/services/authAccountPolicyService.ts"), true);
    assert.equal(fileTargets.length <= 30, true);
    assert.equal(result.validationReport.status, "pass");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("orchestrator falls back to deterministic subtasks on recoverable agent timeout", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const requirementProtocol = buildRequirementProtocol({
    title: "图书管理系统",
    requirements: ["实现图书管理系统，包含前端页面、后端 API、测试与 Docker 部署"],
    acceptanceCriteria: ["用户可以查看图书列表"],
  });
  const state = createBaseState({
    requirementProtocol,
    spec: {
      language: "TypeScript",
      framework: "Express.js ^5.0",
      testCommand: "npm test",
      runCommand: "npm start",
      entryPoint: "src/index.ts",
      filesToCreate: [
        "package.json",
        "tsconfig.json",
        "src/index.ts",
        "src/routes/books.ts",
        "src/controllers/bookController.ts",
        "src/services/bookService.ts",
        "src/models/book.ts",
        "public/index.html",
        "tests/books.test.ts",
      ],
    },
    manifest: { services: [{ name: "api", port: 10000 }], environment: {}, sharedConfig: {} },
    apiContract: {
      endpoints: [
        { method: "GET", path: "/api/books", description: "图书列表" },
        { method: "POST", path: "/api/books", description: "新增图书" },
      ],
    },
  });
  state.executionProtocol = buildExecutionProtocol(state.spec, state.manifest, state.apiContract, requirementProtocol);

  const agent = {
    getPersona() {
      return { name: "测试PM" };
    },
    async chat() {
      throw new AgentTimeoutError("测试PM", 10);
    },
  };

  try {
    const result = await orchestratorNode(
      state,
      { pm: agent },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    const fileTargets = result.subTasks.map((task) => task.fileTarget);
    assert.equal(fileTargets.includes("package.json"), true);
    assert.equal(fileTargets.includes("src/index.ts"), true);
    assert.equal(fileTargets.includes("public/index.html"), true);
    assert.equal(recorder.snapshots.length, 1);
    assert.equal(recorder.snapshots[0].node, "orchestrator");
  } finally {
    await removeTempWorkspace(workspace);
  }
});
