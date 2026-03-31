require("ts-node/register/transpile-only");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const childProcess = require("child_process");
let {
  probeLocalShellCapability,
  probeDockerCapability,
  probeExecutionCapabilities,
} = require("../../src/executor/capability_probe");

const successRunner = async () => ({ stdout: "ok", stderr: "", code: 0, error: undefined });

test("local shell capability returns false when spawn throws synchronously", async () => {
  const runner = () => {
    throw new Error("spawn EPERM");
  };
  const local = await probeLocalShellCapability("/tmp", runner);
  assert.equal(local.available, false);
  assert.equal(local.reason, "spawn EPERM");
});

test("default runner also converts synchronous spawn errors into unavailable local shell", async () => {
  const originalSpawn = childProcess.spawn;
  delete require.cache[require.resolve("../../src/executor/capability_probe")];
  childProcess.spawn = () => {
    throw new Error("spawn EPERM");
  };

  try {
    ({ probeLocalShellCapability } = require("../../src/executor/capability_probe"));
    const local = await probeLocalShellCapability("/tmp");
    assert.equal(local.available, false);
    assert.equal(local.reason, "spawn EPERM");
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[require.resolve("../../src/executor/capability_probe")];
    ({ probeLocalShellCapability, probeDockerCapability, probeExecutionCapabilities } = require("../../src/executor/capability_probe"));
  }
});

test("docker capability reports CLI missing separately from daemon", async () => {
  const missingCli = await probeDockerCapability("/tmp", async () => ({
    stdout: "",
    stderr: "",
    code: null,
    error: new Error("spawn ENOENT"),
  }));
  assert.equal(missingCli.cliAvailable, false);
  assert.equal(missingCli.daemonReachable, false);

  const daemonErr = await probeDockerCapability("/tmp", async () => ({
    stdout: "",
    stderr: "failed to connect to the docker API",
    code: null,
    error: new Error("spawn EPERM"),
  }));
  assert.equal(daemonErr.cliAvailable, true);
  assert.equal(daemonErr.daemonReachable, false);
});

test("execution capability returns default placeholders for network/background fields", async () => {
  const probe = await probeExecutionCapabilities("/tmp", async ({ command }) => {
    if (command.startsWith("docker")) {
      return { stdout: "20.10", stderr: "", code: 0, error: undefined };
    }
    return { stdout: "ok", stderr: "", code: 0, error: undefined };
  });
  assert.equal(probe.localShell.available, true);
  assert.equal(probe.docker.daemonReachable, true);
  assert.equal(probe.network.outboundAllowed, true);
  assert.equal(probe.backgroundProcess.available, true);
});
