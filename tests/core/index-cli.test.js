const test = require("node:test");
const assert = require("node:assert/strict");

const { computeSessionExitCode } = require("../../src/index");

test("computeSessionExitCode returns failure for failed deployment state", () => {
  assert.equal(
    computeSessionExitCode({
      isDone: false,
      deploymentStatus: { status: "failed" },
      lastFailedNode: "deploy",
      lastFailureSummary: "deploy failed",
    }),
    1
  );
});

test("computeSessionExitCode returns success for clean finished state", () => {
  assert.equal(
    computeSessionExitCode({
      isDone: true,
      deploymentStatus: { status: "running" },
      lastFailedNode: "",
      lastFailureSummary: "",
    }),
    0
  );
});
