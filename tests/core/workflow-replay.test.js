const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const {
  createTempWorkspace,
  removeTempWorkspace,
  createBaseState,
  createSnapshotRecorder,
} = require("./test-helpers");
const { createJimClawGraph, getVerifierNextNode, getQaNextNode, getInfraNextNode, getDeployNextNode, hasPendingExecutorApproval } = require("../../src/core/graph");
const { deployNode } = require("../../src/core/nodes/deploy_node");
const { qaNode } = require("../../src/core/nodes/qa_node");
const { fixPlanNode } = require("../../src/core/nodes/fix_plan_node");
const { buildResumeStateFromCurrentSnapshot, loadTraceIndex } = require("../../src/core/logic_utils");
const { ShellExecuteSkill } = require("../../src/skills/shell_exec");
const { GetServerIPSkill } = require("../../src/skills/get_server_ip");
const { AgentResourceExhaustedError, AgentServiceUnavailableError } = require("../../src/core/agent");

function createWorkflowAgents({ qaContent = '{"issues":[]}' } = {}) {
  return {
    pm: {
      getPersona() {
        return { name: "观止" };
      },
    },
    architect: {
      getPersona() {
        return { name: "独孤" };
      },
      async chat() {
        throw new Error("architect should not be called in replay harness");
      },
    },
    coder: {
      getPersona() {
        return { name: "星河" };
      },
      async chat() {
        throw new Error("coder should not be called in replay harness");
      },
    },
    qa: {
      getPersona() {
        return { name: "清扬" };
      },
      async chat() {
        return { content: qaContent };
      },
    },
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("workflow replay routes verifier planning gaps back to architect instead of fix_plan/deploy", async () => {
  const workspace = await createTempWorkspace();
  const verifierFailure = "[Verifier 预检失败]\n测试文件 tests/setup.test.ts 未找到断言语句（如 expect()、assert.）";

  try {
    const graph = await createJimClawGraph(createWorkflowAgents(), undefined, {
      workspacePath: workspace,
      traceId: "trace_workflow_block_verifier",
    });

    await assert.rejects(
      () => graph.invoke(createBaseState({
        resumeFromNode: "qa",
        retryCount: 20,
        testResults: verifierFailure,
        issueTracker: [],
        deploymentStatus: { status: "none" },
        contract: { title: "demo", requirements: [], acceptanceCriteria: [] },
        apiContract: { endpoints: [] },
        spec: {
          language: "TypeScript",
          filesToCreate: ["tests/setup.test.ts"],
        },
      })),
      /architect should not be called in replay harness/
    );

    const deployNoteExists = await fileExists(`${workspace}/nodes/note-deploy-r20.md`);
    assert.equal(deployNoteExists, false);

    const qaNote = await fs.readFile(`${workspace}/nodes/note-qa-r20.md`, "utf-8");
    assert.match(qaNote, /结论：阻塞/);
    assert.match(qaNote, /Verifier 预检失败：是/);

    const traceIndex = await loadTraceIndex(workspace);
    assert.equal(traceIndex.lastFailure.node, "architect");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("verifier routing sends environment gaps directly to env_guard", () => {
  const next = getVerifierNextNode(createBaseState({
    testResults: "[Verifier 预检失败]\n缺少 package.json：Node.js/TypeScript 项目必须包含 package.json，否则无法安装依赖和运行测试",
    validationReport: {
      version: "v1",
      status: "fail",
      failureType: "environment_gap",
      blocking: true,
      findings: [{ type: "environment_gap", summary: "缺少 package.json", evidence: ["缺少 package.json"] }],
    },
  }));

  assert.equal(next, "env_guard");
});

test("verifier routing sends runtime gaps directly to infra_setup", () => {
  const next = getVerifierNextNode(createBaseState({
    testResults: "[Verifier 预检失败]\n入口挂载缺失：src/index.ts 未挂载路由文件 src/routes/books.ts",
    validationReport: {
      version: "v1",
      status: "fail",
      failureType: "runtime_gap",
      blocking: true,
      findings: [{ type: "runtime_gap", summary: "入口挂载缺失", file: "src/index.ts", evidence: ["入口挂载缺失"] }],
    },
  }));

  assert.equal(next, "infra_setup");
});

test("qa routing stops repeated environment failures instead of looping env_guard forever", () => {
  const next = getQaNextNode(createBaseState({
    sameFailureCount: 2,
    retryCount: 2,
    validationReport: {
      version: "v1",
      status: "fail",
      failureType: "environment_gap",
      blocking: true,
      findings: [{ type: "environment_gap", summary: "npm install 失败", evidence: ["spawn EPERM"] }],
    },
    repairPlan: {
      repairType: "environment",
      targets: ["package.json"],
      actions: ["修复安装环境"],
      expectedEvidence: ["spawn EPERM"],
    },
    testResults: "[EnvGuard] 环境预检异常：spawn EPERM",
    blockedReason: "[EnvGuard] 环境预检异常：spawn EPERM",
  }), 5);

  assert.equal(next, "post_mortem");
});

test("qa routing sends host environment blocked failures directly to post_mortem", () => {
  const next = getQaNextNode(createBaseState({
    retryCount: 0,
    sameFailureCount: 0,
    validationReport: {
      version: "v1",
      status: "fail",
      failureType: "environment_gap",
      blocking: true,
      findings: [{ type: "environment_gap", summary: "docker 不可执行", evidence: ["spawn EPERM"] }],
    },
    repairPlan: {
      repairType: "environment",
      targets: ["Dockerfile"],
      actions: ["检查宿主机 Docker 环境"],
      expectedEvidence: ["spawn EPERM"],
    },
    testResults: "[基础设施构建失败] docker-compose 构建错误，请检查 Dockerfile 和 docker-compose.yml：\nCommand failed with error: spawn EPERM",
    blockedReason: "[基础设施构建失败] docker-compose 构建错误，请检查 Dockerfile 和 docker-compose.yml：\nCommand failed with error: spawn EPERM",
    lastFailureSummary: "[基础设施构建失败] docker-compose 构建错误",
  }), 5);

  assert.equal(next, "post_mortem");
});

test("deploy routing sends failed deployments back to qa runtime repair loop", () => {
  assert.equal(getDeployNextNode(createBaseState({
    deploymentStatus: { status: "failed", url: "http://127.0.0.1:4000" },
    validationReport: {
      version: "v1",
      status: "fail",
      failureType: "runtime_gap",
      blocking: true,
      findings: [{ type: "runtime_gap", summary: "服务启动崩溃", file: "src/index.ts", evidence: ["EADDRNOTAVAIL"] }],
    },
  })), "qa");

  assert.equal(getDeployNextNode(createBaseState({
    deploymentStatus: { status: "running", url: "http://127.0.0.1:4000" },
  })), "post_mortem");
});

test("managed harness routing can be disabled for verifier and deploy compatibility", () => {
  assert.equal(getVerifierNextNode(createBaseState({
    testResults: "PASS tests/books.test.ts",
  }), false), "qa");
  assert.equal(getVerifierNextNode(createBaseState({
    testResults: "PASS tests/books.test.ts",
  }), true), "evaluator");

  assert.equal(getDeployNextNode(createBaseState({
    deploymentStatus: { status: "running", url: "http://127.0.0.1:4000" },
  }), false), "post_mortem");
  assert.equal(getDeployNextNode(createBaseState({
    deploymentStatus: { status: "running", url: "http://127.0.0.1:4000" },
  }), true), "release_gate");
});

test("deploy routing sends early executor startup environment failures to post_mortem instead of qa runtime loop", () => {
  const { getDeployNextNode } = require("../../src/core/graph");

  assert.equal(getDeployNextNode(createBaseState({
    deploymentStatus: { status: "failed", url: "http://127.0.0.1:4000" },
    lastFailedNode: "deploy",
    lastFailureSummary: "[部署启动失败] spawn EPERM",
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
  })), "post_mortem");
});

test("verifier routing keeps implementation bugs flowing to qa analysis", () => {
  const next = getVerifierNextNode(createBaseState({
    testResults: "[Verifier 预检失败]\n语法错误(src/routes/books.ts:L1:C23): Expression expected",
    validationReport: {
      version: "v1",
      status: "fail",
      failureType: "implementation_bug",
      blocking: true,
      findings: [{ type: "implementation_bug", summary: "语法错误", file: "src/routes/books.ts", evidence: ["Expression expected"] }],
    },
  }));

  assert.equal(next, "qa");
});

test("infra routing sends infrastructure startup failures directly to qa instead of terminal/verifier", () => {
  const next = getInfraNextNode(createBaseState({
    containerId: "",
    lastFailedNode: "infra_setup",
    testResults: "[基础设施构建失败] docker-compose 构建错误，请检查 Dockerfile 和 docker-compose.yml：\nCommand failed with error: spawn EPERM",
    lastFailureSummary: "[基础设施构建失败] docker-compose 构建错误",
  }));

  assert.equal(next, "qa");
});

test("qa routing resumes coder after a successful staged validation checkpoint", () => {
  const next = getQaNextNode(createBaseState({
    resumeAfterValidation: true,
    validationReport: {
      version: "v1",
      status: "pass",
      blocking: false,
      findings: [],
    },
    subTasks: [
      { id: "t1", description: "core", fileTarget: "src/index.ts", dependencies: [], contextRequirement: "", status: "completed" },
      { id: "t2", description: "docs", fileTarget: "README.md", dependencies: [], contextRequirement: "", status: "pending" },
    ],
    issueTracker: [],
    protocolFailures: [],
    testResults: "PASS tests/books.test.ts",
    deploymentStatus: { status: "none" },
  }), 5);

  assert.equal(next, "coder");
});

test("workflow replay reopens completed config files through qa to fix_plan chain", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const baseState = createBaseState({
    retryCount: 0,
    testResults: "FAIL tests/books.test.ts\nCannot find module 'express' from src/app.ts",
    contract: { title: "demo", requirements: [], acceptanceCriteria: [] },
    apiContract: { endpoints: [] },
    spec: {
      language: "TypeScript",
      filesToCreate: ["package.json", "src/app.ts", "tests/books.test.ts"],
    },
    subTasks: [
      { id: "task-package", description: "pkg", fileTarget: "package.json", dependencies: [], contextRequirement: "", status: "completed" },
      { id: "task-app", description: "app", fileTarget: "src/app.ts", dependencies: ["package.json"], contextRequirement: "", status: "completed" },
      { id: "task-test", description: "books test", fileTarget: "tests/books.test.ts", dependencies: ["src/app.ts"], contextRequirement: "", status: "completed" },
    ],
  });

  try {
    const qaResult = await qaNode(
      baseState,
      {
        qa: {
          async chat() {
            return {
              content: '{"issues":[{"id":"BUG-001","title":"依赖缺失导致测试失败","description":"package.json 中缺少 express 运行时依赖，tests/books.test.ts 只是表层症状。","severity":"major","status":"open","relatedFiles":["tests/books.test.ts"],"rawErrorSnippet":"Cannot find module \\"express\\" from src/app.ts","detectedRound":1}]}',
            };
          },
        },
      },
      workspace,
      () => {},
      () => {},
      recorder.save
    );

    const qaState = { ...baseState, ...qaResult };
    assert.equal(getQaNextNode(qaState, 5), "fix_plan");
    assert.equal(qaState.qaFailures.failedFiles.includes("package.json"), true);

    const fixResult = await fixPlanNode(
      qaState,
      {
        coder: {
          getPersona() {
            return { name: "星河" };
          },
          async chat() {
            return {
              content: '{"overall_diagnosis":"先修测试文件","items":[{"file":"tests/books.test.ts","issue_id":"BUG-001","my_understanding":"测试文件需要调整导入","proposed_change":"修正测试文件导入","confidence":"medium"}]}',
            };
          },
        },
        qa: {
          getPersona() {
            return { name: "清扬" };
          },
          async chat() {
            return {
              content: '{"overall_assessment":"还缺 package.json 修复，但这里故意省略 additional_fixes","items":[{"file":"tests/books.test.ts","approved":true,"feedback":""}],"additional_fixes":[]}',
            };
          },
        },
      },
      workspace,
      () => {},
      () => {},
      recorder.save
    );

    assert.equal(fixResult.fixPlan.some((item) => item.fileTarget === "package.json"), true);
    assert.equal(fixResult.subTasks.find((task) => task.fileTarget === "package.json").status, "pending");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("workflow pauses into agent_pending when coder model service is unavailable", async () => {
  const workspace = await createTempWorkspace();

  try {
    const graph = await createJimClawGraph({
      ...createWorkflowAgents(),
      coder: {
        getPersona() {
          return { name: "星河" };
        },
        async chat() {
          throw new AgentServiceUnavailableError("星河", "Connection error.", "coding");
        },
      },
    }, undefined, {
      workspacePath: workspace,
      traceId: "trace_agent_pending",
    });

    const finalState = await graph.invoke(createBaseState({
      resumeFromNode: "coder",
      retryCount: 2,
      subTasks: [
        { id: "t1", description: "write test", fileTarget: "tests/books.test.ts", dependencies: [], contextRequirement: "", status: "pending" },
      ],
      spec: {
        language: "TypeScript",
        filesToCreate: ["tests/books.test.ts"],
      },
    }));

    assert.equal(finalState.agentRecoveryPending, true);
    assert.equal(finalState.agentRecoveryNode, "coder");
    assert.equal(finalState.resumeFromNode, "coder");
    assert.equal(finalState.validationReport.failureType, "environment_gap");

    const boulder = JSON.parse(await fs.readFile(`${workspace}/boulder.json`, "utf-8"));
    assert.equal(boulder.node, "agent_pending");
    assert.equal(boulder.state.agentRecoveryPending, true);
    assert.equal(boulder.state.agentRecoveryNode, "coder");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("workflow pauses into agent_pending when coder model quota is exhausted", async () => {
  const workspace = await createTempWorkspace();

  try {
    const graph = await createJimClawGraph({
      ...createWorkflowAgents(),
      coder: {
        getPersona() {
          return { name: "星河" };
        },
        async chat() {
          throw new AgentResourceExhaustedError("星河", "403 用户额度不足", "coding");
        },
      },
    }, undefined, {
      workspacePath: workspace,
      traceId: "trace_agent_quota_pending",
    });

    const finalState = await graph.invoke(createBaseState({
      resumeFromNode: "coder",
      retryCount: 2,
      subTasks: [
        { id: "t1", description: "write test", fileTarget: "tests/books.test.ts", dependencies: [], contextRequirement: "", status: "pending" },
      ],
      spec: {
        language: "TypeScript",
        filesToCreate: ["tests/books.test.ts"],
      },
    }));

    assert.equal(finalState.agentRecoveryPending, true);
    assert.equal(finalState.agentRecoveryNode, "coder");
    assert.equal(finalState.resumeFromNode, "coder");
    assert.equal(finalState.validationReport.failureType, "environment_gap");

    const boulder = JSON.parse(await fs.readFile(`${workspace}/boulder.json`, "utf-8"));
    assert.equal(boulder.node, "agent_pending");
    assert.equal(boulder.state.agentRecoveryPending, true);
    assert.equal(boulder.state.agentRecoveryNode, "coder");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("deploy pending approval persists executor ticket and resume state points back to deploy", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const originalGetServerIP = GetServerIPSkill.config.run;

  GetServerIPSkill.config.run = async () => "127.0.0.1";

  try {
    const result = await deployNode(
      createBaseState({
        executionBackend: "host",
        allocatedHostPort: 4000,
        manifest: { services: [{ name: "app", port: 10000, description: "demo" }], environment: {}, sharedConfig: {} },
        spec: {
          language: "TypeScript",
          filesToCreate: [],
          runCommand: "npm start",
        },
        deploymentStatus: { status: "none" },
      }),
      {},
      workspace,
      () => {},
      () => {},
      recorder.save,
      {
        commandExecutor: {
          executeIntent: async () => ({
            ok: false,
            backend: "local_shell",
            stdout: "",
            stderr: "",
            retryable: false,
            requiresApproval: true,
            approvalTicketId: "ticket-deploy",
            blocked: true,
            blockedReason: "approval required for start_runtime",
          }),
        },
      }
    );

    assert.equal(result.agentRecoveryPending, true);
    assert.equal(result.agentRecoveryNode, "deploy");
    assert.equal(result.pendingApprovalTicketId, "ticket-deploy");
    assert.equal(result.executorState?.approvalTickets?.some((ticket) => ticket.id === "ticket-deploy" && ticket.status === "pending"), true);
    assert.equal(hasPendingExecutorApproval({ ...createBaseState(), ...result }), true);

    const resumed = buildResumeStateFromCurrentSnapshot({
      node: "agent_pending",
      state: {
        ...createBaseState(),
        ...result,
      },
    });
    assert.equal(resumed.resumeFromNode, "deploy");
    assert.equal(resumed.pendingApprovalTicketId, "ticket-deploy");
  } finally {
    GetServerIPSkill.config.run = originalGetServerIP;
    await removeTempWorkspace(workspace);
  }
});

test("approved executor ticket no longer keeps graph in pending gate", () => {
  const state = createBaseState({
    agentRecoveryPending: true,
    agentRecoveryNode: "deploy",
    pendingApprovalTicketId: "ticket-deploy",
    executorState: {
      version: "v1",
      approvalTickets: [
        {
          id: "ticket-deploy",
          stage: "background_runtime",
          required: true,
          status: "approved",
          reason: "approval required for start_runtime",
          requestedAt: "2026-04-01T00:00:00.000Z",
          resolvedAt: "2026-04-01T00:01:00.000Z",
          resolvedBy: "customer",
        },
      ],
      runtimeHandles: [],
      lastExecutorResult: {
        ok: false,
        backend: "local_shell",
        stdout: "",
        stderr: "",
        retryable: false,
        requiresApproval: true,
        approvalTicketId: "ticket-deploy",
        blocked: true,
        blockedReason: "approval required for start_runtime",
      },
    },
  });

  assert.equal(hasPendingExecutorApproval(state), false);
});

test("deploy node persists deploy failure evidence and runtime ownership", async () => {
  const workspace = await createTempWorkspace();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalGetServerIP = GetServerIPSkill.config.run;

  ShellExecuteSkill.config.run = async ({ command }) => {
    if (command.startsWith("curl ")) return "Output:\n000\nErrors:\n";
    if (command.startsWith("docker exec ") && command.includes("netstat")) return "Output:\n\nErrors:\n";
    if (command.startsWith("docker logs ")) return "Output:\napp crashed on startup\nlisten EADDRNOTAVAIL\nErrors:\n";
    if (command.startsWith("docker rm -f")) return "Output:\nremoved\nErrors:\n";
    return "Output:\n\nErrors:\n";
  };
  GetServerIPSkill.config.run = async () => "127.0.0.1";

  try {
    const recorder = createSnapshotRecorder();
    const finalState = await deployNode(
      createBaseState({
      retryCount: 0,
      containerId: "container-123",
      allocatedHostPort: 4000,
      manifest: { services: [{ name: "app", port: 10000, description: "demo" }], environment: {}, sharedConfig: {} },
      spec: {
        language: "TypeScript",
        filesToCreate: [],
        entryPoint: "src/index.ts",
        runCommand: "npm start",
      },
      deploymentStatus: { status: "none" },
      }),
      {},
      workspace,
      () => {},
      () => {},
      recorder.save,
      {
        commandExecutor: {
          executeIntent: async () => ({
            ok: true,
            backend: "docker",
            stdout: "",
            stderr: "",
            retryable: false,
            requiresApproval: false,
            blocked: false,
          }),
        },
      }
    );

    assert.equal(finalState.deploymentStatus.status, "failed");
    assert.equal(finalState.lastFailedNode, "deploy");
    assert.equal(finalState.validationReport.failureType, "runtime_gap");
    assert.equal(finalState.repairPlan.repairType, "runtime");
    assert.match(finalState.lastFailureSummary || "", /EADDRNOTAVAIL|监听地址不可用|部署验证失败/);

    const deployNote = await fs.readFile(`${workspace}/nodes/note-deploy-r0.md`, "utf-8");
    assert.match(deployNote, /部署结论/);
    assert.match(deployNote, /状态：失败/);
    assert.match(deployNote, /app crashed on startup/);

    const infraAudit = await fs.readFile(`${workspace}/audit/Infrastructure.md`, "utf-8");
    assert.match(infraAudit, /Deployment Failed Verification/);
    assert.match(infraAudit, /app crashed on startup/);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    GetServerIPSkill.config.run = originalGetServerIP;
    await removeTempWorkspace(workspace);
  }
});
