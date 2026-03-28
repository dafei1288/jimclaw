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
const { envGuardNode } = require("../../src/core/nodes/env_guard_node");
const { ShellExecuteSkill } = require("../../src/skills/shell_exec");

test("env guard bootstraps deterministic package files before npm install", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const calls = [];

  ShellExecuteSkill.config.run = async ({ command }) => {
    calls.push(command);
    return "Output:\ninstalled\nErrors:\n";
  };

  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "图书管理系统", requirements: [], acceptanceCriteria: [] },
    spec: {
      language: "TypeScript",
      filesToCreate: ["package.json", "tsconfig.json", "jest.config.cjs", "tests/setup.test.ts", "src/index.ts"],
      dependencies: { express: "^4.18.2" },
      devDependencies: { typescript: "^5.3.3", jest: "^29.7.0", "ts-jest": "^29.1.1" },
    },
    manifest: { services: [{ name: "app", port: 10000, description: "demo" }], environment: {}, sharedConfig: {} },
    subTasks: [
      { id: "task-001", fileTarget: "package.json", description: "pkg", dependencies: [], contextRequirement: "", status: "pending" },
      { id: "task-002", fileTarget: "tsconfig.json", description: "tsconfig", dependencies: [], contextRequirement: "", status: "pending" },
      { id: "task-003", fileTarget: "jest.config.cjs", description: "jest", dependencies: [], contextRequirement: "", status: "pending" },
      { id: "task-004", fileTarget: "tests/setup.test.ts", description: "setup test", dependencies: [], contextRequirement: "", status: "pending" },
      { id: "task-005", fileTarget: "src/index.ts", description: "index", dependencies: [], contextRequirement: "", status: "pending" },
    ],
  });

  try {
    const result = await envGuardNode(
      state,
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.envReady, true);
    assert.match(calls[0] || "", /npm install --silent/);

    const packageJson = await fs.readFile(path.join(workspace, "package.json"), "utf-8");
    const tsconfig = await fs.readFile(path.join(workspace, "tsconfig.json"), "utf-8");
    assert.match(packageJson, /"name": "jimclaw-app"/);
    assert.match(tsconfig, /"types": \[/);

    const pkgTask = result.subTasks.find((task) => task.fileTarget === "package.json");
    const tsTask = result.subTasks.find((task) => task.fileTarget === "tsconfig.json");
    assert.equal(pkgTask.status, "completed");
    assert.equal(tsTask.status, "completed");
    assert.equal(recorder.snapshots.at(-1).node, "env_guard_ready");
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    await removeTempWorkspace(workspace);
  }
});

test("env guard closes package dependency gaps from source imports before npm install", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const calls = [];

  ShellExecuteSkill.config.run = async ({ command }) => {
    calls.push(command);
    return "Output:\ninstalled\nErrors:\n";
  };

  const state = createBaseState({
    contract: { title: "图书管理系统", requirements: [], acceptanceCriteria: [] },
    spec: {
      language: "TypeScript",
      filesToCreate: ["package.json", "src/index.ts", "tests/books.test.ts"],
      dependencies: {},
      devDependencies: {},
    },
    subTasks: [
      { id: "task-001", fileTarget: "package.json", description: "pkg", dependencies: [], contextRequirement: "", status: "completed" },
      { id: "task-002", fileTarget: "src/index.ts", description: "index", dependencies: [], contextRequirement: "", status: "completed" },
      { id: "task-003", fileTarget: "tests/books.test.ts", description: "test", dependencies: [], contextRequirement: "", status: "completed" },
    ],
    code: JSON.stringify({
      "package.json": JSON.stringify({
        name: "demo",
        version: "1.0.0",
        dependencies: {},
        devDependencies: {},
      }, null, 2),
      "src/index.ts": 'import express from "express";\nimport cors from "cors";\nconst app = express();\napp.use(cors());\nexport default app;\n',
      "tests/books.test.ts": 'import request from "supertest";\nimport app from "../src/index";\ndescribe("books", () => { it("works", async () => { await request(app).get("/api/health"); }); });\n',
    }),
  });

  try {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.mkdir(path.join(workspace, "tests"), { recursive: true });
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", dependencies: {}, devDependencies: {} }, null, 2));
    await fs.writeFile(path.join(workspace, "src", "index.ts"), 'import express from "express";\nimport cors from "cors";\nconst app = express();\napp.use(cors());\nexport default app;\n');
    await fs.writeFile(path.join(workspace, "tests", "books.test.ts"), 'import request from "supertest";\nimport app from "../src/index";\ndescribe("books", () => { it("works", async () => { await request(app).get("/api/health"); }); });\n');

    const result = await envGuardNode(
      state,
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.envReady, true);
    assert.match(calls[0] || "", /npm install --silent/);

    const packageJson = JSON.parse(await fs.readFile(path.join(workspace, "package.json"), "utf-8"));
    assert.equal(typeof packageJson.dependencies.express, "string");
    assert.equal(typeof packageJson.dependencies.cors, "string");
    assert.equal(typeof packageJson.devDependencies.supertest, "string");
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    await removeTempWorkspace(workspace);
  }
});
