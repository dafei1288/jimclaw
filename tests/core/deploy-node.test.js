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
  const command = buildDeployLaunchCommand("npm start", { port: 10000 });

  assert.match(command, /server\.pid/);
  assert.match(command, /server\.log/);
  assert.match(command, /PORT=10000/);
  assert.match(command, /HOST=0\.0\.0\.0/);
  assert.match(command, /nohup sh -c "PORT=10000 HOST=0\.0\.0\.0 npm start"/);
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
      executionBackend: "host",
      containerId: "",
      lastFailedNode: "",
      lastFailureSummary: "",
    }),
    null
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

  global.setTimeout = ((fn, _ms, ...args) => {
    fn(...args);
    return 0;
  });

  GetServerIPSkill.config.run = async () => "127.0.0.1";
  ShellExecuteSkill.config.run = async ({ command }) => {
    if (command.startsWith("curl ")) {
      return launchCalls >= 2 ? "Output:\n200\nErrors:\n" : "Output:\n000\nErrors:\n";
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
      recorder.save,
      {
        commandExecutor: {
          executeIntent: async () => {
            launchCalls += 1;
            if (launchCalls === 1) {
              return {
                ok: false,
                backend: "docker",
                stdout: "",
                stderr: "OCI runtime exec failed: exec failed: container is not running",
                retryable: true,
                requiresApproval: false,
                blocked: false,
                failureType: "executor_unavailable",
              };
            }
            return {
              ok: true,
              backend: "docker",
              stdout: "",
              stderr: "",
              retryable: false,
              requiresApproval: false,
              blocked: false,
            };
          },
        },
      }
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

test("deploy starts and verifies service on host backend without requiring container", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalGetServerIP = GetServerIPSkill.config.run;
  const originalSetTimeout = global.setTimeout;
  const executorCalls = [];
  const commands = [];

  global.setTimeout = ((fn, _ms, ...args) => {
    fn(...args);
    return 0;
  });

  GetServerIPSkill.config.run = async () => "127.0.0.1";
  ShellExecuteSkill.config.run = async ({ command, workDir }) => {
    commands.push({ command, workDir });
    if (command.startsWith("powershell -NoProfile -Command") || command.startsWith("mkdir -p .jimclaw")) {
      return "Output:\n4321\nErrors:\n";
    }
    if (command.startsWith("curl ")) {
      return "Output:\n200\nErrors:\n";
    }
    throw new Error(`unexpected command: ${command}`);
  };

  try {
    const result = await deployNode(
      createBaseState({
        executionBackend: "host",
        containerId: "",
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
      recorder.save,
      {
        commandExecutor: {
          executeIntent: async (intent) => {
            executorCalls.push(intent);
            return {
              ok: true,
              backend: "local_shell",
              stdout: "4321",
              stderr: "",
              retryable: false,
              requiresApproval: false,
              blocked: false,
            };
          },
        },
      }
    );

    assert.equal(result.deploymentStatus.status, "running");
    assert.equal(executorCalls.length, 1);
    assert.equal(executorCalls[0].kind, "start_runtime");
    assert.equal(executorCalls[0].workspace, workspace);
    assert.equal(commands.some((item) => item.command.startsWith("curl ")), true);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    GetServerIPSkill.config.run = originalGetServerIP;
    global.setTimeout = originalSetTimeout;
    await removeTempWorkspace(workspace);
  }
});

test("deploy host backend uses a valid windows powershell -Command separator", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalGetServerIP = GetServerIPSkill.config.run;
  const originalSetTimeout = global.setTimeout;
  const executorCalls = [];

  global.setTimeout = ((fn, _ms, ...args) => {
    fn(...args);
    return 0;
  });

  GetServerIPSkill.config.run = async () => "127.0.0.1";
  ShellExecuteSkill.config.run = async ({ command }) => {
    if (command.startsWith("curl ")) {
      return "Output:\n200\nErrors:\n";
    }
    throw new Error(`unexpected command: ${command}`);
  };

  try {
    await deployNode(
      createBaseState({
        executionBackend: "host",
        containerId: "",
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
      recorder.save,
      {
        commandExecutor: {
          executeIntent: async (intent) => {
            executorCalls.push(intent);
            return {
              ok: true,
              backend: "local_shell",
              stdout: "4321",
              stderr: "",
              retryable: false,
              requiresApproval: false,
              blocked: false,
            };
          },
        },
      }
    );

    const hostLaunch = executorCalls.find((item) => item.command.startsWith("powershell -NoProfile -Command "));
    assert.equal(Boolean(hostLaunch), true);
    assert.match(hostLaunch.command, /^powershell -NoProfile -Command "/);
    if (process.platform === "win32") {
      assert.match(hostLaunch.command, /RedirectStandardOutput \$stdoutLogPath/);
      assert.match(hostLaunch.command, /RedirectStandardError \$stderrLogPath/);
      assert.doesNotMatch(hostLaunch.command, /RedirectStandardOutput \$logPath -RedirectStandardError \$logPath/);
    }
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    GetServerIPSkill.config.run = originalGetServerIP;
    global.setTimeout = originalSetTimeout;
    await removeTempWorkspace(workspace);
  }
});

test("deploy host backend fails fast when launch output has no valid pid", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalGetServerIP = GetServerIPSkill.config.run;
  const originalSetTimeout = global.setTimeout;
  let curlCalled = false;

  global.setTimeout = ((fn, _ms, ...args) => {
    fn(...args);
    return 0;
  });

  GetServerIPSkill.config.run = async () => "127.0.0.1";
  ShellExecuteSkill.config.run = async ({ command }) => {
    if (command.startsWith("powershell -NoProfile -Command ") || command.startsWith("mkdir -p .jimclaw")) {
      return [
        "Output:",
        "PID=",
        "",
        "Errors:",
        "Start-Process : RedirectStandardOutput and RedirectStandardError are same.",
      ].join("\n");
    }
    if (command.startsWith("curl ")) {
      curlCalled = true;
      return "Output:\n000\nErrors:\n";
    }
    throw new Error(`unexpected command: ${command}`);
  };

  try {
    const result = await deployNode(
      createBaseState({
        executionBackend: "host",
        containerId: "",
        allocatedHostPort: 4000,
        manifest: { services: [{ name: "app", port: 10000, description: "demo" }], environment: {}, sharedConfig: {} },
        spec: {
          language: "TypeScript",
          filesToCreate: [],
          entryPoint: "src/index.ts",
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

    assert.equal(result.deploymentStatus.status, "failed");
    assert.equal(result.lastFailedNode, "deploy");
    assert.match(result.lastFailureSummary || "", /部署启动失败/);
    assert.equal(curlCalled, false);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    GetServerIPSkill.config.run = originalGetServerIP;
    global.setTimeout = originalSetTimeout;
    await removeTempWorkspace(workspace);
  }
});

test("deploy failure emits structured runtime gap diagnostics instead of raw text only", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalGetServerIP = GetServerIPSkill.config.run;
  const originalSetTimeout = global.setTimeout;

  global.setTimeout = ((fn, _ms, ...args) => {
    fn(...args);
    return 0;
  });

  GetServerIPSkill.config.run = async () => "127.0.0.1";
  ShellExecuteSkill.config.run = async ({ command }) => {
    if (command.startsWith("curl ")) {
      return "Output:\n000\nErrors:\n";
    }
    if (command.startsWith("docker exec container-123 sh -c \"netstat")) {
      return "Output:\n\nErrors:\n";
    }
    if (command.startsWith("docker exec container-123 sh -c \"cat /tmp/jimclaw/server.log")) {
      return "Output:\nlisten EADDRNOTAVAIL\nErrors:\n";
    }
    if (command.startsWith("docker exec container-123 sh -c \"cat /tmp/jimclaw/server.pid")) {
      return "Output:\n123\nErrors:\n";
    }
    if (command.startsWith("docker logs container-123")) {
      return "Output:\napp crashed on startup\nlisten EADDRNOTAVAIL\nErrors:\n";
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
          entryPoint: "src/index.ts",
          runCommand: "npm start",
        },
        deploymentStatus: { status: "none" },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save,
      {
        commandExecutor: {
          executeIntent: async () => ({
            ok: true,
            backend: "docker",
            stdout: "",
            stderr: "",
            retryable: false,
            requiresApproval: false,
            blocked: false,
          }),
        },
      }
    );

    assert.equal(result.deploymentStatus.status, "failed");
    assert.equal(result.validationReport.failureType, "runtime_gap");
    assert.equal(result.repairPlan.repairType, "runtime");
    assert.match(result.lastFailureSummary || "", /EADDRNOTAVAIL|监听地址不可用|部署验证失败/);
    assert.equal(result.protocolFailures.some((item) => item.type === "runtime_mismatch"), true);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    GetServerIPSkill.config.run = originalGetServerIP;
    global.setTimeout = originalSetTimeout;
    await removeTempWorkspace(workspace);
  }
});

test("deploy falls back to alternate reachable health path before classifying runtime failure", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalGetServerIP = GetServerIPSkill.config.run;
  const originalSetTimeout = global.setTimeout;
  const curlCommands = [];

  global.setTimeout = ((fn, _ms, ...args) => {
    fn(...args);
    return 0;
  });

  GetServerIPSkill.config.run = async () => "127.0.0.1";
  ShellExecuteSkill.config.run = async ({ command }) => {
    if (command.startsWith("curl ")) {
      curlCommands.push(command);
      if (command.includes("http://127.0.0.1:4000/api/health")) {
        return "Output:\n000\nErrors:\n";
      }
      if (command.includes("http://127.0.0.1:4000/")) {
        return "Output:\n200\nErrors:\n";
      }
      return "Output:\n000\nErrors:\n";
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
        executionProtocol: {
          runtime: { healthCheckPath: "/api/health" },
        },
        deploymentStatus: { status: "none" },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save,
      {
        commandExecutor: {
          executeIntent: async () => ({
            ok: true,
            backend: "docker",
            stdout: "",
            stderr: "",
            retryable: false,
            requiresApproval: false,
            blocked: false,
          }),
        },
      }
    );

    assert.equal(result.deploymentStatus.status, "running");
    assert.equal(curlCommands.some((command) => command.includes("http://127.0.0.1:4000/api/health")), true);
    assert.equal(curlCommands.some((command) => command.includes("http://127.0.0.1:4000/")), true);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    GetServerIPSkill.config.run = originalGetServerIP;
    global.setTimeout = originalSetTimeout;
    await removeTempWorkspace(workspace);
  }
});

test("deploy routes runtime launch through command executor start_runtime intent", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalGetServerIP = GetServerIPSkill.config.run;
  const originalSetTimeout = global.setTimeout;
  const executorCalls = [];
  const curlCommands = [];

  global.setTimeout = ((fn, _ms, ...args) => {
    fn(...args);
    return 0;
  });

  GetServerIPSkill.config.run = async () => "127.0.0.1";
  ShellExecuteSkill.config.run = async ({ command }) => {
    if (command.startsWith("curl ")) {
      curlCommands.push(command);
      return "Output:\n200\nErrors:\n";
    }
    throw new Error(`unexpected shell command: ${command}`);
  };

  try {
    const result = await deployNode(
      createBaseState({
        executionBackend: "host",
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
      recorder.save,
      {
        commandExecutor: {
          executeIntent: async (intent) => {
            executorCalls.push(intent);
            return {
              ok: true,
              backend: "local_shell",
              stdout: "4321",
              stderr: "",
              retryable: false,
              requiresApproval: false,
              blocked: false,
              artifacts: {
                pidPath: `${workspace}\\.jimclaw\\server.pid`,
                stdoutLogPath: `${workspace}\\.jimclaw\\server.stdout.log`,
                stderrLogPath: `${workspace}\\.jimclaw\\server.stderr.log`,
              },
            };
          },
        },
      }
    );

    assert.equal(result.deploymentStatus.status, "running");
    assert.equal(executorCalls.length, 1);
    assert.equal(executorCalls[0].kind, "start_runtime");
    assert.equal(curlCommands.length > 0, true);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    GetServerIPSkill.config.run = originalGetServerIP;
    global.setTimeout = originalSetTimeout;
    await removeTempWorkspace(workspace);
  }
});

test("deploy enters pending recovery when start_runtime requires approval and skips health checks", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalGetServerIP = GetServerIPSkill.config.run;
  const originalSetTimeout = global.setTimeout;
  let curlCalled = false;

  global.setTimeout = ((fn, _ms, ...args) => {
    fn(...args);
    return 0;
  });

  GetServerIPSkill.config.run = async () => "127.0.0.1";
  ShellExecuteSkill.config.run = async ({ command }) => {
    if (command.startsWith("curl ")) {
      curlCalled = true;
    }
    throw new Error(`unexpected shell command: ${command}`);
  };

  try {
    const result = await deployNode(
      createBaseState({
        executionBackend: "host",
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
            approvalTicketId: "ticket-deploy",
            blocked: true,
            blockedReason: "approval required for start_runtime",
          }),
        },
      }
    );

    assert.equal(result.agentRecoveryPending, true);
    assert.equal(result.executorState?.lastExecutorResult?.approvalTicketId, "ticket-deploy");
    assert.equal(result.deploymentStatus?.status, "failed");
    assert.equal(curlCalled, false);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    GetServerIPSkill.config.run = originalGetServerIP;
    global.setTimeout = originalSetTimeout;
    await removeTempWorkspace(workspace);
  }
});

test("deploy maps blocked runtime start executor failures to structured runtime or environment gaps", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalGetServerIP = GetServerIPSkill.config.run;
  const originalSetTimeout = global.setTimeout;

  global.setTimeout = ((fn, _ms, ...args) => {
    fn(...args);
    return 0;
  });

  GetServerIPSkill.config.run = async () => "127.0.0.1";

  try {
    const result = await deployNode(
      createBaseState({
        executionBackend: "host",
        allocatedHostPort: 4000,
        manifest: { services: [{ name: "app", port: 10000, description: "demo" }], environment: {}, sharedConfig: {} },
        spec: {
          language: "TypeScript",
          filesToCreate: [],
          entryPoint: "src/index.ts",
          runCommand: "npm start",
        },
        deploymentStatus: { status: "none" },
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

    assert.equal(result.deploymentStatus.status, "failed");
    assert.equal(result.validationReport.failureType, "environment_gap");
    assert.equal(result.lastFailedNode, "deploy");
    assert.match(result.lastFailureSummary || "", /部署启动失败|no backend available|spawn EPERM/i);
  } finally {
    GetServerIPSkill.config.run = originalGetServerIP;
    global.setTimeout = originalSetTimeout;
    await removeTempWorkspace(workspace);
  }
});
