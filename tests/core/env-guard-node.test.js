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

function createResolvedExecutor({
  capabilitySnapshot,
  resolution,
  approvalTicket,
} = {}) {
  const snapshot = capabilitySnapshot || {
    version: "v1",
    localShell: { available: true },
    docker: { cliAvailable: true, daemonReachable: true },
    network: { outboundAllowed: true },
    backgroundProcess: { available: true },
  };
  const resolved = resolution || {
    selected: "docker",
    candidates: ["docker", "local_shell"],
    blocked: false,
    requiresApproval: false,
  };
  return {
    probeCapabilities: async () => snapshot,
    resolveIntent: async (_intent, providedSnapshot) => ({
      capabilitySnapshot: providedSnapshot,
      resolution: resolved,
      approvalTicket,
    }),
  };
}

test("env guard bootstraps deterministic package files without host npm install", async () => {
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
      recorder.save,
      { commandExecutor: createResolvedExecutor() }
    );

    assert.equal(result.envReady, true);
    assert.equal(calls.some((command) => /npm install --silent/.test(command)), false);

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

test("env guard closes package dependency gaps from source imports without host install", async () => {
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
      recorder.save,
      { commandExecutor: createResolvedExecutor() }
    );

    assert.equal(result.envReady, true);
    assert.equal(calls.some((command) => /npm install --silent/.test(command)), false);

    const packageJson = JSON.parse(await fs.readFile(path.join(workspace, "package.json"), "utf-8"));
    assert.equal(typeof packageJson.dependencies.express, "string");
    assert.equal(typeof packageJson.dependencies.cors, "string");
    assert.equal(typeof packageJson.devDependencies.supertest, "string");
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    await removeTempWorkspace(workspace);
  }
});

test("env guard keeps normalized package content ready for container install without host install", async () => {
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
      filesToCreate: ["package.json", "src/index.ts"],
      dependencies: { express: "^4.18.2" },
      devDependencies: {},
    },
    subTasks: [
      { id: "task-001", fileTarget: "package.json", description: "pkg", dependencies: [], contextRequirement: "", status: "completed" },
      { id: "task-002", fileTarget: "src/index.ts", description: "index", dependencies: [], contextRequirement: "", status: "completed" },
    ],
    code: JSON.stringify({
      "package.json": JSON.stringify({
        name: "demo",
        version: "1.0.0",
        dependencies: { express: "^4.18.2" },
        devDependencies: {},
      }, null, 2),
      "src/index.ts": 'import express from "express";\nconst app = express();\nexport default app;\n',
    }),
  });

  try {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({
      name: "demo",
      version: "1.0.0",
      dependencies: { express: "^4.18.2" },
      devDependencies: {},
    }, null, 2));
    await fs.writeFile(path.join(workspace, "src", "index.ts"), 'import express from "express";\nconst app = express();\nexport default app;\n');

    const result = await envGuardNode(
      state,
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save,
      { commandExecutor: createResolvedExecutor() }
    );

    assert.equal(result.envReady, true);
    const packageJson = JSON.parse(await fs.readFile(path.join(workspace, "package.json"), "utf-8"));
    assert.equal(packageJson.dependencies.express, "^4.18.2");
    assert.equal(calls.filter((command) => /npm install --silent/.test(command)).length, 0);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    await removeTempWorkspace(workspace);
  }
});

test("env guard routes environment failures through a single repair loop for missing type packages without host install", async () => {
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
      filesToCreate: ["package.json", "src/index.ts"],
      dependencies: { express: "^4.18.2" },
      devDependencies: { typescript: "^5.3.3" },
    },
    validationReport: {
      version: "v1",
      status: "fail",
      failureType: "environment_gap",
      blocking: true,
      findings: [{ type: "environment_gap", summary: "TS7016 缺少 express 类型声明", file: "src/index.ts", evidence: ["TS7016 Could not find a declaration file for module 'express'"] }],
    },
    repairPlan: {
      repairType: "environment",
      targets: ["package.json"],
      actions: ["补齐缺失的类型依赖"],
      expectedEvidence: ["TS7016", "express"],
    },
    testResults: "src/index.ts:1:21 - error TS7016: Could not find a declaration file for module 'express'.",
    subTasks: [
      { id: "task-001", fileTarget: "package.json", description: "pkg", dependencies: [], contextRequirement: "", status: "completed" },
      { id: "task-002", fileTarget: "src/index.ts", description: "index", dependencies: [], contextRequirement: "", status: "completed" },
    ],
    code: JSON.stringify({
      "package.json": JSON.stringify({
        name: "demo",
        version: "1.0.0",
        dependencies: { express: "^4.18.2" },
        devDependencies: { typescript: "^5.3.3" },
      }, null, 2),
      "src/index.ts": 'import express from "express";\nconst app = express();\nexport default app;\n',
    }),
  });

  try {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({
      name: "demo",
      version: "1.0.0",
      dependencies: { express: "^4.18.2" },
      devDependencies: { typescript: "^5.3.3" },
    }, null, 2));
    await fs.writeFile(path.join(workspace, "src", "index.ts"), 'import express from "express";\nconst app = express();\nexport default app;\n');

    const result = await envGuardNode(
      state,
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save,
      { commandExecutor: createResolvedExecutor() }
    );

    assert.equal(result.envReady, true);
    const packageJson = JSON.parse(await fs.readFile(path.join(workspace, "package.json"), "utf-8"));
    assert.equal(typeof packageJson.devDependencies["@types/express"], "string");
    assert.equal(calls.some((command) => /npm install --silent/.test(command)), false);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    await removeTempWorkspace(workspace);
  }
});

