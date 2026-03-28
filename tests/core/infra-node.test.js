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
