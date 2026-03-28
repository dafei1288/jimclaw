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
const { GetServerIPSkill } = require("../../src/skills/get_server_ip");

require("ts-node/register/transpile-only");

const {
  buildDeploymentUrls,
  buildDeployLaunchCommand,
  getHealthCheckPath,
  getDeployPreconditionFailure,
  deployNode,
} = require("../../src/core/nodes/deploy_node");

test("deploy health check uses localhost while preserving public url for display", () => {
  const result = buildDeploymentUrls("100.74.126.56", "4001");

  assert.equal(result.publicUrl, "http://100.74.126.56:4001");
  assert.equal(result.healthCheckUrl, "http://127.0.0.1:4001");
});

test("deploy launch command persists pid and startup log paths", () => {
  const command = buildDeployLaunchCommand("npm start");

  assert.match(command, /server\.pid/);
  assert.match(command, /server\.log/);
  assert.match(command, /nohup sh -c "npm start"/);
});

test("deploy health check path prefers protocol runtime then dedicated health endpoints", () => {
  const path = getHealthCheckPath({
    apiContract: {
      endpoints: [
        { method: "POST", path: "/api/login" },
        { method: "GET", path: "/api/health" },
      ],
    },
  });

  assert.equal(path, "/api/health");
  assert.equal(
    getHealthCheckPath({
      executionProtocol: { runtime: { healthCheckPath: "/api/health" } },
      apiContract: { endpoints: [{ method: "GET", path: "/api/books" }] },
    }),
    "/api/health"
  );
  assert.equal(
    getHealthCheckPath({
      apiContract: { endpoints: [{ method: "GET", path: "/health" }] },
    }),
    "/health"
  );
  assert.equal(getHealthCheckPath({ apiContract: { endpoints: [] } }), "/");
});

test("deploy precondition failure blocks deploy when current infra state already failed", () => {
  assert.match(
    getDeployPreconditionFailure({
      containerId: "jimclaw-test",
      lastFailedNode: "infra_setup",
      lastFailureSummary: "[基础设施构建失败] docker-compose 构建错误",
    }) || "",
    /基础设施构建/
  );

  assert.match(
    getDeployPreconditionFailure({
      containerId: "jimclaw-test",
      lastFailedNode: "infra_setup",
      lastFailureSummary: "failed to connect to the docker API at npipe",
    }) || "",
    /Docker 守护进程/
  );

  assert.equal(
    getDeployPreconditionFailure({
      containerId: "jimclaw-test",
      testResults: "[基础设施构建失败] 这是历史日志，不应继续阻塞当前 deploy",
      lastFailedNode: "",
      lastFailureSummary: "",
    }),
    null
  );

  assert.match(
    getDeployPreconditionFailure({
      containerId: "",
      lastFailedNode: "",
      lastFailureSummary: "",
    }) || "",
    /未获得可用容器/
  );

  assert.equal(
    getDeployPreconditionFailure({
      containerId: "jimclaw-test",
      lastFailedNode: "",
      lastFailureSummary: "",
    }),
    null
  );
});

test("deploy retries transient launch exec failure before final health verification", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalGetServerIP = GetServerIPSkill.config.run;
  const originalSetTimeout = global.setTimeout;
  let launchCalls = 0;
  let launchReady = false;

  global.setTimeout = ((fn, _ms, ...args) => {
    fn(...args);
    return 0;
  });

  GetServerIPSkill.config.run = async () => "127.0.0.1";
  ShellExecuteSkill.config.run = async ({ command }) => {
    if (command.startsWith('docker exec -d container-123 sh -c')) {
      launchCalls += 1;
      if (launchCalls === 1) {
        return [
          "Command failed with exit code 137.",
          "Output:",
          "",
          "Errors:",
          "OCI runtime exec failed: exec failed: container is not running",
        ].join("\n");
      }
      launchReady = true;
      return "Output:\n\nErrors:\n";
    }
    if (command.startsWith("curl ")) {
      return launchReady ? "Output:\n200\nErrors:\n" : "Output:\n000\nErrors:\n";
    }
    throw new Error(`unexpected command: ${command}`);
  };

  try {
    const result = await deployNode(
      createBaseState({
        containerId: "container-123",
        allocatedHostPort: 4000,
        manifest: { services: [{ name: "app", port: 10000, description: "demo" }], environment: {}, sharedConfig: {} },
        spec: {
          language: "TypeScript",
          filesToCreate: [],
          runCommand: "npm start",
        },
        deploymentStatus: { status: "none" },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(launchCalls, 2);
    assert.equal(result.deploymentStatus.status, "running");
    assert.equal(result.lastFailedNode, "");
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    GetServerIPSkill.config.run = originalGetServerIP;
    global.setTimeout = originalSetTimeout;
    await removeTempWorkspace(workspace);
  }
});