test("env guard selects host backend when docker is unavailable for node-like projects", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const calls = [];

  ShellExecuteSkill.config.run = async ({ command }) => {
    calls.push(command);
    if (/docker version/i.test(command)) {
      return "Command failed with error: spawn EPERM";
    }
    return "Output:\nOK\nErrors:\n";
  };

  const state = createBaseState({
    spec: {
      language: "TypeScript",
      filesToCreate: ["package.json", "src/index.ts"],
      dependencies: { express: "^5.0.0" },
      devDependencies: { typescript: "^5.0.0" },
    },
    subTasks: [
      { id: "task-001", fileTarget: "package.json", description: "pkg", dependencies: [], contextRequirement: "", status: "completed" },
      { id: "task-002", fileTarget: "src/index.ts", description: "index", dependencies: [], contextRequirement: "", status: "completed" },
    ],
    code: JSON.stringify({
      "package.json": JSON.stringify({
        name: "demo",
        version: "1.0.0",
        dependencies: { express: "^5.0.0" },
        devDependencies: { typescript: "^5.0.0" },
      }, null, 2),
      "src/index.ts": 'import express from "express";\nconst app = express();\nexport default app;\n',
    }),
  });

  try {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({
      name: "demo",
      version: "1.0.0",
      dependencies: { express: "^5.0.0" },
      devDependencies: { typescript: "^5.0.0" },
    }, null, 2));
    await fs.writeFile(path.join(workspace, "src", "index.ts"), 'import express from "express";\nconst app = express();\nexport default app;\n');

    const result = await envGuardNode(
      state,
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save,
      {
        commandExecutor: {
          probeCapabilities: async () => ({
            version: "v1",
            localShell: { available: true },
            docker: { cliAvailable: false, daemonReachable: false, reason: "spawn EPERM" },
            network: { outboundAllowed: true },
            backgroundProcess: { available: true },
          }),
          resolveIntent: async (_intent, snapshot) => ({
            capabilitySnapshot: snapshot,
            resolution: {
              selected: "local_shell",
              candidates: ["local_shell"],
              blocked: false,
              requiresApproval: false,
            },
          }),
        },
      }
    );

    assert.equal(result.envReady, true);
    assert.equal(result.executionBackend, "host");
    assert.equal(calls.some((command) => /docker version|jimclaw-host-probe|executor-shell-probe/i.test(command)), false);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    await removeTempWorkspace(workspace);
  }
});

