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
const { approvalNode } = require("../../src/core/nodes/approval_node");
const { buildCustomerApprovalState } = require("../../src/core/logic_utils");

test("approval auto-approves requirements checkpoint when default authorization is enabled", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    spec: null,
    contract: { title: "演示系统", requirements: ["前后端"], acceptanceCriteria: ["可访问"] },
    customerApprovalState: buildCustomerApprovalState({
      autoApprove: { requirements: true, solution: false, deploy: false },
      summaries: { requirements: "需求默认同意" },
    }),
  });

  try {
    const result = await approvalNode(
      state,
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.requiresApproval, false);
    assert.equal(result.approvalNextNode, "architect");
    assert.equal(result.customerApprovalState.checkpoints.find((item) => item.stage === "requirements").approved, true);
    assert.equal(result.customerApprovalState.checkpoints.find((item) => item.stage === "requirements").approvedBy, "default-authorization");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("approval enters pending state instead of blocking for manual confirmation", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    contract: { title: "演示系统", requirements: ["前后端"], acceptanceCriteria: ["可访问"] },
    spec: { language: "TypeScript", filesToCreate: ["src/index.ts"] },
    manifest: { services: [{ name: "api", port: 3000 }] },
    customerApprovalState: buildCustomerApprovalState({
      autoApprove: { requirements: true, solution: false, deploy: false },
      summaries: { solution: "方案待确认" },
    }),
  });

  try {
    const events = [];
    const result = await approvalNode(
      state,
      {},
      workspace,
      (type, sender, content, metadata) => events.push({ type, sender, content, metadata }),
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.requiresApproval, true);
    assert.equal(result.pendingApprovalStage, "solution");
    assert.equal(result.approvalNextNode, "contract_sync");
    assert.equal(result.customerApprovalState.checkpoints.find((item) => item.stage === "solution").approved, false);
    assert.equal(events.some((event) => event.type === "approval_required"), true);
    assert.equal(recorder.snapshots.some((item) => item.node === "approval_pending"), true);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("approval resumes immediately after customer decision was already persisted", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    contract: { title: "演示系统", requirements: ["前后端"], acceptanceCriteria: ["可访问"] },
    spec: { language: "TypeScript", filesToCreate: ["src/index.ts"] },
    manifest: { services: [{ name: "api", port: 3000 }] },
    customerApprovalState: buildCustomerApprovalState({
      autoApprove: { requirements: true, solution: false, deploy: false },
      summaries: { solution: "方案待确认" },
    }),
    pendingApprovalStage: "solution",
    approvalNextNode: "contract_sync",
  });

  try {
    state.customerApprovalState.checkpoints = state.customerApprovalState.checkpoints.map((checkpoint) =>
      checkpoint.stage === "solution"
        ? { ...checkpoint, approved: true, approvedBy: "customer", timestamp: "2026-03-29 15:00:00" }
        : checkpoint
    );

    const result = await approvalNode(
      state,
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.requiresApproval, false);
    assert.equal(result.pendingApprovalStage, null);
    assert.equal(result.approvalNextNode, "contract_sync");
    assert.equal(result.customerApprovalState.checkpoints.find((item) => item.stage === "solution").approvedBy, "customer");
  } finally {
    await removeTempWorkspace(workspace);
  }
});
