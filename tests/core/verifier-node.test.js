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

test("verifier staged validation does not fail planned frontend coverage before deferred files are written", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const requirementProtocol = buildRequirementProtocol({
    title: "图书管理系统",
    requirements: ["需要前端页面和后端 API"],
    acceptanceCriteria: ["用户能够在前端页面查看图书列表"],
  });
  const state = createBaseState({
    requirementProtocol,
    validationCheckpointRequested: true,
    spec: {
      language: "TypeScript",
      testCommand: "npm test",
      entryPoint: "src/index.ts",
      filesToCreate: [
        "package.json",
        "jest.config.cjs",
        "tests/setup.test.ts",
        "src/index.ts",
        "src/routes/books.ts",
        "public/index.html",
      ],
    },
    subTasks: [
      { id: "task-1", description: "pkg", fileTarget: "package.json", dependencies: [], contextRequirement: "", status: "completed" },
      { id: "task-2", description: "jest", fileTarget: "jest.config.cjs", dependencies: ["package.json"], contextRequirement: "", status: "completed" },
      { id: "task-3", description: "setup", fileTarget: "tests/setup.test.ts", dependencies: ["package.json"], contextRequirement: "", status: "completed" },
      { id: "task-4", description: "route", fileTarget: "src/routes/books.ts", dependencies: [], contextRequirement: "", status: "completed" },
      { id: "task-5", description: "entry", fileTarget: "src/index.ts", dependencies: ["src/routes/books.ts"], contextRequirement: "", status: "completed" },
      { id: "task-6", description: "ui", fileTarget: "public/index.html", dependencies: ["src/index.ts"], contextRequirement: "", status: "pending" },
    ],
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
      path.join(workspace, "src/index.ts"),
      `import express from "express";
const app = express();
app.use(express.static("public"));
app.use("/api/books", (_req, res) => res.status(200).json([]));
app.get("/", (_req, res) => res.sendFile("public/index.html", { root: process.cwd() }));
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

    assert.equal(result.testResults || "", "");
    assert.equal(result.validationReport?.status, "pass");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("verifier rejects staged validation when a core business file is still a deterministic scaffold from fallback planning", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const requirementProtocol = buildRequirementProtocol({
    title: "图书管理系统",
    requirements: ["需要后端 API"],
    acceptanceCriteria: ["用户能够查询图书列表"],
  });
  const spec = {
    language: "TypeScript",
    testCommand: "npm test",
    entryPoint: "src/index.ts",
    filesToCreate: [
      "package.json",
      "jest.config.cjs",
      "tests/setup.test.ts",
      "src/models/book.ts",
      "src/services/bookService.ts",
      "src/controllers/bookController.ts",
      "src/routes/books.ts",
      "src/index.ts",
    ],
  };
  const state = createBaseState({
    requirementProtocol,
    designSource: "deterministic-fallback",
    orchestrationSource: "deterministic-fallback",
    validationCheckpointRequested: true,
    spec,
    subTasks: [
      { id: "task-1", description: "pkg", fileTarget: "package.json", dependencies: [], contextRequirement: "", status: "completed" },
      { id: "task-2", description: "jest", fileTarget: "jest.config.cjs", dependencies: ["package.json"], contextRequirement: "", status: "completed" },
      { id: "task-3", description: "setup", fileTarget: "tests/setup.test.ts", dependencies: ["package.json"], contextRequirement: "", status: "completed" },
      { id: "task-4", description: "model", fileTarget: "src/models/book.ts", dependencies: [], contextRequirement: "", status: "completed" },
      { id: "task-5", description: "service", fileTarget: "src/services/bookService.ts", dependencies: ["src/models/book.ts"], contextRequirement: "", status: "completed" },
      { id: "task-6", description: "controller", fileTarget: "src/controllers/bookController.ts", dependencies: ["src/services/bookService.ts"], contextRequirement: "", status: "completed" },
      { id: "task-7", description: "route", fileTarget: "src/routes/books.ts", dependencies: ["src/controllers/bookController.ts"], contextRequirement: "", status: "completed" },
      { id: "task-8", description: "entry", fileTarget: "src/index.ts", dependencies: ["src/routes/books.ts"], contextRequirement: "", status: "completed" },
    ],
    apiContract: {
      endpoints: [],
    },
    codeLog: [
      { round: 0, file: "package.json", taskTitle: "pkg", status: "written", generationSource: "model" },
      { round: 0, file: "jest.config.cjs", taskTitle: "jest", status: "written", generationSource: "model" },
      { round: 0, file: "tests/setup.test.ts", taskTitle: "setup", status: "written", generationSource: "model" },
      { round: 0, file: "src/models/book.ts", taskTitle: "model", status: "written", generationSource: "model" },
      { round: 0, file: "src/services/bookService.ts", taskTitle: "service", status: "written", generationSource: "deterministic_scaffold" },
      { round: 0, file: "src/controllers/bookController.ts", taskTitle: "controller", status: "written", generationSource: "model" },
      { round: 0, file: "src/routes/books.ts", taskTitle: "route", status: "written", generationSource: "model" },
      { round: 0, file: "src/index.ts", taskTitle: "entry", status: "written", generationSource: "model" },
    ],
  });
  state.executionProtocol = buildExecutionProtocol(spec, { services: [{ name: "api", port: 10000 }] }, state.apiContract, requirementProtocol);

  try {
    await fs.mkdir(path.join(workspace, "tests"), { recursive: true });
    await fs.mkdir(path.join(workspace, "src", "models"), { recursive: true });
    await fs.mkdir(path.join(workspace, "src", "services"), { recursive: true });
    await fs.mkdir(path.join(workspace, "src", "controllers"), { recursive: true });
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
    await fs.writeFile(path.join(workspace, "src/models/book.ts"), `export interface Book { id: string; title: string; }\n`, "utf-8");
    await fs.writeFile(path.join(workspace, "src/services/bookService.ts"), `export const listBooks = () => [];\n`, "utf-8");
    await fs.writeFile(path.join(workspace, "src/controllers/bookController.ts"), `export const listBooksHandler = () => [];\n`, "utf-8");
    await fs.writeFile(path.join(workspace, "src/routes/books.ts"), `export default {};\n`, "utf-8");
    await fs.writeFile(
      path.join(workspace, "src/index.ts"),
      `import express from "express";
const app = express();
app.use("/api/books", (_req, res) => res.status(200).json([]));
app.get("/api/health", (_req, res) => res.status(200).json({ success: true }));
app.listen(10000);
export default app;`,
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
    assert.match(result.testResults || "", /阶段验证拒绝/);
    assert.match(result.testResults || "", /src\/services\/bookService\.ts/);
    assert.match(result.testResults || "", /降级骨架/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("verifier allows compact fallback auth service scaffold during staged validation", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const requirementProtocol = buildRequirementProtocol({
    title: "图书管理系统",
    requirements: ["需要后端 API 和登录认证"],
    acceptanceCriteria: ["用户能够登录并查询图书列表"],
  });
  const spec = {
    language: "TypeScript",
    testCommand: "npm test",
    entryPoint: "src/index.ts",
    authScaffoldMode: "compact",
    filesToCreate: [
      "package.json",
      "jest.config.cjs",
      "tests/setup.test.ts",
      "src/models/book.ts",
      "src/services/bookService.ts",
      "src/services/authService.ts",
      "src/controllers/bookController.ts",
      "src/routes/books.ts",
      "src/index.ts",
    ],
  };
  const state = createBaseState({
    requirementProtocol,
    designSource: "deterministic-fallback",
    orchestrationSource: "deterministic-fallback",
    validationCheckpointRequested: true,
    spec,
    subTasks: [
      { id: "task-1", description: "pkg", fileTarget: "package.json", dependencies: [], contextRequirement: "", status: "completed" },
      { id: "task-2", description: "jest", fileTarget: "jest.config.cjs", dependencies: ["package.json"], contextRequirement: "", status: "completed" },
      { id: "task-3", description: "setup", fileTarget: "tests/setup.test.ts", dependencies: ["package.json"], contextRequirement: "", status: "completed" },
      { id: "task-4", description: "model", fileTarget: "src/models/book.ts", dependencies: [], contextRequirement: "", status: "completed" },
      { id: "task-5", description: "service", fileTarget: "src/services/bookService.ts", dependencies: ["src/models/book.ts"], contextRequirement: "", status: "completed" },
      { id: "task-6", description: "auth-service", fileTarget: "src/services/authService.ts", dependencies: [], contextRequirement: "", status: "completed" },
      { id: "task-7", description: "controller", fileTarget: "src/controllers/bookController.ts", dependencies: ["src/services/bookService.ts"], contextRequirement: "", status: "completed" },
      { id: "task-8", description: "route", fileTarget: "src/routes/books.ts", dependencies: ["src/controllers/bookController.ts"], contextRequirement: "", status: "completed" },
      { id: "task-9", description: "entry", fileTarget: "src/index.ts", dependencies: ["src/routes/books.ts"], contextRequirement: "", status: "completed" },
    ],
    apiContract: {
      endpoints: [],
    },
    codeLog: [
      { round: 0, file: "package.json", taskTitle: "pkg", status: "written", generationSource: "model" },
      { round: 0, file: "jest.config.cjs", taskTitle: "jest", status: "written", generationSource: "model" },
      { round: 0, file: "tests/setup.test.ts", taskTitle: "setup", status: "written", generationSource: "model" },
      { round: 0, file: "src/models/book.ts", taskTitle: "model", status: "written", generationSource: "model" },
      { round: 0, file: "src/services/bookService.ts", taskTitle: "service", status: "written", generationSource: "model" },
      { round: 0, file: "src/services/authService.ts", taskTitle: "auth-service", status: "written", generationSource: "deterministic_scaffold" },
      { round: 0, file: "src/controllers/bookController.ts", taskTitle: "controller", status: "written", generationSource: "model" },
      { round: 0, file: "src/routes/books.ts", taskTitle: "route", status: "written", generationSource: "model" },
      { round: 0, file: "src/index.ts", taskTitle: "entry", status: "written", generationSource: "model" },
    ],
  });
  state.executionProtocol = buildExecutionProtocol(spec, { services: [{ name: "api", port: 10000 }] }, state.apiContract, requirementProtocol);

  try {
    await fs.mkdir(path.join(workspace, "tests"), { recursive: true });
    await fs.mkdir(path.join(workspace, "src", "models"), { recursive: true });
    await fs.mkdir(path.join(workspace, "src", "services"), { recursive: true });
    await fs.mkdir(path.join(workspace, "src", "controllers"), { recursive: true });
    await fs.mkdir(path.join(workspace, "src", "routes"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "jest" }, dependencies: { express: "^4.18.2", jsonwebtoken: "^9.0.2" } }, null, 2),
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
    await fs.writeFile(path.join(workspace, "src/models/book.ts"), `export interface Book { id: string; title: string; }\n`, "utf-8");
    await fs.writeFile(path.join(workspace, "src/services/bookService.ts"), `export const listBooks = () => [];\n`, "utf-8");
    await fs.writeFile(path.join(workspace, "src/services/authService.ts"), `export class AuthService {}\n`, "utf-8");
    await fs.writeFile(path.join(workspace, "src/controllers/bookController.ts"), `export const listBooksHandler = () => [];\n`, "utf-8");
    await fs.writeFile(path.join(workspace, "src/routes/books.ts"), `export default {};\n`, "utf-8");
    await fs.writeFile(
      path.join(workspace, "src/index.ts"),
      `import express from "express";
const app = express();
app.use("/api/books", (_req, res) => res.status(200).json([]));
app.get("/api/health", (_req, res) => res.status(200).json({ success: true }));
app.listen(10000);
export default app;`,
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

    assert.equal(result.testResults || "", "");
    assert.equal(result.validationReport?.status, "pass");
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

test("verifier does not require a static listen declaration when entry contract is otherwise valid", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    spec: {
      language: "TypeScript",
      testCommand: "npm test",
      filesToCreate: ["package.json", "jest.config.cjs", "tests/setup.test.ts", "src/index.ts"],
      entryPoint: "src/index.ts",
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
      `import express from "express";
const app = express();
app.get("/api/health", (_req, res) => res.status(200).json({ success: true }));
export default app;`,
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

    assert.equal(result.validationReport.status, "pass");
    assert.equal(result.lastFailedNode, "");
    assert.doesNotMatch(result.testResults || "", /监听声明/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("verifier classifies missing package metadata as environment gap", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    spec: {
      language: "TypeScript",
      testCommand: "npm test",
      filesToCreate: ["package.json", "src/index.ts"],
    },
  });

  try {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
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
    assert.equal(result.validationReport.failureType, "environment_gap");
    assert.equal(result.repairPlan.repairType, "environment");
    assert.match(result.testResults || "", /缺少 package\.json/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("verifier classifies broken entry runtime wiring as runtime gap", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const requirementProtocol = buildRequirementProtocol({
    title: "图书管理系统",
    requirements: ["需要后端 API"],
    acceptanceCriteria: ["后端接口可以提供图书列表"],
  });
  const state = createBaseState({
    requirementProtocol,
    spec: {
      language: "TypeScript",
      testCommand: "npm test",
      filesToCreate: ["package.json", "jest.config.cjs", "tests/setup.test.ts", "src/index.ts", "src/routes/books.ts"],
      entryPoint: "src/index.ts",
    },
    apiContract: {
      endpoints: [{ method: "GET", path: "/api/books", description: "图书列表" }],
    },
  });
  state.executionProtocol = buildExecutionProtocol(
    state.spec,
    { services: [{ name: "api", port: 10000 }] },
    state.apiContract,
    requirementProtocol
  );

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
      `import express from "express";
const app = express();
app.get("/api/health", (_req, res) => res.status(200).json({ success: true }));
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
    assert.equal(result.validationReport.failureType, "runtime_gap");
    assert.equal(result.repairPlan.repairType, "runtime");
    assert.match(result.testResults || "", /入口挂载缺失/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("verifier does not flag relative sub-router paths as contract drift when owned endpoints share a mount base", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const requirementProtocol = buildRequirementProtocol({
    title: "图书管理系统",
    requirements: ["需要后端 API"],
    acceptanceCriteria: ["提供图书 CRUD 接口"],
  });
  const state = createBaseState({
    requirementProtocol,
    spec: {
      language: "TypeScript",
      framework: "Express.js ^4.18",
      testCommand: "npm test",
      entryPoint: "src/index.ts",
      filesToCreate: [
        "package.json",
        "jest.config.cjs",
        "tests/setup.test.ts",
        "src/index.ts",
        "src/routes/books.ts",
        "src/controllers/bookController.ts",
      ],
    },
    apiContract: {
      endpoints: [
        { method: "GET", path: "/api/books", description: "图书列表" },
        { method: "POST", path: "/api/books", description: "创建图书" },
        { method: "PUT", path: "/api/books/:id", description: "更新图书" },
        { method: "DELETE", path: "/api/books/:id", description: "删除图书" },
      ],
    },
  });
  state.executionProtocol = buildExecutionProtocol(
    state.spec,
    { services: [{ name: "api", port: 10000 }] },
    state.apiContract,
    requirementProtocol
  );

  try {
    await fs.mkdir(path.join(workspace, "tests"), { recursive: true });
    await fs.mkdir(path.join(workspace, "src", "routes"), { recursive: true });
    await fs.mkdir(path.join(workspace, "src", "controllers"), { recursive: true });
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
      path.join(workspace, "src/controllers/bookController.ts"),
      `export const getBooks = () => undefined;
export const addBook = () => undefined;
export const editBook = () => undefined;
export const deleteBook = () => undefined;
`,
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspace, "src/routes/books.ts"),
      `import { Router } from "express";
import { getBooks, addBook, editBook, deleteBook } from "../controllers/bookController";

const router = Router();
router.get("/", getBooks);
router.post("/", addBook);
router.put("/:id", editBook);
router.delete("/:id", deleteBook);

export default router;
`,
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspace, "src/index.ts"),
      `import express from "express";
import booksRouter from "./routes/books";
const app = express();
app.use("/api/books", booksRouter);
app.get("/api/health", (_req, res) => res.status(200).json({ success: true }));
export default app;`,
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

    assert.equal(result.validationReport.status, "pass");
    assert.doesNotMatch(result.testResults || "", /契约漂移 src\/routes\/books\.ts/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("verifier classifies syntax-broken source files as implementation bug", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    spec: {
      language: "TypeScript",
      testCommand: "npm test",
      filesToCreate: ["package.json", "jest.config.cjs", "tests/setup.test.ts", "src/index.ts", "src/routes/books.ts"],
      entryPoint: "src/index.ts",
    },
  });

  try {
    await fs.mkdir(path.join(workspace, "tests"), { recursive: true });
    await fs.mkdir(path.join(workspace, "src", "routes"), { recursive: true });
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
    await fs.writeFile(
      path.join(workspace, "src/routes/books.ts"),
      `export const broken = ;\n`,
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
    assert.equal(result.validationReport.failureType, "implementation_bug");
    assert.equal(result.repairPlan.repairType, "implementation");
    assert.match(result.testResults || "", /语法错误|Expression expected/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
