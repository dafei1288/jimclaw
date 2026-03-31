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
    if (command.includes('docker exec abc123def456 sh -c "npm install --silent"')) {
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
    if (command.includes('docker exec abc123def456 sh -c "npm run build"')) {
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
    if (command.includes('docker exec abc123def456 sh -c "if [ -f /tmp/jimclaw/server.pid ]')) {
      return "Output:\ncleaned\nErrors:\n";
    }
    if (command.includes('docker exec abc123def456 sh -c "npm install --silent"')) {
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
    assert.equal(commands.some((command) => command.includes('docker exec abc123def456 sh -c "if [ -f /tmp/jimclaw/server.pid ]')), true);
    assert.equal(commands.some((command) => command.includes('docker exec abc123def456 sh -c "npm install --silent"')), true);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    FindFreePortSkill.config.run = originalFindPort;
    await removeTempWorkspace(workspace);
  }
});

test("infra setup uses host backend install and build when execution backend is host", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalFindPort = FindFreePortSkill.config.run;
  const commands = [];

  await require("fs/promises").writeFile(
    require("path").join(workspace, "package.json"),
    JSON.stringify({
      name: "demo",
      scripts: { build: "tsc", test: "npm test" },
    }, null, 2),
    "utf-8"
  );

  FindFreePortSkill.config.run = async () => "4123";
  ShellExecuteSkill.config.run = async ({ command, workDir }) => {
    commands.push({ command, workDir });
    if (command === "npm install --silent") {
      return "Output:\ninstalled\nErrors:\n";
    }
    if (command === "npm run build") {
      return "Output:\nbuilt\nErrors:\n";
    }
    throw new Error(`unexpected command: ${command}`);
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
      recorder.save
    );

    assert.equal(result.executionBackend, "host");
    assert.equal(result.containerId, "");
    assert.equal(result.allocatedHostPort, 4123);
    assert.equal(commands.some((item) => item.command.startsWith("docker ")), false);
    assert.equal(commands.filter((item) => item.command === "npm install --silent" && item.workDir === workspace).length, 1);
    assert.equal(commands.filter((item) => item.command === "npm run build" && item.workDir === workspace).length, 1);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    FindFreePortSkill.config.run = originalFindPort;
    await removeTempWorkspace(workspace);
  }
});
