require("ts-node/register/transpile-only");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");

const { createTempWorkspace, removeTempWorkspace } = require("./test-helpers");
const { createJimClawGraph } = require("../../src/core/graph");
const { loadTraceIndex } = require("../../src/core/logic_utils");
const { createBaseGraphState } = require("../../src/server_state");

function createSequentialAgent(name, responses) {
  let index = 0;
  return {
    getPersona() {
      return { name };
    },
    async chat() {
      const content = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return { content };
    },
  };
}

test("web run startup no longer stalls at requirements approval and can continue past env_guard", async () => {
  const workspace = await createTempWorkspace();

  const pmAgent = createSequentialAgent("观止", [
    JSON.stringify({
      title: "图书管理系统",
      requirements: ["系统需要提供图书健康检查接口"],
      acceptanceCriteria: ["用户可通过 GET /api/health 获取 success 响应"],
    }),
    JSON.stringify([
      {
        id: "task-package",
        fileTarget: "package.json",
        description: "定义项目依赖",
        dependencies: [],
        contextRequirement: "生成最小 Node 项目依赖定义",
      },
      {
        id: "task-entry",
        fileTarget: "src/index.ts",
        description: "实现服务入口",
        dependencies: ["package.json"],
        contextRequirement: "实现 Express 服务入口并暴露健康检查路由",
      },
      {
        id: "task-health-route",
        fileTarget: "src/routes/health.ts",
        description: "实现健康检查路由",
        dependencies: ["src/index.ts"],
        contextRequirement: "提供 GET /api/health 路由",
      },
      {
        id: "task-test",
        fileTarget: "tests/setup.test.ts",
        description: "实现基线测试",
        dependencies: ["package.json"],
        contextRequirement: "补充最小可运行测试",
      },
    ]),
  ]);

  const architectAgent = createSequentialAgent("独孤", [
    JSON.stringify({
      spec: {
        architecture: "Express 单体后端",
        language: "TypeScript",
        framework: "Express.js ^4.18",
        testCommand: "npm test",
        runCommand: "npm start",
        entryPoint: "src/index.ts",
        filesToCreate: [
          "package.json",
          "tsconfig.json",
          "src/index.ts",
          "src/routes/health.ts",
          "jest.config.cjs",
          "tests/setup.test.ts",
        ],
        interfaces: "REST API",
        dependencies: { express: "^4.18.2" },
        devDependencies: {
          typescript: "^5.0.0",
          jest: "^29.7.0",
          "ts-jest": "^29.1.1",
          "@types/node": "^20.0.0",
          "@types/express": "^4.17.0",
        },
      },
      manifest: {
        services: [{ name: "api", port: 4100, description: "health api" }],
        environment: {},
        sharedConfig: {},
      },
      apiContract: {
        endpoints: [{ path: "/api/health", method: "GET", description: "健康检查" }],
      },
    }),
    "# README\n\n测试项目",
    JSON.stringify({
      endpoints: [{ path: "/api/health", method: "GET", description: "健康检查" }],
    }),
  ]);

  const coderAgent = {
    getPersona() {
      return { name: "星河" };
    },
    async chat() {
      throw new Error("coder reached");
    },
  };

  const qaAgent = {
    getPersona() {
      return { name: "清扬" };
    },
    async chat() {
      return { content: '{"issues":[]}' };
    },
  };

  try {
    const graph = await createJimClawGraph(
      {
        pm: pmAgent,
        architect: architectAgent,
        coder: coderAgent,
        qa: qaAgent,
      },
      undefined,
      { workspacePath: workspace, traceId: "trace_web_run_approval" }
    );

    await assert.rejects(
      () => graph.invoke(createBaseGraphState("图书管理系统", 5), {
        recursionLimit: 50,
      }),
      /coder reached/
    );

    const boulder = JSON.parse(await fs.readFile(`${workspace}/boulder.json`, "utf-8"));
    assert.notEqual(boulder.node, "approval_pending");
    assert.notEqual(boulder.node, "approval_crash");

    const traceIndex = await loadTraceIndex(workspace);
    assert.equal(
      traceIndex.timeline.some((item) => item.node === "orchestrator"),
      true
    );
    const checkpoints = boulder.state.customerApprovalState.checkpoints;
    assert.equal(
      checkpoints.find((item) => item.stage === "requirements")?.approved,
      true
    );
    assert.equal(
      checkpoints.find((item) => item.stage === "solution")?.approved,
      true
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});
