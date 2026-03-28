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

test("approval marks solution checkpoint as pending manual confirmation when not auto-approved", async () => {
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
    assert.equal(result.approvalNextNode, "contract_sync");
    assert.equal(result.customerApprovalState.checkpoints.find((item) => item.stage === "solution").approved, true);
    assert.equal(result.customerApprovalState.checkpoints.find((item) => item.stage === "solution").approvedBy, "customer");
    assert.equal(events.some((event) => event.type === "approval_required"), true);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
