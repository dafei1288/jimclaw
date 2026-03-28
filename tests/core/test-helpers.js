require("ts-node/register/transpile-only");

const path = require("path");
const os = require("os");
const fs = require("fs/promises");

async function createTempWorkspace(prefix = "jimclaw-test-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function removeTempWorkspace(workspace) {
  await fs.rm(workspace, { recursive: true, force: true });
}

function createBaseState(overrides = {}) {
  return {
    retryCount: 0,
    code: "{}",
    subTasks: [],
    qaFailures: null,
    fixPlan: null,
    issueTracker: [],
    mediationDirectives: null,
    testResults: "",
    apiContract: null,
    requirementProtocol: null,
    technologyDecision: null,
    executionPlan: null,
    solutionProtocol: null,
    executionProtocol: null,
    validationReport: null,
    runtimeStateSnapshot: null,
    repairPlan: null,
    customerApprovalState: null,
    pendingApprovalStage: null,
    approvalNextNode: "",
    protocolFailures: [],
    protocolPatches: [],
    spec: {
      language: "TypeScript",
      filesToCreate: [],
    },
    consensusProgress: {
      completedFiles: [],
      pendingFiles: [],
      currentRound: 0,
      openIssues: [],
    },
    ...overrides,
  };
}

function createAgentResponse(content) {
  return { content };
}

function createCoderAgent(content) {
  return {
    getPersona() {
      return { name: "测试Coder" };
    },
    async chat() {
      return createAgentResponse(content);
    },
  };
}

function createNoopEmit() {}

function createNoopStartSpan() {}

function createSnapshotRecorder() {
  const snapshots = [];
  return {
    snapshots,
    async save(state, nodeName) {
      snapshots.push({
        node: nodeName,
        state: JSON.parse(JSON.stringify(state)),
      });
    },
  };
}

module.exports = {
  createTempWorkspace,
  removeTempWorkspace,
  createBaseState,
  createCoderAgent,
  createNoopEmit,
  createNoopStartSpan,
  createSnapshotRecorder,
};
