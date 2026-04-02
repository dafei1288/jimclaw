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
const { ShellExecuteSkill } = require("../../src/skills/shell_exec");
const { FindFreePortSkill } = require("../../src/skills/find_free_port");

require("ts-node/register/transpile-only");

const {
  rewriteComposePortBindings,
  extractComposePrimaryServiceName,
  hasBuildScript,
  infraNode,
} = require("../../src/core/nodes/infra_node");

test("docker-compose port rewrite keeps host and container ports aligned with runtime allocation", () => {
  const input = `version: '3.8'

services:
  app:
    ports:
      - "10000:10000"
`;

  const output = rewriteComposePortBindings(input, 4123, 10000);

  assert.match(output, /4123:10000/);
  assert.doesNotMatch(output, /10000:10000/);
});

test("docker-compose service parser resolves the primary service name", () => {
  const input = `version: '3.8'

services:
  health-check-service:
    build:
      context: .
    ports:
      - "10000:10000"
`;

  assert.equal(extractComposePrimaryServiceName(input), "health-check-service");
});

test("package manifest with build script requires infra build step", () => {
  const input = JSON.stringify({
    scripts: {
      build: "tsc",
      start: "node dist/index.js",
    },
  });

  assert.equal(hasBuildScript(input), true);
  assert.equal(hasBuildScript(JSON.stringify({ scripts: { start: "node index.js" } })), false);
});