test("env guard blocks host backend early when local shell execution capability is unavailable", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const calls = [];

  ShellExecuteSkill.config.run = async ({ command }) => {
    calls.push(command);
    if (/docker version/i.test(command)) {
      return "Command failed with error: spawn EPERM";
    }
    return "Command failed with error: spawn EPERM";
  };

  const state = createBaseState({
    spec: {
      language: "TypeScript",
      filesToCreate: ["package.json", "src/index.ts"],
      dependencies: { express: "^5.0.0" },
      devDependencies: { typescript: "^5.0.0" },
    },
    subTasks: [
      { id: "task-001", fileTarget: "package.json", description: "pkg", dependencies: [], contextRequirement: "", status: "completed" },
      { id: "task-002", fileTarget: "src/index.ts", description: "index", dependencies: [], contextRequirement: "", status: "completed" },
    ],
    code: JSON.stringify({
      "package.json": JSON.stringify({
        name: "demo",
        version: "1.0.0",
        dependencies: { express: "^5.0.0" },
        devDependencies: { typescript: "^5.0.0" },
      }, null, 2),
      "src/index.ts": 'import express from "express";\nconst app = express();\nexport default app;\n',
    }),
  });

  try {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({
      name: "demo",
      version: "1.0.0",
      dependencies: { express: "^5.0.0" },
      devDependencies: { typescript: "^5.0.0" },
    }, null, 2));
    await fs.writeFile(path.join(workspace, "src", "index.ts"), 'import express from "express";\nconst app = express();\nexport default app;\n');

    const result = await envGuardNode(
      state,
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save,
      {
        commandExecutor: {
          probeCapabilities: async () => ({
            version: "v1",
            localShell: { available: false, reason: "spawn EPERM" },
            docker: { cliAvailable: false, daemonReachable: false, reason: "spawn EPERM" },
            network: { outboundAllowed: true },
            backgroundProcess: { available: false, reason: "spawn EPERM" },
          }),
          resolveIntent: async (_intent, snapshot) => ({
            capabilitySnapshot: snapshot,
            resolution: {
              selected: null,
              candidates: [],
              blocked: true,
              blockedReason: "no backend available",
              requiresApproval: false,
            },
          }),
        },
      }
    );

    assert.equal(result.envReady, false);
    assert.match(result.blockedReason || "", /宿主环境阻塞/);
    assert.match(result.lastFailureSummary || "", /宿主环境阻塞/);
    assert.equal(calls.some((command) => /docker version|jimclaw-host-probe|executor-shell-probe/i.test(command)), false);
    assert.equal(recorder.snapshots.at(-1).node, "env_guard_host_blocked");
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    await removeTempWorkspace(workspace);
  }
});

test("env guard releases occupied host port without attempting host reinstall when evidence shows EADDRINUSE", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const calls = [];

  ShellExecuteSkill.config.run = async ({ command }) => {
    calls.push(command);
    return "Output:\ninstalled\nErrors:\n";
  };

  const state = createBaseState({
    spec: {
      language: "TypeScript",
      filesToCreate: ["package.json"],
      dependencies: {},
      devDependencies: {},
    },
    validationReport: {
      version: "v1",
      status: "fail",
      failureType: "environment_gap",
      blocking: true,
      findings: [{ type: "environment_gap", summary: "端口占用", evidence: ["EADDRINUSE", "3000"] }],
    },
    repairPlan: {
      repairType: "environment",
      targets: [],
      actions: ["释放被占用端口"],
      expectedEvidence: ["EADDRINUSE", "3000"],
    },
    testResults: "listen EADDRINUSE: address already in use :::3000",
    code: JSON.stringify({
      "package.json": JSON.stringify({ name: "demo", version: "1.0.0", dependencies: {}, devDependencies: {} }, null, 2),
    }),
  });

  try {
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", dependencies: {}, devDependencies: {} }, null, 2));

    const result = await envGuardNode(
      state,
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save,
      { commandExecutor: createResolvedExecutor() }
    );

    assert.equal(result.envReady, true);
    assert.equal(calls.some((command) => /3000/.test(command) && /(Get-NetTCPConnection|netstat|lsof|fuser)/.test(command)), true);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    await removeTempWorkspace(workspace);
  }
});

