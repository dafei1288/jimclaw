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
const { verifierNode } = require("../../src/core/nodes/verifier_node");
const { buildRequirementProtocol, buildExecutionProtocol } = require("../../src/core/logic_utils");

test("verifier rejects jest roots that do not cover declared business tests", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    spec: {
      language: "TypeScript",
      testCommand: "npm test",
      filesToCreate: [
        "package.json",
        "jest.config.cjs",
        "tests/setup.test.ts",
        "tests/user.test.ts",
        "src/index.ts",
      ],
    },
  });

  try {
    await fs.mkdir(path.join(workspace, "tests"), { recursive: true });
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "jest" } }, null, 2),
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspace, "jest.config.cjs"),
      `module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/setup.test.ts"],
};`,
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspace, "tests/setup.test.ts"),
      `describe("setup", () => { it("works", () => { expect(true).toBe(true); }); });`,
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspace, "tests/user.test.ts"),
      `describe("user", () => { it("works", () => { expect(true).toBe(true); }); });`,
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspace, "src/index.ts"),
      `const app = { listen() {} };\napp.listen(10000);\nexport default app;\n`,
      "utf-8"
    );

    const result = await verifierNode(
      state,
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.isDone, false);
    assert.match(result.testResults || "", /Jest roots|Jest testMatch|测试文件 tests\/user\.test\.ts/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("verifier rejects missing frontend coverage and route mounting for frontend-backend requirement", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const requirementProtocol = buildRequirementProtocol({
    title: "图书管理系统",
    requirements: ["需要前端页面和后端 API"],
    acceptanceCriteria: ["用户能够在前端页面查看图书列表"],
  });
  const state = createBaseState({
    requirementProtocol,
    spec: {
      language: "TypeScript",
      testCommand: "npm test",
      entryPoint: "src/index.ts",
      filesToCreate: [
        "package.json",
        "jest.config.cjs",
        "tests/setup.test.ts",
        "tests/books.test.ts",
        "src/index.ts",
        "src/routes/books.ts",
      ],
    },
    apiContract: {
      endpoints: [{ method: "GET", path: "/api/books", description: "获取图书列表" }],
    },
  });
  state.executionProtocol = buildExecutionProtocol(state.spec, { services: [{ name: "api", port: 10000 }] }, state.apiContract, requirementProtocol);

  try {
    await fs.mkdir(path.join(workspace, "tests"), { recursive: true });
    await fs.mkdir(path.join(workspace, "src", "routes"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "jest" }, dependencies: { express: "^4.18.2" } }, null, 2),
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspace, "jest.config.cjs"),
      `module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
};`,
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspace, "tests/setup.test.ts"),
      `describe("setup", () => { it("works", () => { expect(true).toBe(true); }); });`,
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspace, "tests/books.test.ts"),
      `describe("books", () => { it("works", () => { expect(true).toBe(true); }); });`,
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspace, "src/index.ts"),
      `import express from "express";
const app = express();
app.get("/api/health", (_req, res) => res.status(200).json({ success: true }));
app.listen(10000);
export default app;`,
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspace, "src/routes/books.ts"),
      `export default {};`,
      "utf-8"
    );

    const result = await verifierNode(
      state,
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.isDone, false);
    assert.match(result.testResults || "", /需求覆盖失败：用户要求前端/);
    assert.match(result.testResults || "", /入口挂载缺失/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("verifier success clears stale protocol and failure markers", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    lastFailedNode: "verifier",
    lastFailureSummary: "旧的预检失败",
    protocolFailures: [
      {
        type: "layout_mismatch",
        node: "verifier",
        summary: "旧失败",
        evidence: ["旧失败"],
        blocking: true,
      },
    ],
    spec: {
      language: "TypeScript",
      testCommand: "npm test",
      filesToCreate: ["package.json", "jest.config.cjs", "tests/setup.test.ts", "src/index.ts"],
    },
  });

  try {
    await fs.mkdir(path.join(workspace, "tests"), { recursive: true });
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "jest" } }, null, 2),
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspace, "jest.config.cjs"),
      `module.exports = { preset: "ts-jest", testEnvironment: "node", roots: ["<rootDir>/tests"], testMatch: ["**/*.test.ts"] };`,
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspace, "tests/setup.test.ts"),
      `describe("setup", () => { it("works", () => { expect(true).toBe(true); }); });`,
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspace, "src/index.ts"),
      `const app = { listen() {} };\napp.listen(10000);\nexport default app;\n`,
      "utf-8"
    );

    const result = await verifierNode(
      state,
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.lastFailedNode, "");
    assert.equal(result.lastFailureSummary, "");
    assert.deepEqual(result.protocolFailures, []);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
