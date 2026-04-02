const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const {
  createTempWorkspace,
  removeTempWorkspace,
  createBaseState,
} = require("./test-helpers");
const { createJimClawGraph } = require("../../src/core/graph");
const {
  recordNodeFailure,
  buildTraceIndex,
  shouldPersistCheckpoint,
  buildCheckpointMeta,
  loadTraceIndex,
  loadCheckpointSnapshot,
  buildReplayStateFromSnapshot,
  buildResumeStateFromCurrentSnapshot,
  getResumeNodeFromCheckpoint,
  prepareReplayStateFromCheckpoint,
  persistWriteRecoveryIntent,
  recoverWorkspaceFromWriteIntents,
  extractFailureEvidence,
  validateWorkspaceArtifacts,
} = require("../../src/core/logic_utils");

test("node failure recorder writes fallback meeting note and summary", async () => {
  const workspace = await createTempWorkspace();

  try {
    const { failure, meetingNotes } = await recordNodeFailure(
      workspace,
      { retryCount: 2, meetingNotes: [] },
      "coder",
      new Error("simulated coder crash")
    );

    assert.equal(failure.node, "coder");
    assert.equal(failure.round, 2);
    assert.match(failure.summary, /coder/i);
    assert.equal(meetingNotes.length, 1);
    assert.equal(meetingNotes[0].id, "note-coder-r2");

    const noteContent = await fs.readFile(`${workspace}/nodes/note-coder-r2.md`, "utf-8");
    assert.match(noteContent, /simulated coder crash/);
    assert.match(noteContent, /轮次：2/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("trace index summarizes nodes, notes, file changes and failure state", async () => {
  const state = createBaseState({
    retryCount: 1,
    codeLog: [
      { round: 0, file: "src/index.ts", taskTitle: "entry", status: "written" },
      { round: 1, file: "src/routes/userRoutes.ts", taskTitle: "routes", status: "error", error: "contract drift" },
    ],
    meetingNotes: [
      { id: "note-pm-r0", phase: "pm", round: 0, summary: "pm summary", contentFile: "nodes/note-pm-r0.md" },
      { id: "note-coder-r1", phase: "coder", round: 1, summary: "coder summary", contentFile: "nodes/note-coder-r1.md" },
    ],
    lastFailedNode: "verifier",
    lastFailureSummary: "verifier 节点异常：contract drift",
    protocolFailures: [
      {
        type: "contract_drift",
        node: "verifier",
        file: "src/routes/userRoutes.ts",
        summary: "路由导出契约不一致",
        evidence: ["缺少导出 createUser"],
        blocking: true,
      },
    ],
    protocolPatches: [
      {
        target: "contracts",
        action: "replace",
        path: "files.src/routes/userRoutes.ts.requiredExports",
        value: ["router"],
        reason: "统一路由导出",
      },
    ],
  });

  const checkpoints = [buildCheckpointMeta("orchestrator", 0, "2026-03-23 19:58:00")];
  const index = buildTraceIndex(state, "verifier", "trace_123", "2026-03-23 20:00:00", checkpoints, {
    calls: 2,
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
    byAgent: {
      星河: { calls: 1, inputTokens: 60, outputTokens: 20, totalTokens: 80 },
      清扬: { calls: 1, inputTokens: 40, outputTokens: 20, totalTokens: 60 },
    },
  });

  assert.equal(index.traceId, "trace_123");
  assert.equal(index.lastNode, "verifier");
  assert.equal(index.retryCount, 1);
  assert.equal(index.lastFailure.node, "verifier");
  assert.equal(index.fileChanges.length, 2);
  assert.equal(index.files["src/index.ts"].lastStatus, "written");
  assert.equal(index.files["src/routes/userRoutes.ts"].lastStatus, "error");
  assert.equal(index.files["src/routes/userRoutes.ts"].lastError, "contract drift");
  assert.equal(index.meetingNotes.length, 2);
  assert.equal(index.checkpoints.length, 1);
  assert.equal(index.checkpoints[0].node, "orchestrator");
  assert.equal(index.timeline[index.timeline.length - 1].node, "verifier");
  assert.equal(index.tokenUsage.totalTokens, 140);
  assert.equal(index.tokenUsage.byAgent["星河"].totalTokens, 80);
  assert.equal(index.protocolFailures.length, 1);
  assert.equal(index.protocolFailures[0].type, "contract_drift");
  assert.equal(index.protocolPatches.length, 1);
  assert.equal(index.protocolPatches[0].path, "files.src/routes/userRoutes.ts.requiredExports");
});

test("checkpoint rules only keep stable success anchors", () => {
  assert.equal(shouldPersistCheckpoint("orchestrator"), true);
  assert.equal(shouldPersistCheckpoint("coder_final"), true);
  assert.equal(shouldPersistCheckpoint("verifier"), true);
  assert.equal(shouldPersistCheckpoint("qa"), true);
  assert.equal(shouldPersistCheckpoint("deploy"), true);
  assert.equal(shouldPersistCheckpoint("pm"), false);
  assert.equal(shouldPersistCheckpoint("coder_crash"), false);

  const checkpoint = buildCheckpointMeta("coder_final", 2, "2026-03-23 20:30:00");
  assert.equal(checkpoint.id, "coder_final-r2");
  assert.equal(checkpoint.file, "checkpoints/coder_final-r2.json");
});

test("checkpoint loader returns snapshot and sanitized replay state", async () => {
  const workspace = await createTempWorkspace();

  try {
    const checkpoint = buildCheckpointMeta("coder_final", 2, "2026-03-23 20:30:00");
    const state = createBaseState({
      retryCount: 2,
      messages: [{ id: "m1" }],
      teamChatLog: [{ sender: "QA", content: "old" }],
      testResults: "old failure",
      qaFailures: { failedFiles: ["src/index.ts"], testErrors: ["boom"], failedTestNames: ["x"] },
      lastFailedNode: "qa",
      lastFailureSummary: "old summary",
      blockedReason: "missing deps",
      recoveredEnvironment: true,
      envReady: false,
      containerId: "jimclaw_test",
      allocatedHostPort: 3100,
      failureFingerprint: "fp",
      sameFailureCount: 3,
      subTasks: [{ id: "t1", description: "x", fileTarget: "src/index.ts", dependencies: [], contextRequirement: "", status: "completed" }],
    });
    const traceIndex = buildTraceIndex(state, "coder_final", "trace_restore", "2026-03-23 20:30:00", [checkpoint]);

    await fs.mkdir(`${workspace}/checkpoints`, { recursive: true });
    await fs.writeFile(`${workspace}/trace-index.json`, JSON.stringify(traceIndex, null, 2));
    await fs.writeFile(`${workspace}/${checkpoint.file}`, JSON.stringify({
      node: "coder_final",
      timestamp: "2026-03-23 20:30:00",
      traceId: "trace_restore",
      state,
    }, null, 2));

    const loadedIndex = await loadTraceIndex(workspace);
    assert.equal(loadedIndex.checkpoints.length, 1);

    const snapshot = await loadCheckpointSnapshot(workspace, "coder_final-r2");
    assert.equal(snapshot.node, "coder_final");

    const replayState = buildReplayStateFromSnapshot(snapshot.state);
    assert.equal(replayState.retryCount, 2);
    assert.equal(Array.isArray(replayState.messages), true);
    assert.equal(replayState.messages.length, 0);
    assert.equal(replayState.teamChatLog.length, 0);
    assert.equal(replayState.testResults, "");
    assert.equal(replayState.qaFailures, null);
    assert.equal(replayState.lastFailedNode, "");
    assert.equal(replayState.resumeFromNode, "");
    assert.equal(replayState.containerId, "");
    assert.equal(replayState.subTasks[0].status, "completed");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("checkpoint resume mapping targets the next executable node", () => {
  assert.equal(getResumeNodeFromCheckpoint("orchestrator"), "coder");
  assert.equal(getResumeNodeFromCheckpoint("coder_task_task-001"), "coder");
  assert.equal(getResumeNodeFromCheckpoint("coder_final"), "env_guard");
  assert.equal(getResumeNodeFromCheckpoint("verifier"), "qa");
  assert.equal(getResumeNodeFromCheckpoint("qa"), "qa_resume_router");
  assert.equal(getResumeNodeFromCheckpoint("deploy"), "post_mortem");
  assert.equal(getResumeNodeFromCheckpoint("unknown"), "pm");
});

test("checkpoint replay state includes resume target", () => {
  const replayState = prepareReplayStateFromCheckpoint({
    node: "coder_final",
    state: createBaseState({ retryCount: 3, subTasks: [{ id: "t1", description: "x", fileTarget: "src/a.ts", dependencies: [], contextRequirement: "", status: "completed" }] }),
  });

  assert.equal(replayState.retryCount, 3);
  assert.equal(replayState.resumeFromNode, "env_guard");
  assert.equal(replayState.subTasks[0].status, "completed");
});

test("dynamic coder task checkpoint replays back into coder instead of restarting from pm", () => {
  const replayState = prepareReplayStateFromCheckpoint({
    node: "coder_task_T002",
    state: createBaseState({
      retryCount: 12,
      blockedReason: "Coder 阻塞失败: scripts/verify.ts -> 单文件生成超时",
      subTasks: [{ id: "T002", description: "verify", fileTarget: "scripts/verify.ts", dependencies: ["src/index.ts"], contextRequirement: "", status: "pending" }],
    }),
  });

  assert.equal(replayState.resumeFromNode, "coder");
  assert.equal(replayState.subTasks[0].fileTarget, "scripts/verify.ts");
});

test("current workspace snapshot resumes dynamic coder task from coder", () => {
  const replayState = buildResumeStateFromCurrentSnapshot({
    node: "coder_task_T002",
    state: createBaseState({
      retryCount: 12,
      resumeFromNode: "pm",
      blockedReason: "Coder 阻塞失败: scripts/verify.ts -> 单文件生成超时",
      subTasks: [{ id: "T002", description: "verify", fileTarget: "scripts/verify.ts", dependencies: ["src/index.ts"], contextRequirement: "", status: "pending" }],
    }),
  });

  assert.equal(replayState.resumeFromNode, "coder");
  assert.equal(replayState.blockedReason, "");
});

test("current workspace qa snapshot keeps failure evidence for qa resume routing", () => {
  const replayState = buildResumeStateFromCurrentSnapshot({
    node: "qa",
    state: createBaseState({
      retryCount: 15,
      testResults: "[Terminal 测试失败]\nsrc/controllers/authController.ts(10,17): error TS2307: Cannot find module 'jsonwebtoken'",
      qaFailures: {
        failedFiles: ["src/controllers/authController.ts"],
        testErrors: ["Cannot find module 'jsonwebtoken'"],
        failedTestNames: [],
      },
      blockedReason: "缺少 jsonwebtoken 运行时依赖",
      subTasks: [{ id: "t1", description: "pkg", fileTarget: "package.json", dependencies: [], contextRequirement: "", status: "completed" }],
    }),
  });

  assert.equal(replayState.resumeFromNode, "qa_resume_router");
  assert.match(replayState.testResults, /jsonwebtoken/);
  assert.equal(replayState.qaFailures.failedFiles[0], "src/controllers/authController.ts");
  assert.match(replayState.blockedReason, /jsonwebtoken/);
});

test("current workspace infra_setup snapshot resumes from infra_setup instead of pm", () => {
  const replayState = buildResumeStateFromCurrentSnapshot({
    node: "infra_setup",
    state: createBaseState({
      retryCount: 6,
      resumeFromNode: "pm",
      lastFailedNode: "infra_setup",
      lastFailureSummary: "docker-compose 构建失败",
    }),
  });

  assert.equal(replayState.resumeFromNode, "infra_setup");
});

test("agent_pending fallback uses lastFailedNode when agentRecoveryNode is missing", () => {
  const replayState = buildResumeStateFromCurrentSnapshot({
    node: "agent_pending",
    state: createBaseState({
      retryCount: 7,
      agentRecoveryPending: true,
      agentRecoveryNode: "",
      resumeFromNode: "pm",
      lastFailedNode: "qa",
    }),
  });

  assert.equal(replayState.resumeFromNode, "qa_resume_router");
});

test("agent_pending resume preserves failure evidence for qa re-evaluation", () => {
  const replayState = buildResumeStateFromCurrentSnapshot({
    node: "agent_pending",
    state: createBaseState({
      retryCount: 8,
      agentRecoveryPending: true,
      agentRecoveryNode: "qa",
      testResults: "[基础设施构建失败]\nsrc/controllers/bookController.ts(41,27): error TS2345: bad type",
      qaFailures: {
        failedFiles: ["src/controllers/bookController.ts"],
        testErrors: ["TS2345"],
        failedTestNames: [],
      },
      validationReport: {
        version: "v1",
        status: "fail",
        failureType: "implementation_bug",
        blocking: true,
        findings: [{ summary: "TS 编译失败", file: "src/controllers/bookController.ts", evidence: ["TS2345"] }],
      },
    }),
  });

  assert.equal(replayState.resumeFromNode, "qa_resume_router");
  assert.match(replayState.testResults, /TS2345/);
  assert.equal(replayState.qaFailures?.failedFiles?.includes("src/controllers/bookController.ts"), true);
  assert.equal(replayState.validationReport?.blocking, true);
});

test("current workspace env_guard host-blocked snapshot keeps executor environment evidence", () => {
  const replayState = buildResumeStateFromCurrentSnapshot({
    node: "env_guard_host_blocked",
    state: createBaseState({
      retryCount: 4,
      testResults: "[EnvGuard] 宿主环境阻塞：docker daemon unreachable | local_shell: spawn EPERM",
      blockedReason: "[EnvGuard] 宿主环境阻塞：docker daemon unreachable | local_shell: spawn EPERM",
      lastFailedNode: "env_guard",
      lastFailureSummary: "[EnvGuard] 宿主环境阻塞：docker daemon unreachable | local_shell: spawn EPERM",
      validationReport: {
        version: "v1",
        status: "fail",
        failureType: "environment_gap",
        blocking: true,
        findings: [{ type: "environment_gap", summary: "宿主环境阻塞", evidence: ["docker daemon unreachable", "spawn EPERM"] }],
      },
      executorState: {
        version: "v1",
        approvalTickets: [],
        runtimeHandles: [],
        lastExecutorResult: {
          ok: false,
          backend: null,
          stdout: "",
          stderr: "spawn EPERM",
          retryable: false,
          requiresApproval: false,
          blocked: true,
          blockedReason: "docker daemon unreachable",
          failureType: "executor_unavailable",
        },
      },
    }),
  });

  assert.match(replayState.testResults, /宿主环境阻塞/);
  assert.match(replayState.blockedReason, /spawn EPERM/);
  assert.equal(replayState.validationReport?.failureType, "environment_gap");
  assert.equal(replayState.executorState?.lastExecutorResult?.failureType, "executor_unavailable");
});

test("current workspace deploy launch-failed snapshot keeps deploy-stage failure evidence", () => {
  const replayState = buildResumeStateFromCurrentSnapshot({
    node: "deploy",
    state: createBaseState({
      retryCount: 2,
      testResults: "[部署启动失败] spawn EPERM",
      blockedReason: "[部署启动失败] spawn EPERM",
      lastFailedNode: "deploy",
      lastFailureSummary: "[部署启动失败] spawn EPERM",
      deploymentStatus: { status: "failed", url: "http://127.0.0.1:4000" },
      validationReport: {
        version: "v1",
        status: "fail",
        failureType: "environment_gap",
        blocking: true,
        findings: [{ type: "environment_gap", summary: "[部署启动失败] spawn EPERM", file: "src/index.ts", evidence: ["spawn EPERM"] }],
      },
      executorState: {
        version: "v1",
        approvalTickets: [],
        runtimeHandles: [],
        lastExecutorResult: {
          ok: false,
          backend: null,
          stdout: "",
          stderr: "spawn EPERM",
          retryable: false,
          requiresApproval: false,
          blocked: true,
          blockedReason: "no backend available",
          failureType: "executor_unavailable",
        },
      },
    }),
  });

  assert.match(replayState.testResults, /部署启动失败/);
  assert.equal(replayState.lastFailedNode, "deploy");
  assert.equal(replayState.validationReport?.failureType, "environment_gap");
  assert.equal(replayState.executorState?.lastExecutorResult?.failureType, "executor_unavailable");
});

test("qa checkpoint replay preserves failure evidence for decision replay", () => {
  const replayState = prepareReplayStateFromCheckpoint({
    node: "qa",
    state: createBaseState({
      retryCount: 3,
      testResults: "[Coder 阻塞失败]\nCoder 阻塞失败: tests/books.test.ts -> 未检测到合法的 Markdown 代码块",
      qaFailures: {
        failedFiles: ["tests/books.test.ts"],
        testErrors: ["未检测到合法的 Markdown 代码块"],
        failedTestNames: [],
      },
      blockedReason: "Coder 阻塞失败: tests/books.test.ts -> 未检测到合法的 Markdown 代码块",
      lastFailedNode: "coder",
      lastFailureSummary: "Coder 阻塞失败: tests/books.test.ts -> 未检测到合法的 Markdown 代码块",
      subTasks: [{ id: "t1", description: "x", fileTarget: "tests/books.test.ts", dependencies: [], contextRequirement: "", status: "pending" }],
    }),
  });

  assert.equal(replayState.resumeFromNode, "qa_resume_router");
  assert.match(replayState.testResults, /tests\/books\.test\.ts/);
  assert.equal(replayState.qaFailures.failedFiles[0], "tests/books.test.ts");
  assert.match(replayState.blockedReason, /Markdown 代码块/);
  assert.equal(replayState.lastFailedNode, "coder");
});

test("failure evidence detection catches verifier, deploy and coder-block markers", () => {
  const verifier = extractFailureEvidence("[Verifier 预检失败]\n测试文件 tests/setup.test.ts 未找到断言", null, "");
  assert.equal(verifier.hasBlockingFailure, true);
  assert.equal(verifier.verifierFailed, true);

  const deploy = extractFailureEvidence("some output\n[部署验证失败] 无法访问", { status: "failed" }, "");
  assert.equal(deploy.hasBlockingFailure, true);
  assert.equal(deploy.deploymentFailed, true);

  const coder = extractFailureEvidence("[Coder 阻塞失败]\nCoder 阻塞失败: src/index.ts -> syntax", null, "syntax");
  assert.equal(coder.hasBlockingFailure, true);
  assert.equal(coder.coderBlocked, true);
});

test("replay graph reuses provided workspace and trace context", async () => {
  const workspace = await createTempWorkspace();

  try {
    const events = [];
    await createJimClawGraph(
      { pm: {}, architect: {}, coder: {}, qa: {} },
      (event) => events.push(event),
      { workspacePath: workspace, traceId: "trace_replay_existing" }
    );

    assert.equal(events.length > 0, true);
    assert.equal(events[0].type, "workspace-ready");
    assert.equal(events[0].metadata.workspacePath, workspace);
    assert.equal(events[0].metadata.traceId, "trace_replay_existing");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("workspace artifact validator accepts consistent replay artifacts", async () => {
  const workspace = await createTempWorkspace();

  try {
    const checkpoint = buildCheckpointMeta("verifier", 2, "2026-03-23 21:00:00");
    await fs.mkdir(`${workspace}/nodes`, { recursive: true });
    await fs.mkdir(`${workspace}/audit`, { recursive: true });
    const state = createBaseState({
      retryCount: 2,
      lastFailedNode: "verifier",
      lastFailureSummary: "文件缺失: src/index.ts",
      subTasks: [
        { id: "t1", description: "entry", fileTarget: "src/index.ts", dependencies: [], contextRequirement: "", status: "completed" },
      ],
      codeLog: [
        { round: 2, file: "src/index.ts", taskTitle: "entry", status: "written" },
      ],
      meetingNotes: [
        { id: "note-verifier-r2", phase: "verifier", round: 2, summary: "Verifier 第2轮：发现 1 个预检问题", contentFile: "nodes/note-verifier-r2.md" },
      ],
    });
    const snapshot = {
      node: "verifier",
      timestamp: "2026-03-23 21:00:00",
      traceId: "trace_consistent",
      state,
    };
    const traceIndex = buildTraceIndex(state, "verifier", "trace_consistent", "2026-03-23 21:00:00", [checkpoint]);

    await fs.mkdir(`${workspace}/checkpoints`, { recursive: true });
    await fs.writeFile(`${workspace}/nodes/note-verifier-r2.md`, "# Verifier\n\n文件缺失: src/index.ts\n");
    await fs.writeFile(`${workspace}/audit/Terminal.md`, "[Verifier 预检失败]\n文件缺失: src/index.ts\n");
    await fs.writeFile(`${workspace}/boulder.json`, JSON.stringify(snapshot, null, 2));
    await fs.writeFile(`${workspace}/trace-index.json`, JSON.stringify(traceIndex, null, 2));
    await fs.writeFile(`${workspace}/${checkpoint.file}`, JSON.stringify(snapshot, null, 2));

    const result = await validateWorkspaceArtifacts(workspace);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("workspace artifact validator detects checkpoint trace drift", async () => {
  const workspace = await createTempWorkspace();

  try {
    const checkpoint = buildCheckpointMeta("verifier", 2, "2026-03-23 21:00:00");
    const state = createBaseState({ retryCount: 2 });
    const snapshot = {
      node: "verifier",
      timestamp: "2026-03-23 21:00:00",
      traceId: "trace_consistent",
      state,
    };
    const traceIndex = buildTraceIndex(state, "verifier", "trace_consistent", "2026-03-23 21:00:00", [checkpoint]);

    await fs.mkdir(`${workspace}/checkpoints`, { recursive: true });
    await fs.writeFile(`${workspace}/boulder.json`, JSON.stringify(snapshot, null, 2));
    await fs.writeFile(`${workspace}/trace-index.json`, JSON.stringify(traceIndex, null, 2));
    await fs.writeFile(`${workspace}/${checkpoint.file}`, JSON.stringify({
      ...snapshot,
      traceId: "trace_other",
    }, null, 2));

    const result = await validateWorkspaceArtifacts(workspace);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /trace/i);
    assert.match(result.errors.join("\n"), /checkpoint/i);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("workspace artifact validator detects missing failure note and audit evidence", async () => {
  const workspace = await createTempWorkspace();

  try {
    const checkpoint = buildCheckpointMeta("deploy", 1, "2026-03-24 01:00:00");
    const state = createBaseState({
      retryCount: 1,
      lastFailedNode: "deploy",
      lastFailureSummary: "部署验证失败：无法访问 http://127.0.0.1:4000",
      meetingNotes: [],
    });
    const snapshot = {
      node: "deploy",
      timestamp: "2026-03-24 01:00:00",
      traceId: "trace_missing_failure_evidence",
      state,
    };
    const traceIndex = buildTraceIndex(state, "deploy", "trace_missing_failure_evidence", "2026-03-24 01:00:00", [checkpoint]);

    await fs.mkdir(`${workspace}/checkpoints`, { recursive: true });
    await fs.writeFile(`${workspace}/boulder.json`, JSON.stringify(snapshot, null, 2));
    await fs.writeFile(`${workspace}/trace-index.json`, JSON.stringify(traceIndex, null, 2));
    await fs.writeFile(`${workspace}/${checkpoint.file}`, JSON.stringify(snapshot, null, 2));

    const result = await validateWorkspaceArtifacts(workspace);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /meetingNote|纪要/i);
    assert.match(result.errors.join("\n"), /Infrastructure\.md|audit/i);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("workspace artifact validator detects completed subtask without written file summary", async () => {
  const workspace = await createTempWorkspace();

  try {
    const checkpoint = buildCheckpointMeta("verifier", 1, "2026-03-24 00:30:00");
    const state = createBaseState({
      retryCount: 1,
      subTasks: [
        { id: "t1", description: "entry", fileTarget: "src/index.ts", dependencies: [], contextRequirement: "", status: "completed" },
      ],
      codeLog: [],
    });
    const snapshot = {
      node: "verifier",
      timestamp: "2026-03-24 00:30:00",
      traceId: "trace_subtask_gap",
      state,
    };
    const traceIndex = buildTraceIndex(state, "verifier", "trace_subtask_gap", "2026-03-24 00:30:00", [checkpoint]);

    await fs.mkdir(`${workspace}/checkpoints`, { recursive: true });
    await fs.writeFile(`${workspace}/boulder.json`, JSON.stringify(snapshot, null, 2));
    await fs.writeFile(`${workspace}/trace-index.json`, JSON.stringify(traceIndex, null, 2));
    await fs.writeFile(`${workspace}/${checkpoint.file}`, JSON.stringify(snapshot, null, 2));

    const result = await validateWorkspaceArtifacts(workspace);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /src\/index\.ts/);
    assert.match(result.errors.join("\n"), /completed/i);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("workspace artifact validator detects failed subtask that still looks written", async () => {
  const workspace = await createTempWorkspace();

  try {
    const checkpoint = buildCheckpointMeta("verifier", 1, "2026-03-24 00:35:00");
    const state = createBaseState({
      retryCount: 1,
      subTasks: [
        { id: "t1", description: "entry", fileTarget: "src/index.ts", dependencies: [], contextRequirement: "", status: "failed", lastError: "syntax" },
      ],
      codeLog: [
        { round: 1, file: "src/index.ts", taskTitle: "entry", status: "written" },
      ],
    });
    const snapshot = {
      node: "verifier",
      timestamp: "2026-03-24 00:35:00",
      traceId: "trace_subtask_conflict",
      state,
    };
    const traceIndex = buildTraceIndex(state, "verifier", "trace_subtask_conflict", "2026-03-24 00:35:00", [checkpoint]);

    await fs.mkdir(`${workspace}/checkpoints`, { recursive: true });
    await fs.writeFile(`${workspace}/boulder.json`, JSON.stringify(snapshot, null, 2));
    await fs.writeFile(`${workspace}/trace-index.json`, JSON.stringify(traceIndex, null, 2));
    await fs.writeFile(`${workspace}/${checkpoint.file}`, JSON.stringify(snapshot, null, 2));

    const result = await validateWorkspaceArtifacts(workspace);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /src\/index\.ts/);
    assert.match(result.errors.join("\n"), /failed/i);
    assert.match(result.errors.join("\n"), /written/i);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("write recovery intent reconciles interrupted coder write into workspace state", async () => {
  const workspace = await createTempWorkspace();

  try {
    const state = createBaseState({
      retryCount: 0,
      subTasks: [
        { id: "task-001", description: "package", fileTarget: "package.json", dependencies: [], contextRequirement: "", status: "completed" },
        { id: "task-002", description: "tsconfig", fileTarget: "tsconfig.json", dependencies: [], contextRequirement: "", status: "pending" },
      ],
      code: JSON.stringify({
        "package.json": "{\"name\":\"demo\"}",
      }),
      codeLog: [
        { round: 0, file: "package.json", taskTitle: "package", status: "written" },
      ],
    });
    const snapshot = {
      node: "coder_task_task-001",
      timestamp: "2026-03-24 10:00:00",
      traceId: "trace_interrupt_fix",
      state,
    };
    const traceIndex = buildTraceIndex(state, "coder_task_task-001", "trace_interrupt_fix", "2026-03-24 10:00:00", []);

    await fs.mkdir(`${workspace}/src`, { recursive: true });
    await fs.writeFile(`${workspace}/boulder.json`, JSON.stringify(snapshot, null, 2));
    await fs.writeFile(`${workspace}/trace-index.json`, JSON.stringify(traceIndex, null, 2));
    await fs.writeFile(`${workspace}/tsconfig.json`, JSON.stringify({ compilerOptions: { strict: true } }, null, 2));

    const recoveredState = {
      ...state,
      code: JSON.stringify({
        "package.json": "{\"name\":\"demo\"}",
        "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }, null, 2),
      }),
      subTasks: [
        { id: "task-001", description: "package", fileTarget: "package.json", dependencies: [], contextRequirement: "", status: "completed" },
        { id: "task-002", description: "tsconfig", fileTarget: "tsconfig.json", dependencies: [], contextRequirement: "", status: "completed" },
      ],
      codeLog: [
        { round: 0, file: "package.json", taskTitle: "package", status: "written" },
        { round: 0, file: "tsconfig.json", taskTitle: "tsconfig", status: "written" },
      ],
    };

    await persistWriteRecoveryIntent(workspace, {
      taskId: "task-002",
      fileTarget: "tsconfig.json",
      expectedContent: JSON.stringify({ compilerOptions: { strict: true } }, null, 2),
      nodeName: "coder_task_task-002",
      traceId: "trace_interrupt_fix",
      snapshotState: recoveredState,
    });

    const recovered = await recoverWorkspaceFromWriteIntents(workspace);
    assert.equal(recovered.recovered, 1);
    assert.equal(recovered.recoveredFiles[0], "tsconfig.json");

    const nextBoulder = JSON.parse(await fs.readFile(`${workspace}/boulder.json`, "utf-8"));
    assert.equal(nextBoulder.node, "coder_task_task-002");
    assert.equal(nextBoulder.state.subTasks[1].status, "completed");

    const nextTraceIndex = JSON.parse(await fs.readFile(`${workspace}/trace-index.json`, "utf-8"));
    assert.equal(nextTraceIndex.files["tsconfig.json"].lastStatus, "written");
  } finally {
    await removeTempWorkspace(workspace);
  }
});