test("env guard delegates backend resolution to command executor instead of probing shell backends itself", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const shellCalls = [];
  const executorCalls = [];

  ShellExecuteSkill.config.run = async ({ command }) => {
    shellCalls.push(command);
    return "Output:\nOK\nErrors:\n";
  };

  const capabilitySnapshot = {
    version: "v1",
    localShell: { available: true },
    docker: { cliAvailable: false, daemonReachable: false, reason: "spawn EPERM" },
    network: { outboundAllowed: true },
    backgroundProcess: { available: true },
  };
  const state = createBaseState({
    spec: {
      language: "TypeScript",
      filesToCreate: ["package.json", "src/index.ts"],
      dependencies: { express: "^5.0.0" },
      devDependencies: { typescript: "^5.0.0" },
    },
    subTasks: [
      { id: "task-001", fileTarget: "package.json", description: "pkg", dependencies: [], contextRequirement: "", status: "completed" },
      { id: "task-002", fileTarget: "src/index.ts", description: "index", dependencies: [], contextRequirement: "", status: "completed" },
    ],
    code: JSON.stringify({
      "package.json": JSON.stringify({
        name: "demo",
        version: "1.0.0",
        dependencies: { express: "^5.0.0" },
        devDependencies: { typescript: "^5.0.0" },
      }, null, 2),
      "src/index.ts": 'import express from "express";\nconst app = express();\nexport default app;\n',
    }),
  });

  try {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({
      name: "demo",
      version: "1.0.0",
      dependencies: { express: "^5.0.0" },
      devDependencies: { typescript: "^5.0.0" },
    }, null, 2));
    await fs.writeFile(path.join(workspace, "src", "index.ts"), 'import express from "express";\nconst app = express();\nexport default app;\n');

    const result = await envGuardNode(
      state,
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save,
      {
        commandExecutor: {
          probeCapabilities: async () => {
            executorCalls.push("probe");
            return capabilitySnapshot;
          },
          resolveIntent: async (intent, snapshot) => {
            executorCalls.push(`resolve:${intent.kind}`);
            assert.deepEqual(snapshot, capabilitySnapshot);
            return {
              capabilitySnapshot: snapshot,
              resolution: {
                selected: "local_shell",
                candidates: ["local_shell"],
                blocked: false,
                requiresApproval: false,
              },
            };
          },
        },
      }
    );

    assert.equal(result.envReady, true);
    assert.equal(result.executionBackend, "host");
    assert.deepEqual(executorCalls, ["probe", "resolve:install_deps"]);
    assert.equal(shellCalls.some((command) => /docker version|jimclaw-host-probe|executor-shell-probe/i.test(command)), false);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    await removeTempWorkspace(workspace);
  }
});

test("env guard turns approval-required dependency installation into pending executor state instead of continuing", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const shellCalls = [];

  ShellExecuteSkill.config.run = async ({ command }) => {
    shellCalls.push(command);
    return "Output:\nOK\nErrors:\n";
  };

  const state = createBaseState({
    spec: {
      language: "TypeScript",
      filesToCreate: ["package.json", "src/index.ts"],
      dependencies: { express: "^5.0.0" },
      devDependencies: { typescript: "^5.0.0" },
    },
    subTasks: [
      { id: "task-001", fileTarget: "package.json", description: "pkg", dependencies: [], contextRequirement: "", status: "completed" },
      { id: "task-002", fileTarget: "src/index.ts", description: "index", dependencies: [], contextRequirement: "", status: "completed" },
    ],
    code: JSON.stringify({
      "package.json": JSON.stringify({
        name: "demo",
        version: "1.0.0",
        dependencies: { express: "^5.0.0" },
        devDependencies: { typescript: "^5.0.0" },
      }, null, 2),
      "src/index.ts": 'import express from "express";\nconst app = express();\nexport default app;\n',
    }),
  });

  try {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({
      name: "demo",
      version: "1.0.0",
      dependencies: { express: "^5.0.0" },
      devDependencies: { typescript: "^5.0.0" },
    }, null, 2));
    await fs.writeFile(path.join(workspace, "src", "index.ts"), 'import express from "express";\nconst app = express();\nexport default app;\n');

    const result = await envGuardNode(
      state,
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save,
      {
        commandExecutor: {
          probeCapabilities: async () => ({
            version: "v1",
            localShell: { available: true },
            docker: { cliAvailable: true, daemonReachable: true },
            network: { outboundAllowed: false, reason: "policy denied" },
            backgroundProcess: { available: true },
          }),
          resolveIntent: async (_intent, snapshot) => ({
            capabilitySnapshot: snapshot,
            resolution: {
              selected: "docker",
              candidates: ["docker", "local_shell"],
              blocked: false,
              requiresApproval: true,
              approvalScope: "network_install",
            },
            approvalTicket: {
              id: "ticket-network-install",
              stage: "network_install",
              required: true,
              status: "pending",
              reason: "approval required for install_deps",
              requestedAt: "2026-04-01T00:00:00.000Z",
            },
          }),
        },
      }
    );

    assert.equal(result.envReady, false);
    assert.equal(result.requiresApproval, true);
    assert.match(result.blockedReason || "", /授权|approval/i);
    assert.equal(result.executorState?.approvalTickets?.[0]?.id, "ticket-network-install");
    assert.equal(result.executorState?.selectedBackend, "docker");
    assert.equal(result.executorState?.lastExecutorResult?.requiresApproval, true);
    assert.equal(result.agentRecoveryPending, true);
    assert.equal(shellCalls.some((command) => /docker version|jimclaw-host-probe|executor-shell-probe/i.test(command)), false);
    assert.equal(recorder.snapshots.at(-1).node, "env_guard_approval_required");
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    await removeTempWorkspace(workspace);
  }
});
