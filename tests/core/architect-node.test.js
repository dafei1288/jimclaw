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
const { architectNode } = require("../../src/core/nodes/architect_node");
const { AgentTimeoutError } = require("../../src/core/agent");
const { buildCustomerApprovalState } = require("../../src/core/logic_utils");

function createArchitectAgent(responses) {
  let index = 0;
  return {
    getPersona() {
      return { name: "测试架构师" };
    },
    async chat() {
      const content = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return { content };
    },
  };
}

test("architect emits technology decision on covered plan", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    contract: {
      title: "电器销售系统",
      requirements: ["需要前后端页面和后端 API"],
      acceptanceCriteria: ["用户可以在前端管理商品"],
    },
  });
  const agent = createArchitectAgent([
    JSON.stringify({
      spec: {
        architecture: "Express 全栈单体",
        language: "TypeScript",
        framework: "Express.js ^4.18",
        testCommand: "npm test",
        runCommand: "npm start",
        entryPoint: "src/index.ts",
        filesToCreate: [
          "package.json",
          "tsconfig.json",
          "src/index.ts",
          "src/routes/products.ts",
          "public/index.html",
          "tests/products.test.ts",
        ],
        interfaces: "REST API",
        dependencies: { express: "^4.18.2" },
        devDependencies: { typescript: "^5.0.0", jest: "^29.7.0", "ts-jest": "^29.1.1" },
      },
      manifest: {
        services: [{ name: "api", port: 10000, description: "api" }],
        environment: {},
        sharedConfig: {},
      },
      apiContract: {
        endpoints: [{ path: "/api/products", method: "GET", description: "商品列表" }],
      },
    }),
    "# README",
  ]);

  try {
    const result = await architectNode(
      state,
      { architect: agent },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.technologyDecision.backend.framework, "express-typescript");
    assert.equal(result.validationReport.status, "pass");
    assert.equal(result.solutionProtocol.coverage.coverageMatrix.length > 0, true);
    const specJson = JSON.parse(await fs.readFile(path.join(workspace, "spec.json"), "utf-8"));
    assert.equal(specJson.entryPoint, "src/index.ts");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("architect preserves previously approved requirements checkpoint", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const customerApprovalState = buildCustomerApprovalState({
    autoApprove: { requirements: false, solution: false, deploy: false },
    summaries: { requirements: "需求已人工确认" },
  });
  customerApprovalState.checkpoints = customerApprovalState.checkpoints.map((checkpoint) =>
    checkpoint.stage === "requirements"
      ? { ...checkpoint, approved: true, approvedBy: "customer", timestamp: "2026-05-14 13:00:00" }
      : checkpoint
  );
  const state = createBaseState({
    contract: {
      title: "图书系统",
      requirements: ["提供图书列表 API"],
      acceptanceCriteria: ["GET /api/books 返回 200"],
    },
    customerApprovalState,
  });
  const agent = createArchitectAgent([
    JSON.stringify({
      spec: {
        architecture: "Express API",
        language: "TypeScript",
        framework: "Express.js ^4.18",
        testCommand: "npm test",
        runCommand: "npm start",
        entryPoint: "src/index.ts",
        filesToCreate: ["package.json", "tsconfig.json", "src/index.ts", "tests/books.test.ts"],
        interfaces: "REST API",
        dependencies: { express: "^4.18.2" },
        devDependencies: { typescript: "^5.0.0", jest: "^29.7.0", "ts-jest": "^29.1.1" },
      },
      manifest: {
        services: [{ name: "api", port: 10000, description: "api" }],
        environment: {},
        sharedConfig: {},
      },
      apiContract: {
        endpoints: [{ path: "/api/books", method: "GET", description: "图书列表" }],
      },
    }),
    "# README",
  ]);

  try {
    const result = await architectNode(
      state,
      { architect: agent },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    const requirements = result.customerApprovalState.checkpoints.find((item) => item.stage === "requirements");
    const solution = result.customerApprovalState.checkpoints.find((item) => item.stage === "solution");
    assert.equal(requirements.approved, true);
    assert.equal(requirements.approvedBy, "customer");
    assert.equal(requirements.timestamp, "2026-05-14 13:00:00");
    assert.equal(solution.approved, false);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("architect backfills missing backend coverage from frontend-backend requirement baseline", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    contract: {
      title: "电器销售系统",
      requirements: ["需要前后端页面和后端 API"],
      acceptanceCriteria: ["用户可以在前端管理商品"],
    },
  });
  const agent = createArchitectAgent([
    JSON.stringify({
      spec: {
        architecture: "只有静态页面",
        language: "TypeScript",
        framework: "Express.js ^4.18",
        testCommand: "npm test",
        runCommand: "npm start",
        entryPoint: "src/index.ts",
        filesToCreate: ["package.json", "public/index.html"],
        interfaces: "REST API",
        dependencies: { express: "^4.18.2" },
        devDependencies: { typescript: "^5.0.0" },
      },
      manifest: {
        services: [{ name: "api", port: 10000, description: "api" }],
        environment: {},
        sharedConfig: {},
      },
      apiContract: {
        endpoints: [],
      },
    }),
    "# README",
  ]);

  try {
    const result = await architectNode(
      state,
      { architect: agent },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );
    assert.equal(result.validationReport.status, "pass");
    assert.equal(result.spec.filesToCreate.some((file) => /^src\/routes\/.+\.ts$/i.test(file)), true);
    assert.equal(result.spec.filesToCreate.some((file) => /^src\/controllers\/.+controller\.ts$/i.test(file)), true);
    assert.equal(result.spec.filesToCreate.some((file) => /^src\/services\/.+service\.ts$/i.test(file)), true);
    assert.equal(result.spec.filesToCreate.some((file) => /^src\/models\/.+\.ts$/i.test(file)), true);
    assert.equal(recorder.snapshots.length > 0, true);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("architect enriches heavy full-stack requirements into executable backend and ops skeleton", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    contract: {
      title: "电器销售系统",
      requirements: [
        "需要前后端页面和后端 API",
        "支持商品列表、添加商品、编辑商品、删除商品",
        "需要登录认证和权限控制",
        "需要记录操作审计日志",
        "需要 Docker 部署和验证脚本",
      ],
      acceptanceCriteria: [
        "用户可以在前端管理商品",
        "后端需要提供商品 CRUD 接口",
        "未登录用户不能访问受保护接口",
        "系统需要输出结构化日志",
      ],
    },
  });
  const agent = createArchitectAgent([
    JSON.stringify({
      spec: {
        architecture: "Express 全栈单体",
        language: "TypeScript",
        framework: "Express.js ^4.18",
        testCommand: "npm test",
        runCommand: "npm start",
        entryPoint: "src/index.ts",
        filesToCreate: [
          "package.json",
          "tsconfig.json",
          "src/index.ts",
          "public/index.html",
        ],
        interfaces: "REST API",
        dependencies: { express: "^4.18.2" },
        devDependencies: { typescript: "^5.0.0", jest: "^29.7.0", "ts-jest": "^29.1.1" },
      },
      manifest: {
        services: [{ name: "api", port: 10000, description: "api" }],
        environment: {},
        sharedConfig: {},
      },
      apiContract: {
        endpoints: [
          { path: "/api/products", method: "GET", description: "商品列表" },
        ],
      },
    }),
    "# README",
  ]);

  try {
    const result = await architectNode(
      state,
      { architect: agent },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    const files = result.spec.filesToCreate;
    assert.equal(result.validationReport.status, "pass");
    assert.equal(files.includes("src/routes/products.ts"), true);
    assert.equal(files.includes("src/controllers/productController.ts"), true);
    assert.equal(files.includes("src/services/productService.ts"), true);
    assert.equal(files.includes("src/models/product.ts"), true);
    assert.equal(files.includes("src/middleware/auth.ts"), true);
    assert.equal(files.includes("src/logging/logger.ts"), true);
    assert.equal(files.includes("scripts/verify.ps1") || files.includes("scripts/verify.ts"), true);
    assert.equal(files.includes("Dockerfile"), true);
    assert.equal(files.includes("docker-compose.yml"), true);
    assert.equal(
      result.apiContract.endpoints.some((endpoint) => endpoint.path === "/api/products" && endpoint.method === "POST"),
      true
    );
    assert.equal(
      result.apiContract.endpoints.some((endpoint) => endpoint.path === "/api/auth/login" && endpoint.method === "POST"),
      true
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("architect node falls back to a deterministic executable skeleton when model is unavailable", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    contract: {
      title: "图书管理系统",
      requirements: [
        "需要前端页面和后端 API",
        "支持图书列表、添加图书、编辑图书、删除图书",
        "需要登录认证和权限控制",
        "需要记录操作审计日志",
        "需要 Docker 部署和验证脚本",
      ],
      acceptanceCriteria: [
        "用户可以访问图书列表页面",
        "后端提供图书 CRUD 接口",
      ],
    },
  });

  try {
    const result = await architectNode(
      state,
      {
        architect: {
          getPersona() {
            return { name: "测试架构师" };
          },
          async chat() {
            throw new AgentTimeoutError("测试架构师", 10);
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.validationReport.status, "pass");
    assert.equal(result.spec.filesToCreate.includes("package.json"), true);
    assert.equal(result.spec.filesToCreate.some((file) => /src\/routes\/books?\.ts$/.test(file)), true);
    assert.equal(result.spec.filesToCreate.some((file) => /tests\/books?\.test\.ts$/.test(file)), true);
    assert.equal(result.spec.filesToCreate.includes("scripts/verify.ts"), true);
    assert.equal(result.spec.filesToCreate.includes("Dockerfile"), true);
    assert.equal(result.manifest.services.length > 0, true);
    assert.equal(Number(result.manifest.services[0].port) >= 4000, true);
    const readme = await fs.readFile(path.join(workspace, "README.md"), "utf-8");
    assert.match(readme, /图书管理系统/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("architect deterministic fallback plans React frontend files when explicitly requested", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    userGoal: "创建一个 React 前后端分离商品目录应用，后端提供 GET /api/products",
    contract: {
      title: "商品目录应用",
      requirements: ["使用 React 构建现代前端页面", "后端提供商品列表 API"],
      acceptanceCriteria: ["React 页面可以展示商品列表。", "GET /api/products 返回商品数组。"],
    },
  });

  try {
    const result = await architectNode(
      state,
      {
        architect: {
          getPersona() {
            return { name: "测试架构师" };
          },
          async chat() {
            throw new AgentTimeoutError("测试架构师", 10);
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.spec.frontend.framework, "React");
    assert.equal(result.spec.filesToCreate.includes("frontend/src/App.tsx"), true);
    assert.equal(result.spec.filesToCreate.includes("frontend/src/main.tsx"), true);
    assert.equal(result.spec.filesToCreate.includes("frontend/src/App.vue"), false);
    assert.equal(result.spec.filesToCreate.includes("public/index.html"), false);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
