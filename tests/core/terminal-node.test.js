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
const logicUtils = require("../../src/core/logic_utils");
const { terminalNode } = require("../../src/core/nodes/terminal_node");
const { ShellExecuteSkill } = require("../../src/skills/shell_exec");

test("terminal retries transient exec failure before returning test output", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalExecInContainer = logicUtils.execInContainer;
  let execCalls = 0;

  logicUtils.execInContainer = async () => {
    execCalls += 1;
    if (execCalls === 1) {
      return [
        "Command failed with exit code 137.",
        "Output:",
        "",
        "Errors:",
        "OCI runtime exec failed: exec failed: container is not running",
      ].join("\n");
    }
    return "PASS tests/setup.test.ts";
  };

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
      recorder.save
    );

    assert.equal(execCalls, 2);
    assert.equal(result.testResults, "PASS tests/setup.test.ts");
    assert.equal(result.lastFailedNode, "");
  } finally {
    logicUtils.execInContainer = originalExecInContainer;
    await removeTempWorkspace(workspace);
  }
});

test("terminal executes tests on host backend without requiring container", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalShellRun = ShellExecuteSkill.config.run;
  const calls = [];

  ShellExecuteSkill.config.run = async ({ command, workDir }) => {
    calls.push({ command, workDir });
    return "Output:\nPASS tests/setup.test.ts\nErrors:\n";
  };

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
      recorder.save
    );

    assert.equal(result.testResults.includes("PASS tests/setup.test.ts"), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "npm test");
    assert.equal(calls[0].workDir, workspace);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    await removeTempWorkspace(workspace);
  }
});
