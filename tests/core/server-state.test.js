require("ts-node/register/transpile-only");

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildServerAutoApprove,
  createServerInitialSession,
  createBaseGraphState,
} = require("../../src/server_state");

test("buildServerAutoApprove defaults to non-blocking approvals", () => {
  assert.deepEqual(buildServerAutoApprove(), {
    requirements: true,
    solution: true,
    deploy: true,
  });
});

test("createBaseGraphState seeds customer approval state with default authorization", () => {
  const state = createBaseGraphState("图书管理系统", 5);
  assert.equal(state.customerApprovalState.autoApprove.requirements, true);
  assert.equal(state.customerApprovalState.autoApprove.solution, true);
  assert.equal(state.customerApprovalState.autoApprove.deploy, true);
  assert.equal(
    state.customerApprovalState.checkpoints.every((checkpoint) => checkpoint.approved === true),
    true
  );
});

test("createServerInitialSession keeps session approval state aligned with graph state", () => {
  const session = createServerInitialSession("图书管理系统", 5);
  assert.equal(session.customerApprovalState.autoApprove.requirements, true);
  assert.equal(session.customerApprovalState.autoApprove.solution, true);
  assert.equal(session.customerApprovalState.autoApprove.deploy, true);
  assert.equal(session.pendingApprovalStage, null);
  assert.equal(session.requiresApproval, false);
});

test("explicit autoApprove override is preserved", () => {
  const session = createServerInitialSession("图书管理系统", 5, {
    requirements: false,
    solution: true,
    deploy: false,
  });
  assert.deepEqual(session.customerApprovalState.autoApprove, {
    requirements: false,
    solution: true,
    deploy: false,
  });
});

test("execution tuning flags are propagated to graph and session state", () => {
  const graphState = createBaseGraphState("图书管理系统", 5, undefined, {
    coderMaxParallel: 3,
    coderExperimentalModelParallel: true,
  });
  const session = createServerInitialSession("图书管理系统", 5, undefined, {
    coderMaxParallel: 3,
    coderExperimentalModelParallel: true,
  });

  assert.equal(graphState.coderMaxParallel, 3);
  assert.equal(graphState.coderExperimentalModelParallel, true);
  assert.equal(session.coderMaxParallel, 3);
  assert.equal(session.coderExperimentalModelParallel, true);
});
