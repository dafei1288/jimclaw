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
const { contractSyncNode } = require("../../src/core/nodes/contract_sync_node");
const { AgentTimeoutError } = require("../../src/core/agent");
const { buildRequirementProtocol } = require("../../src/core/logic_utils");

function createArchitectAgent(handler) {
  return {
    getPersona() {
      return { name: "测试架构师" };
    },
    async chat(...args) {
      return handler(...args);
    },
  };
}

test("contract_sync persists validated contract snapshot", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    contract: { title: "图书管理系统", requirements: [], acceptanceCriteria: [] },
    apiContract: {
      endpoints: [
        { method: "GET", path: "/api/books", description: "图书列表" },
      ],
    },
  });
  const architect = createArchitectAgent(async () => ({
    content: JSON.stringify({
      endpoints: [
        { method: "GET", path: "/api/books", description: "图书列表" },
        { method: "POST", path: "/api/books", description: "新增图书" },
      ],
    }),
  }));

  try {
    const result = await contractSyncNode(
      state,
      { architect },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.apiContract.endpoints.length, 2);
    assert.equal(recorder.snapshots.length, 1);
    assert.equal(recorder.snapshots[0].node, "contract_sync");
    assert.equal(recorder.snapshots[0].state.apiContract.endpoints.length, 2);

    const raw = await fs.readFile(path.join(workspace, "api_contract_validated.json"), "utf-8");
    const saved = JSON.parse(raw);
    assert.equal(saved.endpoints.length, 2);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("contract_sync falls back to current api contract on recoverable agent timeout", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    contract: { title: "图书管理系统", requirements: [], acceptanceCriteria: [] },
    apiContract: {
      endpoints: [
        { method: "GET", path: "/api/books", description: "图书列表" },
      ],
    },
  });
  const architect = createArchitectAgent(async () => {
    throw new AgentTimeoutError("测试架构师", 1234);
  });

  try {
    const result = await contractSyncNode(
      state,
      { architect },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.deepEqual(result.apiContract, state.apiContract);
    assert.equal(recorder.snapshots.length, 1);
    assert.equal(recorder.snapshots[0].node, "contract_sync");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("contract_sync prunes unrequested writes and rebuilds execution protocol", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const requirementProtocol = buildRequirementProtocol({
    title: "商品目录应用",
    requirements: [
      "实现商品列表页面路由 GET /products。",
      "实现商品列表 JSON API 路由 GET /api/products。",
    ],
    acceptanceCriteria: ["GET /api/products 返回商品数组。"],
  });
  const state = createBaseState({
    contract: { title: "商品目录应用", requirements: [], acceptanceCriteria: [] },
    requirementProtocol,
    spec: {
      language: "TypeScript",
      framework: "Express.js ^4.18",
      testCommand: "npm test",
      runCommand: "npm start",
      entryPoint: "src/index.ts",
      filesToCreate: ["package.json", "tsconfig.json", "src/index.ts", "public/index.html", "tests/products.test.ts"],
    },
    manifest: { services: [{ name: "api", port: 4000 }] },
    apiContract: {
      endpoints: [
        { method: "GET", path: "/products", description: "商品页面" },
        { method: "GET", path: "/api/products", description: "商品列表" },
      ],
    },
  });
  const architect = createArchitectAgent(async () => ({
    content: JSON.stringify({
      endpoints: [
        { method: "GET", path: "/products", description: "商品页面" },
        { method: "GET", path: "/api/products", description: "商品列表" },
        { method: "POST", path: "/api/products", description: "新增商品" },
        { method: "PUT", path: "/api/products/:id", description: "更新商品" },
        { method: "DELETE", path: "/api/products/:id", description: "删除商品" },
      ],
    }),
  }));

  try {
    const result = await contractSyncNode(
      state,
      { architect },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.deepEqual(
      result.apiContract.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`),
      ["GET /products", "GET /api/products", "GET /api/health"]
    );
    assert.deepEqual(
      result.executionProtocol.contracts.api.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`),
      ["GET /products", "GET /api/products", "GET /api/health"]
    );
    assert.deepEqual(result.executionProtocol.contracts.frontend.apiUsage, [
      {
        resourcePath: "/products",
        methods: ["GET"],
        supportsList: true,
        supportsCreate: false,
        supportsUpdate: false,
        supportsDelete: false,
      },
      {
        resourcePath: "/api/products",
        methods: ["GET"],
        supportsList: true,
        supportsCreate: false,
        supportsUpdate: false,
        supportsDelete: false,
      },
    ]);
    assert.equal(recorder.snapshots[0].state.executionProtocol.contracts.api.endpoints.length, 3);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
