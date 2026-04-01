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
const { terminalNode } = require("../../src/core/nodes/terminal_node");

test("terminal retries transient exec failure before returning test output", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let execCalls = 0;

  try {
    const result = await terminalNode(
      createBaseState({
        containerId: "abc123def456",
        spec: {
          language: "TypeScript",
          testCommand: "npm test",
          filesToCreate: [],
        },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save,
      {
        commandExecutor: {
          executeIntent: async () => {
            execCalls += 1;
            if (execCalls === 1) {
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
              stdout: "PASS tests/setup.test.ts",
              stderr: "",
              retryable: false,
              requiresApproval: false,
              blocked: false,
            };
          },
        },
      }
    );

    assert.equal(execCalls, 2);
    assert.equal(result.testResults, "PASS tests/setup.test.ts");
    assert.equal(result.lastFailedNode, "");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("terminal executes tests on host backend without requiring container", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const calls = [];

  try {
    const result = await terminalNode(
      createBaseState({
        executionBackend: "host",
        containerId: "",
        spec: {
          language: "TypeScript",
          testCommand: "npm test",
          filesToCreate: [],
        },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save,
      {
        commandExecutor: {
          executeIntent: async (intent) => {
            calls.push({ command: intent.command, workDir: intent.workspace, kind: intent.kind });
            return {
              ok: true,
              backend: "local_shell",
              stdout: "PASS tests/setup.test.ts",
              stderr: "",
              retryable: false,
              requiresApproval: false,
              blocked: false,
            };
          },
        },
      }
    );

    assert.equal(result.testResults.includes("PASS tests/setup.test.ts"), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "run_tests");
    assert.equal(calls[0].command, "npm test");
    assert.equal(calls[0].workDir, workspace);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("terminal routes test execution through command executor run_tests intent", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const executorCalls = [];

  try {
    const result = await terminalNode(
      createBaseState({
        executionBackend: "host",
        spec: {
          language: "TypeScript",
          testCommand: "npm test",
          filesToCreate: [],
        },
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
              stdout: "PASS tests/setup.test.ts",
              stderr: "",
              retryable: false,
              requiresApproval: false,
              blocked: false,
            };
          },
        },
      }
    );

    assert.equal(result.testResults, "PASS tests/setup.test.ts");
    assert.equal(executorCalls.length, 1);
    assert.equal(executorCalls[0].kind, "run_tests");
    assert.equal(executorCalls[0].command, "npm test");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("terminal maps blocked executor failures to environment gaps instead of ordinary test failures", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();

  try {
    const result = await terminalNode(
      createBaseState({
        executionBackend: "host",
        spec: {
          language: "TypeScript",
          testCommand: "npm test",
          filesToCreate: [],
        },
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

    assert.equal(result.validationReport?.failureType, "environment_gap");
    assert.equal(result.lastFailedNode, "terminal");
    assert.match(result.blockedReason || "", /no backend available|spawn EPERM/i);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