test("infra setup retries transient single-container startup failure before escalating", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalFindPort = FindFreePortSkill.config.run;
  let dockerRunCalls = 0;

  FindFreePortSkill.config.run = async () => "4123";
  ShellExecuteSkill.config.run = async ({ command }) => {
    if (command.startsWith("docker rm -f")) {
      return "Output:\nremoved\nErrors:\n";
    }
    if (command.startsWith("docker run -d")) {
      dockerRunCalls += 1;
      if (dockerRunCalls === 1) {
        return [
          "Command failed with exit code 125.",
          "Output:",
          "",
          "Errors:",
          "Conflict. The container name \"/jimclaw_test\" is already in use by container \"deadbeef\".",
        ].join("\n");
      }
      return "Output:\nabc123def456\nErrors:\n";
    }
    throw new Error(`unexpected command: ${command}`);
  };

  try {
    const result = await infraNode(
      createBaseState({
        spec: {
          language: "TypeScript",
          filesToCreate: [],
        },
        manifest: { services: [{ name: "app", port: 10000, description: "demo" }], environment: {}, sharedConfig: {} },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(dockerRunCalls, 2);
    assert.equal(result.containerId, "abc123def456");
    assert.equal(result.testResults, "");
    assert.equal(result.lastFailedNode, "");
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    FindFreePortSkill.config.run = originalFindPort;
    await removeTempWorkspace(workspace);
  }
});

test("infra setup retries transient install exec failure before escalating", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalFindPort = FindFreePortSkill.config.run;
  let installCalls = 0;
  let buildCalls = 0;

  await require("fs/promises").writeFile(
    require("path").join(workspace, "package.json"),
    JSON.stringify({
      name: "demo",
      scripts: { build: "tsc" },
    }, null, 2),
    "utf-8"
  );

  FindFreePortSkill.config.run = async () => "4123";
  ShellExecuteSkill.config.run = async ({ command }) => {
    if (command.startsWith("docker rm -f")) {
      return "Output:\nremoved\nErrors:\n";
    }
    if (command.startsWith("docker run -d")) {
      return "Output:\nabc123def456\nErrors:\n";
    }
    if (command.includes('docker exec -w /app abc123def456 sh -c "npm install --silent"')) {
      installCalls += 1;
      if (installCalls === 1) {
        return [
          "Command failed with exit code 137.",
          "Output:",
          "",
          "Errors:",
          "OCI runtime exec failed: exec failed: container is not running",
        ].join("\n");
      }
      return "Output:\ninstalled\nErrors:\n";
    }
    if (command.includes('docker exec -w /app abc123def456 sh -c "npm run build"')) {
      buildCalls += 1;
      return "Output:\nbuilt\nErrors:\n";
    }
    throw new Error(`unexpected command: ${command}`);
  };

  try {
    const result = await infraNode(
      createBaseState({
        spec: {
          language: "TypeScript",
          filesToCreate: [],
        },
        manifest: { services: [{ name: "app", port: 10000, description: "demo" }], environment: {}, sharedConfig: {} },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(installCalls, 2);
    assert.equal(buildCalls, 1);
    assert.equal(result.containerId, "abc123def456");
    assert.equal(result.testResults, "");
    assert.equal(result.lastFailedNode, "");
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    FindFreePortSkill.config.run = originalFindPort;
    await removeTempWorkspace(workspace);
  }
});

test("infra setup executes compose container commands from /app explicitly", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalFindPort = FindFreePortSkill.config.run;
  const commands = [];

  await require("fs/promises").writeFile(
    require("path").join(workspace, "package.json"),
    JSON.stringify({
      name: "demo",
      scripts: { build: "tsc" },
    }, null, 2),
    "utf-8"
  );
  await require("fs/promises").writeFile(
    require("path").join(workspace, "docker-compose.yml"),
    [
      "version: '3.8'",
      "",
      "services:",
      "  health-check-service:",
      "    build:",
      "      context: .",
      "    ports:",
      "      - \"4000:10000\"",
    ].join("\n"),
    "utf-8"
  );

  FindFreePortSkill.config.run = async () => "4123";
  ShellExecuteSkill.config.run = async ({ command }) => {
    commands.push(command);
    if (command.includes("docker-compose down")) {
      return "Output:\ndown\nErrors:\n";
    }
    if (command.includes("docker-compose rm")) {
      return "Output:\nremoved\nErrors:\n";
    }
    if (command.includes("docker-compose build health-check-service")) {
      return "Output:\nbuilt\nErrors:\n";
    }
    if (command.includes('docker-compose run -d --service-ports health-check-service sh -c "tail -f /dev/null"')) {
      return "Output:\nabc123def456\nErrors:\n";
    }
    if (command.includes('docker exec -w /app abc123def456 sh -c "NODE_ENV=development npm install --include=dev --silent"')) {
      return "Output:\ninstalled\nErrors:\n";
    }
    if (command.includes('docker exec -w /app abc123def456 sh -c "npm run build"')) {
      return "Output:\nbuilt\nErrors:\n";
    }
    throw new Error(`unexpected command: ${command}`);
  };

  try {
    const result = await infraNode(
      createBaseState({
        spec: {
          language: "TypeScript",
          filesToCreate: [],
        },
        manifest: { services: [{ name: "app", port: 10000, description: "demo" }], environment: {}, sharedConfig: {} },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.containerId, "abc123def456");
    assert.equal(result.testResults, "");
    assert.equal(
      commands.some((command) => command.includes('docker exec -w /app abc123def456 sh -c "NODE_ENV=development npm install --include=dev --silent"')),
      true
    );
    assert.equal(
      commands.some((command) => command.includes('docker exec -w /app abc123def456 sh -c "npm run build"')),
      true
    );
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    FindFreePortSkill.config.run = originalFindPort;
    await removeTempWorkspace(workspace);
  }
});

test("infra setup reuses allocated host port on runtime-gap retries instead of reallocating a new one", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalFindPort = FindFreePortSkill.config.run;
  const dockerRunCommands = [];

  FindFreePortSkill.config.run = async () => "4123";
  ShellExecuteSkill.config.run = async ({ command }) => {
    if (command.startsWith("docker rm -f")) {
      return "Output:\nremoved\nErrors:\n";
    }
    if (command.startsWith("docker run -d")) {
      dockerRunCommands.push(command);
      return "Output:\nabc123def456\nErrors:\n";
    }
    throw new Error(`unexpected command: ${command}`);
  };

  try {
    const result = await infraNode(
      createBaseState({
        allocatedHostPort: 4555,
        validationReport: {
          version: "v1",
          status: "fail",
          failureType: "runtime_gap",
          blocking: true,
          findings: [{ type: "runtime_gap", summary: "端口错配", file: "src/index.ts", evidence: ["端口错配"] }],
        },
        repairPlan: {
          version: "v1",
          repairType: "runtime",
          targets: ["src/index.ts"],
          allowedEdits: ["src/index.ts"],
          expectedEvidence: ["端口错配"],
        },
        spec: {
          language: "TypeScript",
          filesToCreate: [],
        },
        manifest: { services: [{ name: "app", port: 10000, description: "demo" }], environment: {}, sharedConfig: {} },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.allocatedHostPort, 4555);
    assert.match(dockerRunCommands[0] || "", /-p 4555:10000/);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    FindFreePortSkill.config.run = originalFindPort;
    await removeTempWorkspace(workspace);
  }
});

test("infra setup cleans stale runtime process before install when deploy evidence shows EADDRINUSE", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalFindPort = FindFreePortSkill.config.run;
  const commands = [];

  await require("fs/promises").writeFile(
    require("path").join(workspace, "package.json"),
    JSON.stringify({
      name: "demo",
      scripts: { start: "npm start" },
    }, null, 2),
    "utf-8"
  );

  FindFreePortSkill.config.run = async () => "4123";
  ShellExecuteSkill.config.run = async ({ command }) => {
    commands.push(command);
    if (command.startsWith("docker rm -f")) {
      return "Output:\nremoved\nErrors:\n";
    }
    if (command.startsWith("docker run -d")) {
      return "Output:\nabc123def456\nErrors:\n";
    }
    if (command.includes('docker exec -w /app abc123def456 sh -c "if [ -f /tmp/jimclaw/server.pid ]')) {
      return "Output:\ncleaned\nErrors:\n";
    }
    if (command.includes('docker exec -w /app abc123def456 sh -c "npm install --silent"')) {
      return "Output:\ninstalled\nErrors:\n";
    }
    throw new Error(`unexpected command: ${command}`);
  };

  try {
    const result = await infraNode(
      createBaseState({
        lastFailureSummary: "服务启动崩溃：监听端口已被占用（EADDRINUSE）",
        validationReport: {
          version: "v1",
          status: "fail",
          failureType: "runtime_gap",
          blocking: true,
          findings: [{ type: "runtime_gap", summary: "EADDRINUSE", file: "src/index.ts", evidence: ["EADDRINUSE"] }],
        },
        repairPlan: {
          version: "v1",
          repairType: "runtime",
          targets: ["src/index.ts"],
          allowedEdits: ["src/index.ts"],
          expectedEvidence: ["EADDRINUSE"],
        },
        spec: {
          language: "TypeScript",
          filesToCreate: [],
        },
        manifest: { services: [{ name: "app", port: 10000, description: "demo" }], environment: {}, sharedConfig: {} },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.containerId, "abc123def456");
    assert.equal(commands.some((command) => command.includes('docker exec -w /app abc123def456 sh -c "if [ -f /tmp/jimclaw/server.pid ]')), true);
    assert.equal(commands.some((command) => command.includes('docker exec -w /app abc123def456 sh -c "npm install --silent"')), true);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    FindFreePortSkill.config.run = originalFindPort;
    await removeTempWorkspace(workspace);
  }
});

test("infra setup uses host backend install and build when execution backend is host", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalFindPort = FindFreePortSkill.config.run;
  const executorCalls = [];

  await require("fs/promises").writeFile(
    require("path").join(workspace, "package.json"),
    JSON.stringify({
      name: "demo",
      scripts: { build: "tsc", test: "npm test" },
    }, null, 2),
    "utf-8"
  );

  FindFreePortSkill.config.run = async () => "4123";

  try {
    const result = await infraNode(
      createBaseState({
        executionBackend: "host",
        spec: {
          language: "TypeScript",
          filesToCreate: [],
        },
        manifest: { services: [{ name: "app", port: 10000, description: "demo" }], environment: {}, sharedConfig: {} },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save,
      {
        commandExecutor: {
          executeIntent: async (intent) => {
            executorCalls.push({ kind: intent.kind, command: intent.command });
            return {
              ok: true,
              backend: "local_shell",
              stdout: "ok",
              stderr: "",
              retryable: false,
              requiresApproval: false,
              blocked: false,
            };
          },
        },
      }
    );

    assert.equal(result.executionBackend, "host");
    assert.equal(result.containerId, "");
    assert.equal(result.allocatedHostPort, 4123);
    assert.deepEqual(executorCalls, [
      { kind: "install_deps", command: "npm install --silent" },
      { kind: "build_workspace", command: "npm run build" },
    ]);
  } finally {
    FindFreePortSkill.config.run = originalFindPort;
    await removeTempWorkspace(workspace);
  }
});

test("infra setup routes host install and build through command executor instead of direct shell install", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalFindPort = FindFreePortSkill.config.run;
  const executorCalls = [];

  await require("fs/promises").writeFile(
    require("path").join(workspace, "package.json"),
    JSON.stringify({
      name: "demo",
      scripts: { build: "tsc" },
    }, null, 2),
    "utf-8"
  );

  FindFreePortSkill.config.run = async () => "4123";
  ShellExecuteSkill.config.run = async ({ command }) => {
    throw new Error(`unexpected direct shell command: ${command}`);
  };

  try {
    const result = await infraNode(
      createBaseState({
        executionBackend: "host",
        spec: {
          language: "TypeScript",
          filesToCreate: [],
        },
        manifest: { services: [{ name: "app", port: 10000, description: "demo" }], environment: {}, sharedConfig: {} },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save,
      {
        commandExecutor: {
          executeIntent: async (intent) => {
            executorCalls.push(intent.kind);
            return {
              ok: true,
              backend: "local_shell",
              stdout: intent.kind,
              stderr: "",
              retryable: false,
              requiresApproval: false,
              blocked: false,
            };
          },
        },
      }
    );

    assert.equal(result.executionBackend, "host");
    assert.deepEqual(executorCalls, ["install_deps", "build_workspace"]);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    FindFreePortSkill.config.run = originalFindPort;
    await removeTempWorkspace(workspace);
  }
});

test("infra setup stops and enters pending recovery when executor requires approval", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalFindPort = FindFreePortSkill.config.run;
  const shellCalls = [];

  await require("fs/promises").writeFile(
    require("path").join(workspace, "package.json"),
    JSON.stringify({ name: "demo" }, null, 2),
    "utf-8"
  );

  FindFreePortSkill.config.run = async () => "4123";
  ShellExecuteSkill.config.run = async ({ command }) => {
    shellCalls.push(command);
    throw new Error(`unexpected direct shell command: ${command}`);
  };

  try {
    const result = await infraNode(
      createBaseState({
        executionBackend: "host",
        spec: {
          language: "TypeScript",
          filesToCreate: [],
        },
        manifest: { services: [{ name: "app", port: 10000, description: "demo" }], environment: {}, sharedConfig: {} },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save,
      {
        commandExecutor: {
          executeIntent: async () => ({
            ok: false,
            backend: "local_shell",
            stdout: "",
            stderr: "",
            retryable: false,
            requiresApproval: true,
            approvalTicketId: "ticket-infra",
            blocked: true,
            blockedReason: "approval required for install_deps",
          }),
        },
      }
    );

    assert.equal(result.agentRecoveryPending, true);
    assert.equal(result.containerId, "");
    assert.equal(result.executorState?.lastExecutorResult?.requiresApproval, true);
    assert.equal(result.executorState?.lastExecutorResult?.approvalTicketId, "ticket-infra");
    assert.equal(shellCalls.length, 0);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    FindFreePortSkill.config.run = originalFindPort;
    await removeTempWorkspace(workspace);
  }
});

test("infra setup maps executor unavailable failures to environment gaps", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalFindPort = FindFreePortSkill.config.run;

  await require("fs/promises").writeFile(
    require("path").join(workspace, "package.json"),
    JSON.stringify({ name: "demo" }, null, 2),
    "utf-8"
  );

  FindFreePortSkill.config.run = async () => "4123";
  ShellExecuteSkill.config.run = async ({ command }) => {
    throw new Error(`unexpected direct shell command: ${command}`);
  };

  try {
    const result = await infraNode(
      createBaseState({
        executionBackend: "host",
        spec: {
          language: "TypeScript",
          filesToCreate: [],
        },
        manifest: { services: [{ name: "app", port: 10000, description: "demo" }], environment: {}, sharedConfig: {} },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save,
      {
        commandExecutor: {
          executeIntent: async () => ({
            ok: false,
            backend: null,
            stdout: "",
            stderr: "spawn EPERM",
            retryable: false,
            requiresApproval: false,
            blocked: true,
            blockedReason: "no backend available",
            failureType: "executor_unavailable",
          }),
        },
      }
    );

    assert.equal(result.containerId, "");
    assert.equal(result.validationReport?.failureType, "environment_gap");
    assert.match(result.blockedReason || "", /宿主环境阻塞|no backend available/i);
    assert.equal(result.lastFailedNode, "infra_setup");
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    FindFreePortSkill.config.run = originalFindPort;
    await removeTempWorkspace(workspace);
  }
});

test("infra setup emits heartbeat snapshots during host install stage", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalFindPort = FindFreePortSkill.config.run;
  const originalHeartbeat = process.env.JIMCLAW_HEARTBEAT_INTERVAL_MS;

  await require("fs/promises").writeFile(
    require("path").join(workspace, "package.json"),
    JSON.stringify({ name: "demo" }, null, 2),
    "utf-8"
  );

  FindFreePortSkill.config.run = async () => "4123";
  process.env.JIMCLAW_HEARTBEAT_INTERVAL_MS = "5";

  try {
    await infraNode(
      createBaseState({
        executionBackend: "host",
        spec: {
          language: "TypeScript",
          filesToCreate: [],
        },
        manifest: { services: [{ name: "app", port: 10000, description: "demo" }], environment: {}, sharedConfig: {} },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save,
      {
        commandExecutor: {
          executeIntent: async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return {
              ok: true,
              backend: "local_shell",
              stdout: "ok",
              stderr: "",
              retryable: false,
              requiresApproval: false,
              blocked: false,
            };
          },
        },
      }
    );

    const nodes = recorder.snapshots.map((item) => item.node);
    assert.equal(nodes.includes("infra_setup_stage_installing"), true);
    assert.equal(nodes.some((node) => node === "infra_setup_heartbeat_install"), true);
  } finally {
    FindFreePortSkill.config.run = originalFindPort;
    if (originalHeartbeat === undefined) {
      delete process.env.JIMCLAW_HEARTBEAT_INTERVAL_MS;
    } else {
      process.env.JIMCLAW_HEARTBEAT_INTERVAL_MS = originalHeartbeat;
    }
    await removeTempWorkspace(workspace);
  }
});
