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
    contractSource: "model",
    designSource: "model",
    orchestrationSource: "model",
    customerApprovalState: null,
    executorState: null,
    pendingApprovalStage: null,
    pendingApprovalTicketId: "",
    approvalNextNode: "",
    agentRecoveryPending: false,
    agentRecoveryNode: "",
    agentRecoveryReason: "",
    validationCheckpointRequested: false,
    validationCheckpointCompleted: false,
    validationCheckpointReason: "",
    resumeAfterValidation: false,
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

/**
 * Mock host.exec() for tests that previously mocked ShellExecuteSkill.
 * Takes a map of command patterns to ShellResult-like responses.
 */
function createHostExecMock(handlers) {
  const { host } = require("../../src/infra");
  const originalExec = host.exec.bind(host);
  const calls = [];

  host.exec = async (command, opts) => {
    calls.push({ command, opts });
    for (const [pattern, result] of handlers) {
      if (typeof pattern === "string" && command.startsWith(pattern)) {
        return result;
      }
      if (pattern instanceof RegExp && pattern.test(command)) {
        return result;
      }
    }
    // Default: return success with empty output
    return { ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false };
  };

  return {
    calls,
    restore() {
      host.exec = originalExec;
    },
  };
}

/**
 * Helper: create a successful ShellResult
 */
function shellOk(stdout = "", stderr = "") {
  return { ok: true, stdout, stderr, exitCode: 0, timedOut: false };
}

/**
 * Helper: create a failed ShellResult
 */
function shellFail(exitCode, stdout = "", stderr = "") {
  return { ok: false, stdout, stderr, exitCode, timedOut: false };
}

/**
 * Helper: create a timed-out ShellResult
 */
function shellTimeout(stdout = "", stderr = "") {
  return { ok: false, stdout, stderr, exitCode: null, timedOut: true };
}

module.exports = {
  createTempWorkspace,
  removeTempWorkspace,
  createBaseState,
  createCoderAgent,
  createNoopEmit,
  createNoopStartSpan,
  createSnapshotRecorder,
  createHostExecMock,
  shellOk,
  shellFail,
  shellTimeout,
};
