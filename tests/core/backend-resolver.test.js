require("ts-node/register/transpile-only");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resolveBackendForIntent } = require("../../src/executor/backend_resolver");

function buildSnapshot({ docker, local, network }) {
  return {
    version: "v1",
    localShell: local ?? { available: false },
    docker: docker ?? { cliAvailable: false, daemonReachable: false },
    network: network ?? { outboundAllowed: true },
    backgroundProcess: { available: local?.available || false },
  };
}

test("install_deps prefers docker when available", async () => {
  const resolution = await resolveBackendForIntent(
    { kind: "install_deps" },
    buildSnapshot({
      docker: { cliAvailable: true, daemonReachable: true },
      local: { available: true },
    })
  );
  assert.equal(resolution.selected, "docker");
  assert.equal(resolution.candidates.includes("docker"), true);
});

test("install_deps falls back to local_shell when docker unreachable", async () => {
  const resolution = await resolveBackendForIntent(
    { kind: "install_deps" },
    buildSnapshot({
      docker: { cliAvailable: true, daemonReachable: false },
      local: { available: true },
    })
  );
  assert.equal(resolution.selected, "local_shell");
});

test("blocked when no backend available", async () => {
  const resolution = await resolveBackendForIntent(
    { kind: "install_deps" },
    buildSnapshot({})
  );
  assert.equal(resolution.blocked, true);
  assert.equal(resolution.selected, null);
});

test("blocked when docker CLI exists but daemon is unreachable and no local shell is available", async () => {
  const resolution = await resolveBackendForIntent(
    { kind: "install_deps" },
    buildSnapshot({
      docker: { cliAvailable: true, daemonReachable: false },
      local: { available: false },
    })
  );
  assert.equal(resolution.blocked, true);
  assert.equal(resolution.selected, null);
});

test("requiresApproval toggles when network disallowed", async () => {
  const resolution = await resolveBackendForIntent(
    { kind: "install_deps", requiresNetwork: true },
    buildSnapshot({
      docker: { cliAvailable: true, daemonReachable: true },
      network: { outboundAllowed: false },
    })
  );
  assert.equal(resolution.requiresApproval, true);
  assert.equal(resolution.approvalScope, "network_install");
});

test("blocked no-backend state must not be turned into approval-required", async () => {
  const resolution = await resolveBackendForIntent(
    { kind: "install_deps", requiresNetwork: true },
    buildSnapshot({
      docker: { cliAvailable: false, daemonReachable: false },
      local: { available: false },
      network: { outboundAllowed: false },
    })
  );

  assert.equal(resolution.blocked, true);
  assert.equal(resolution.selected, null);
  assert.equal(resolution.requiresApproval, false);
  assert.equal(resolution.approvalScope, undefined);
});
