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
