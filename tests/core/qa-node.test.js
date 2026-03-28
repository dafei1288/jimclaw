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
const { qaNode } = require("../../src/core/nodes/qa_node");

test("qa keeps coder blocking failures focused on the actual blocked file", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    retryCount: 0,
    blockedReason: "Coder 阻塞失败: src/index.ts -> syntax error",
    testResults: "[Coder 阻塞失败]\nCoder 阻塞失败: src/index.ts -> syntax error",
    qaFailures: {
      failedFiles: ["src/index.ts"],
      testErrors: ["Coder 阻塞失败: src/index.ts -> syntax error"],
      failedTestNames: [],
    },
    subTasks: [
      {
        id: "task-001",
        description: "entry",
        fileTarget: "src/index.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "failed",
        lastError: "syntax error",
      },
      {
        id: "task-002",
        description: "later file",
        fileTarget: "src/routes/userRoutes.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await qaNode(
      state,
      {
        qa: {
          async chat() {
            throw new Error("qa chat should not be called for coder blocking failures");
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.issueTracker.length, 1);
    assert.equal(result.issueTracker[0].relatedFiles[0], "src/index.ts");
    assert.equal(result.issueTracker[0].severity, "major");
    assert.equal(result.qaFailures.failedFiles.length, 1);
    assert.equal(result.qaFailures.failedFiles[0], "src/index.ts");
    assert.equal(result.validationReport.failureType, "implementation_bug");
    assert.equal(result.repairPlan.repairType, "implementation");
    assert.match(result.issueTracker[0].title, /src\/index\.ts|index\.ts/);
    assert.equal(result.retryCount, 1);
    assert.equal(recorder.snapshots.at(-1).node, "qa");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("qa deep analysis uses coding mode", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let observedMode = "";
  const state = createBaseState({
    retryCount: 1,
    testResults: "FAIL tests/user.test.ts\nTypeError: expected true to be false",
    issueTracker: [],
    contract: { title: "demo", requirements: [], acceptanceCriteria: [] },
    apiContract: { endpoints: [] },
  });

  try {
    const result = await qaNode(
      state,
      {
        qa: {
          async chat(_messages, _onEvent, options) {
            observedMode = options?.mode || "";
            return {
              content: '{"issues":[{"id":"BUG-001","title":"tests/user.test.ts 测试失败","description":"需要修复测试失败。","severity":"major","status":"open","relatedFiles":["tests/user.test.ts"],"rawErrorSnippet":"FAIL tests/user.test.ts","detectedRound":1}]}',
            };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(observedMode, "coding");
    assert.equal(result.issueTracker.length, 1);
    assert.equal(result.issueTracker[0].relatedFiles[0], "tests/user.test.ts");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("qa does not pass verifier precheck failure even when llm returns empty issues", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    retryCount: 2,
    testResults: "[Verifier 预检失败]\n测试文件 tests/setup.test.ts 未找到断言语句（如 expect()、assert.）",
    issueTracker: [],
    contract: { title: "demo", requirements: [], acceptanceCriteria: [] },
    apiContract: { endpoints: [] },
  });

  try {
    const result = await qaNode(
      state,
      {
        qa: {
          async chat() {
            return { content: '{"issues":[]}' };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.isDone, false);
    assert.equal(result.issueTracker.length, 1);
    assert.match(result.issueTracker[0].title, /tests\/setup\.test\.ts|预检未通过/);
    assert.equal(result.lastFailedNode, "verifier");
    assert.equal(recorder.snapshots.at(-1).node, "qa");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("qa auto-resolves stale open issues when there is no current failure evidence", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    retryCount: 4,
    testResults: "PASS tests/authController.test.ts",
    deploymentStatus: { status: "success", url: "http://127.0.0.1:4000" },
    issueTracker: [
      {
        id: "BUG-OLD-001",
        title: "历史遗留问题",
        description: "之前出现过，但当前没有失败证据",
        severity: "major",
        status: "open",
        relatedFiles: ["tests/logController.test.ts"],
        rawErrorSnippet: "old error",
        detectedRound: 2,
      },
    ],
    consensusProgress: {
      completedFiles: ["src/index.ts"],
      pendingFiles: ["tests/logController.test.ts"],
      currentRound: 3,
      openIssues: ["BUG-OLD-001 历史遗留问题"],
    },
    contract: { title: "demo", requirements: [], acceptanceCriteria: [] },
    apiContract: { endpoints: [] },
  });

  try {
    const result = await qaNode(
      state,
      {
        qa: {
          async chat() {
            throw new Error("qa chat should not be called when stale issues are auto-resolved");
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.isDone, true);
    assert.equal(result.issueTracker[0].status, "resolved");
    assert.deepEqual(result.consensusProgress.openIssues, []);
    assert.equal(result.qaFailures, null);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("qa prioritizes blocking protocol failures without calling llm", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    retryCount: 1,
    testResults: "[Verifier 预检失败]\n测试布局与 Jest roots 不一致",
    protocolFailures: [
      {
        type: "test_discovery_gap",
        node: "verifier",
        file: "tests/user.test.ts",
        summary: "声明的业务测试未被 Jest roots 覆盖",
        evidence: ["roots=tests", "declared=tests/user.test.ts"],
        blocking: true,
      },
    ],
  });

  try {
    const result = await qaNode(
      state,
      {
        qa: {
          async chat() {
            throw new Error("qa chat should not be called when blocking protocol failures already exist");
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.isDone, false);
    assert.equal(result.issueTracker.length, 1);
    assert.equal(result.issueTracker[0].id, "BUG-PROTOCOL-1");
    assert.equal(result.issueTracker[0].relatedFiles[0], "tests/user.test.ts");
    assert.equal(result.validationReport.failureType, "planning_gap");
    assert.equal(result.repairPlan.repairType, "planning");
    assert.equal(result.lastFailedNode, "verifier");
    assert.match(result.lastFailureSummary, /Jest roots/);
    assert.equal(result.qaFailures.failedFiles[0], "tests/user.test.ts");
  } finally {
    await removeTempWorkspace(workspace);
  }
});
