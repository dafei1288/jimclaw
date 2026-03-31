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
  let observedTimeoutMs = 0;
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
            observedTimeoutMs = Number(options?.timeoutMs || 0);
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
    assert.equal(observedTimeoutMs > 0, true);
    assert.equal(result.issueTracker.length, 1);
    assert.equal(result.issueTracker[0].relatedFiles[0], "tests/user.test.ts");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("qa reopens completed package.json when dependency gaps are detected", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    retryCount: 1,
    testResults: "FAIL tests/books.test.ts\nCannot find module 'express' from src/app.ts",
    issueTracker: [],
    contract: { title: "demo", requirements: [], acceptanceCriteria: [] },
    apiContract: { endpoints: [] },
    spec: {
      language: "TypeScript",
      filesToCreate: ["package.json", "src/app.ts", "tests/books.test.ts"],
    },
    subTasks: [
      {
        id: "task-package",
        description: "pkg",
        fileTarget: "package.json",
        dependencies: [],
        contextRequirement: "runtime deps",
        status: "completed",
      },
      {
        id: "task-app",
        description: "app",
        fileTarget: "src/app.ts",
        dependencies: ["package.json"],
        contextRequirement: "express app",
        status: "completed",
      },
      {
        id: "task-test",
        description: "books test",
        fileTarget: "tests/books.test.ts",
        dependencies: ["src/app.ts"],
        contextRequirement: "test",
        status: "completed",
      },
    ],
  });

  try {
    const result = await qaNode(
      state,
      {
        qa: {
          async chat() {
            return {
              content: '{"issues":[{"id":"BUG-001","title":"依赖缺失导致测试失败","description":"运行时依赖未安装，package.json 中缺少 express 依赖声明。","severity":"major","status":"open","relatedFiles":["tests/books.test.ts"],"rawErrorSnippet":"Cannot find module \\"express\\" from src/app.ts","detectedRound":1}]}',
            };
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
    assert.equal(result.issueTracker[0].relatedFiles.includes("package.json"), true);
    assert.equal(result.qaFailures.failedFiles.includes("package.json"), true);
    assert.equal(result.qaFailures.failedFiles.includes("tests/books.test.ts"), true);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("qa enriches issue ownership with failing completed test files mentioned in stack traces", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    retryCount: 2,
    testResults: "FAIL tests/health.test.ts\nCannot find module '../src/logger' from tests/health.test.ts",
    issueTracker: [],
    contract: { title: "demo", requirements: [], acceptanceCriteria: [] },
    apiContract: { endpoints: [] },
    spec: {
      language: "TypeScript",
      filesToCreate: ["tests/health.test.ts", "src/index.ts"],
    },
    subTasks: [
      {
        id: "task-health-test",
        description: "health test",
        fileTarget: "tests/health.test.ts",
        dependencies: ["src/index.ts"],
        contextRequirement: "verify health endpoint",
        status: "completed",
      },
      {
        id: "task-index",
        description: "index",
        fileTarget: "src/index.ts",
        dependencies: [],
        contextRequirement: "server entry",
        status: "completed",
      },
    ],
  });

  try {
    const result = await qaNode(
      state,
      {
        qa: {
          async chat() {
            return {
              content: '{"issues":[{"id":"BUG-002","title":"健康检查测试导入失败","description":"测试中引用了不存在的 logger 模块路径，需要修正导入。","severity":"major","status":"open","relatedFiles":[],"rawErrorSnippet":"Cannot find module ../src/logger from tests/health.test.ts","detectedRound":2}]}',
            };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.issueTracker.length, 1);
    assert.equal(result.issueTracker[0].relatedFiles.includes("tests/health.test.ts"), true);
    assert.equal(result.qaFailures.failedFiles.includes("tests/health.test.ts"), true);
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

test("qa replay does not auto-pass when only persisted failure evidence remains", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    retryCount: 3,
    testResults: "",
    blockedReason: "",
    qaFailures: {
      failedFiles: ["tests/books.test.ts"],
      testErrors: ["未检测到合法的 Markdown 代码块"],
      failedTestNames: [],
    },
    validationReport: {
      version: "v1",
      status: "fail",
      failureType: "implementation_bug",
      blocking: true,
      findings: [
        {
          type: "implementation_bug",
          summary: "tests/books.test.ts 阻塞",
          file: "tests/books.test.ts",
          evidence: ["未检测到合法的 Markdown 代码块"],
        },
      ],
    },
    lastFailedNode: "coder",
    lastFailureSummary: "Coder 阻塞失败: tests/books.test.ts -> 未检测到合法的 Markdown 代码块",
    issueTracker: [],
    consensusProgress: {
      completedFiles: ["src/index.ts"],
      pendingFiles: ["tests/books.test.ts"],
      currentRound: 2,
      openIssues: [],
    },
  });

  try {
    const result = await qaNode(
      state,
      {
        qa: {
          async chat() {
            throw new Error("qa chat should not be called when persisted coder failure evidence is sufficient");
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.isDone, false);
    assert.equal(result.validationReport.failureType, "implementation_bug");
    assert.equal(result.qaFailures.failedFiles[0], "tests/books.test.ts");
    assert.equal(result.lastFailedNode, "coder");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("qa does not deploy when pending subtasks remain even if there is no current failure evidence", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    retryCount: 3,
    testResults: "",
    blockedReason: "",
    issueTracker: [],
    subTasks: [
      {
        id: "task-001",
        description: "api ready",
        fileTarget: "src/index.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "completed",
      },
      {
        id: "task-002",
        description: "docker pending",
        fileTarget: "Dockerfile",
        dependencies: ["task-001"],
        contextRequirement: "none",
        status: "pending",
      },
    ],
    consensusProgress: {
      completedFiles: ["src/index.ts"],
      pendingFiles: ["Dockerfile"],
      currentRound: 2,
      openIssues: [],
    },
  });

  try {
    const result = await qaNode(
      state,
      {
        qa: {
          async chat() {
            throw new Error("qa chat should not be called when there is no failure evidence");
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.isDone, false);
    assert.equal(result.resumeAfterValidation, true);
    assert.equal(result.validationReport.status, "pass");
    assert.equal(result.validationReport.blocking, false);
    assert.equal(result.qaFailures, null);
    assert.equal(result.retryCount, 3);
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

test("qa resumes coder after staged validation passes but pending files remain", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    retryCount: 0,
    testResults: "PASS tests/books.test.ts",
    validationCheckpointRequested: true,
    validationCheckpointReason: "首轮核心骨架已完成，先验证可运行性",
    subTasks: [
      {
        id: "task-001",
        description: "core",
        fileTarget: "src/index.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "completed",
      },
      {
        id: "task-002",
        description: "later",
        fileTarget: "README.md",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
    consensusProgress: {
      completedFiles: ["src/index.ts"],
      pendingFiles: ["README.md"],
      currentRound: 0,
      openIssues: [],
    },
  });

  try {
    const result = await qaNode(
      state,
      {
        qa: {
          async chat() {
            throw new Error("qa chat should not be called when staged validation already passed");
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.isDone, false);
    assert.equal(result.qaFailures, null);
    assert.equal(result.resumeAfterValidation, true);
    assert.equal(result.validationCheckpointRequested, false);
    assert.equal(result.validationCheckpointCompleted, true);
    assert.equal(result.validationReport.status, "pass");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("qa does not resume coder from staged validation when host environment is blocked", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    retryCount: 0,
    testResults: "[基础设施构建失败] docker-compose 构建错误，请检查 Dockerfile 和 docker-compose.yml：\nCommand failed with error: spawn EPERM",
    blockedReason: "[基础设施构建失败] docker-compose 构建错误，请检查 Dockerfile 和 docker-compose.yml：\nCommand failed with error: spawn EPERM",
    lastFailedNode: "infra_setup",
    lastFailureSummary: "[基础设施构建失败] docker-compose 构建错误",
    validationCheckpointRequested: true,
    validationCheckpointReason: "首轮核心骨架已完成，先验证可运行性",
    subTasks: [
      {
        id: "task-001",
        description: "core",
        fileTarget: "src/index.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "completed",
      },
      {
        id: "task-002",
        description: "later",
        fileTarget: "README.md",
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
            throw new Error("qa chat should not be called for host environment blockage");
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.resumeAfterValidation, false);
    assert.equal(result.validationReport.failureType, "environment_gap");
    assert.equal(result.repairPlan.repairType, "environment");
    assert.equal(result.lastFailedNode, "qa");
    assert.match(result.lastFailureSummary || "", /基础设施|Docker|EPERM|环境/);
    assert.equal(recorder.snapshots.at(-1).node, "qa_env_fix");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("qa routes environment problems into env_guard instead of fixing them inline", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    retryCount: 1,
    testResults: "Error: Cannot find module 'express'\nRequire stack:\n- /app/src/index.ts",
    issueTracker: [],
  });

  try {
    const result = await qaNode(
      state,
      {
        qa: {
          async chat() {
            throw new Error("qa chat should not be called for deterministic environment problems");
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.isDone, false);
    assert.equal(result.recoveredEnvironment, false);
    assert.equal(result.validationReport.failureType, "environment_gap");
    assert.equal(result.repairPlan.repairType, "environment");
    assert.match(result.lastFailureSummary || "", /环境|express/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("qa keeps env_guard install failures in environment repair loop instead of misclassifying them as coder blocking", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    retryCount: 2,
    blockedReason: "[EnvGuard] 环境预检异常：spawn EPERM",
    testResults: "[EnvGuard] 环境预检异常：spawn EPERM",
    lastFailedNode: "env_guard",
    lastFailureSummary: "[EnvGuard] 环境预检异常：spawn EPERM",
    validationReport: {
      version: "v1",
      status: "fail",
      failureType: "environment_gap",
      blocking: true,
      findings: [
        {
          type: "environment_gap",
          summary: "npm install 无法执行",
          evidence: ["spawn EPERM"],
        },
      ],
    },
    repairPlan: {
      repairType: "environment",
      targets: ["package.json"],
      actions: ["重新准备依赖安装环境"],
      expectedEvidence: ["spawn EPERM"],
    },
  });

  try {
    const result = await qaNode(
      state,
      {
        qa: {
          async chat() {
            throw new Error("qa chat should not be called for env_guard failures");
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.validationReport.failureType, "environment_gap");
    assert.equal(result.repairPlan.repairType, "environment");
    assert.equal(result.lastFailedNode, "qa");
    assert.match(result.lastFailureSummary || "", /npm install|环境|EPERM/);
    assert.equal(recorder.snapshots.at(-1).node, "qa_env_fix");
  } finally {
    await removeTempWorkspace(workspace);
  }
});
