require("ts-node/register/transpile-only");

const test = require("node:test");
const assert = require("node:assert/strict");

const { createCommandExecutor } = require("../../src/executor/command_executor");
const { createLocalShellAdapter } = require("../../src/skills/shell_exec");

function buildCapabilitySnapshot(overrides = {}) {
  return {
    version: "v1",
    localShell: { available: false, ...(overrides.localShell || {}) },
    docker: { cliAvailable: false, daemonReachable: false, ...(overrides.docker || {}) },
    externalExecutor: { available: false, ...(overrides.externalExecutor || {}) },
    network: { outboundAllowed: true, ...(overrides.network || {}) },
    backgroundProcess: { available: false, ...(overrides.backgroundProcess || {}) },
  };
}

test("command executor probes capabilities before resolving backend", async () => {
  const calls = [];
  const executor = createCommandExecutor({
    probeCapabilities: async () => {
      calls.push("probe");
      return buildCapabilitySnapshot({
        docker: { cliAvailable: true, daemonReachable: true },
      });
    },
    resolveBackend: async () => {
      calls.push("resolve");
      return {
        selected: "docker",
        candidates: ["docker"],
        blocked: false,
        requiresApproval: false,
      };
    },
    adapters: {},
  });

  await executor.executeIntent({
    kind: "install_deps",
    workspace: process.cwd(),
  });

  assert.deepEqual(calls, ["probe", "resolve"]);
});

test("command executor can resolve intent without executing adapters and still create approval ticket", async () => {
  const executor = createCommandExecutor({
    probeCapabilities: async () =>
      buildCapabilitySnapshot({
        docker: { cliAvailable: true, daemonReachable: true },
        network: { outboundAllowed: false },
      }),
    resolveBackend: async () => ({
      selected: "docker",
      candidates: ["docker"],
      blocked: false,
      requiresApproval: true,
      approvalScope: "network_install",
    }),
    createApprovalTicket: ({ stage, reason }) => ({
      id: "ticket-plan",
      stage,
      required: true,
      status: "pending",
      reason,
      requestedAt: new Date().toISOString(),
    }),
    adapters: {
      docker: {
        execute: async () => {
          throw new Error("should not execute adapter while planning");
        },
      },
    },
  });

  const plan = await executor.resolveIntent({
    kind: "install_deps",
    workspace: process.cwd(),
    requiresNetwork: true,
  });

  assert.equal(plan.resolution.selected, "docker");
  assert.equal(plan.resolution.requiresApproval, true);
  assert.equal(plan.approvalTicket?.id, "ticket-plan");
});

