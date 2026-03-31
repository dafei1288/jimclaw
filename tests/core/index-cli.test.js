require("ts-node/register/transpile-only");

const test = require("node:test");
const assert = require("node:assert/strict");

const { computeSessionExitCode, parseAutoApproveArg } = require("../../src/index");

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

test("computeSessionExitCode returns pending code for approval pause", () => {
  assert.equal(
    computeSessionExitCode({
      requiresApproval: true,
      pendingApprovalStage: "solution",
      deploymentStatus: { status: "none" },
      lastFailedNode: "",
      lastFailureSummary: "",
    }),
    2
  );
});

test("computeSessionExitCode returns pending code for agent recovery pause", () => {
  assert.equal(
    computeSessionExitCode({
      agentRecoveryPending: true,
      agentRecoveryNode: "coder",
      deploymentStatus: { status: "none" },
      lastFailedNode: "coder",
      lastFailureSummary: "模型服务暂不可用",
    }),
    3
  );
});

test("parseAutoApproveArg supports all and comma separated stages", () => {
  assert.deepEqual(parseAutoApproveArg("all"), {
    requirements: true,
    solution: true,
    deploy: true,
  });
  assert.deepEqual(parseAutoApproveArg("requirements,deploy"), {
    requirements: true,
    solution: false,
    deploy: true,
  });
});
