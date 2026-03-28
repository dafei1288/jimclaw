const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const {
  createTempWorkspace,
  removeTempWorkspace,
  createBaseState,
} = require("./test-helpers");
const { createJimClawGraph } = require("../../src/core/graph");
const { loadTraceIndex } = require("../../src/core/logic_utils");
const { ShellExecuteSkill } = require("../../src/skills/shell_exec");
const { GetServerIPSkill } = require("../../src/skills/get_server_ip");

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

test("workflow replay persists deploy failure evidence and failure ownership", async () => {
  const workspace = await createTempWorkspace();
  const originalShellRun = ShellExecuteSkill.config.run;
  const originalGetServerIP = GetServerIPSkill.config.run;

  ShellExecuteSkill.config.run = async ({ command }) => {
    if (command.startsWith("docker exec -d")) return "Output:\n\nErrors:\n";
    if (command.startsWith("curl ")) return "Output:\n000\nErrors:\n";
    if (command.startsWith("docker exec ") && command.includes("netstat")) return "Output:\n\nErrors:\n";
    if (command.startsWith("docker logs ")) return "Output:\napp crashed on startup\nlisten EADDRNOTAVAIL\nErrors:\n";
    if (command.startsWith("docker rm -f")) return "Output:\nremoved\nErrors:\n";
    return "Output:\n\nErrors:\n";
  };
  GetServerIPSkill.config.run = async () => "127.0.0.1";

  try {
    const graph = await createJimClawGraph(createWorkflowAgents(), undefined, {
      workspacePath: workspace,
      traceId: "trace_workflow_deploy_failure",
    });

    const finalState = await graph.invoke(createBaseState({
      resumeFromNode: "deploy",
      retryCount: 0,
      containerId: "container-123",
      allocatedHostPort: 4000,
      manifest: { services: [{ name: "app", port: 10000, description: "demo" }], environment: {}, sharedConfig: {} },
      spec: {
        language: "TypeScript",
        filesToCreate: [],
        runCommand: "npm start",
      },
      deploymentStatus: { status: "none" },
    }));

    assert.equal(finalState.deploymentStatus.status, "failed");
    assert.equal(finalState.lastFailedNode, "deploy");
    assert.match(finalState.lastFailureSummary || "", /部署验证失败|端口错配|无法访问/);

    const deployNote = await fs.readFile(`${workspace}/nodes/note-deploy-r0.md`, "utf-8");
    assert.match(deployNote, /部署结论/);
    assert.match(deployNote, /状态：失败/);
    assert.match(deployNote, /app crashed on startup/);

    const infraAudit = await fs.readFile(`${workspace}/audit/Infrastructure.md`, "utf-8");
    assert.match(infraAudit, /Deployment Failed Verification/);
    assert.match(infraAudit, /app crashed on startup/);

    const traceIndex = await loadTraceIndex(workspace);
    assert.equal(traceIndex.lastFailure.node, "deploy");
    assert.match(traceIndex.lastFailure.summary || "", /部署验证失败|端口错配|无法访问/);
  } finally {
    ShellExecuteSkill.config.run = originalShellRun;
    GetServerIPSkill.config.run = originalGetServerIP;
    await removeTempWorkspace(workspace);
  }
});