test("command executor returns blocked approval result with ticket when approval is required", async () => {
  const executor = createCommandExecutor({
    probeCapabilities: async () =>
      buildCapabilitySnapshot({
        docker: { cliAvailable: true, daemonReachable: true },
        network: { outboundAllowed: false },
      }),
    resolveBackend: async () => ({
      selected: "docker",
      candidates: ["docker"],
      blocked: false,
      requiresApproval: true,
      approvalScope: "network_install",
    }),
    createApprovalTicket: ({ stage, reason }) => ({
      id: "ticket-1",
      stage,
      required: true,
      status: "pending",
      reason,
      requestedAt: new Date().toISOString(),
    }),
    adapters: {},
  });

  const result = await executor.executeIntent({
    kind: "install_deps",
    workspace: process.cwd(),
    requiresNetwork: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.requiresApproval, true);
  assert.equal(result.approvalTicketId, "ticket-1");
});

test("command executor does not create approval tickets for blocked no-backend resolutions", async () => {
  let ticketCreated = false;
  const executor = createCommandExecutor({
    probeCapabilities: async () =>
      buildCapabilitySnapshot({
        docker: { cliAvailable: false, daemonReachable: false },
        localShell: { available: false },
        network: { outboundAllowed: false },
      }),
    resolveBackend: async () => ({
      selected: null,
      candidates: [],
      blocked: true,
      blockedReason: "no backend available",
      requiresApproval: true,
      approvalScope: "network_install",
    }),
    createApprovalTicket: () => {
      ticketCreated = true;
      return {
        id: "ticket-blocked",
        stage: "network_install",
        required: true,
        status: "pending",
        reason: "should not be created",
        requestedAt: new Date().toISOString(),
      };
    },
    adapters: {},
  });

  const result = await executor.executeIntent({
    kind: "install_deps",
    workspace: process.cwd(),
    requiresNetwork: true,
  });

  assert.equal(result.blocked, true);
  assert.equal(result.requiresApproval, false);
  assert.equal(result.approvalTicketId, undefined);
  assert.equal(ticketCreated, false);
});

test("command executor does not execute adapters when backend resolution is blocked", async () => {
  let executed = false;
  const executor = createCommandExecutor({
    probeCapabilities: async () => buildCapabilitySnapshot(),
    resolveBackend: async () => ({
      selected: null,
      candidates: [],
      blocked: true,
      blockedReason: "no backend available",
      requiresApproval: false,
    }),
    adapters: {
      local_shell: {
        execute: async () => {
          executed = true;
          return { ok: true };
        },
      },
    },
  });

  const result = await executor.executeIntent({
    kind: "exec_shell",
    workspace: process.cwd(),
    command: "echo hi",
  });

  assert.equal(result.blocked, true);
  assert.equal(executed, false);
});

test("command executor delegates to selected backend adapter", async () => {
  const executor = createCommandExecutor({
    probeCapabilities: async () =>
      buildCapabilitySnapshot({
        localShell: { available: true },
      }),
    resolveBackend: async () => ({
      selected: "local_shell",
      candidates: ["local_shell"],
      blocked: false,
      requiresApproval: false,
    }),
    adapters: {
      local_shell: {
        execute: async (intent) => ({
          ok: true,
          backend: "local_shell",
          stdout: intent.command || "",
          stderr: "",
          retryable: false,
          requiresApproval: false,
          blocked: false,
        }),
      },
    },
  });

  const result = await executor.executeIntent({
    kind: "exec_shell",
    workspace: process.cwd(),
    command: "echo hi",
  });

  assert.equal(result.ok, true);
  assert.equal(result.backend, "local_shell");
  assert.equal(result.stdout, "echo hi");
});

test("command executor delegates to external executor backend when selected", async () => {
  const executor = createCommandExecutor({
    probeCapabilities: async () =>
      buildCapabilitySnapshot({
        externalExecutor: { available: true, baseUrl: "http://127.0.0.1:4318" },
      }),
    resolveBackend: async () => ({
      selected: "external_executor",
      candidates: ["external_executor"],
      blocked: false,
      requiresApproval: false,
    }),
    adapters: {
      external_executor: {
        execute: async (intent) => ({
          ok: true,
          backend: "external_executor",
          stdout: `external:${intent.command || intent.kind}`,
          stderr: "",
          retryable: false,
          requiresApproval: false,
          blocked: false,
        }),
      },
    },
  });

  const result = await executor.executeIntent({
    kind: "exec_shell",
    workspace: process.cwd(),
    command: "npm install",
  });

  assert.equal(result.ok, true);
  assert.equal(result.backend, "external_executor");
  assert.equal(result.stdout, "external:npm install");
});

test("shell exec exposes a local shell adapter facade", async () => {
  const adapter = createLocalShellAdapter({
    runCommand: async () => "Output:\nhello\nErrors:\n",
  });

  const result = await adapter.execute(
    {
      kind: "exec_shell",
      workspace: process.cwd(),
      command: "echo hello",
    },
    {
      capabilitySnapshot: buildCapabilitySnapshot({
        localShell: { available: true },
      }),
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.backend, "local_shell");
  assert.equal(result.stdout.trim(), "hello");
});
