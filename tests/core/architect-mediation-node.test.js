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
const { architectMediationNode } = require("../../src/core/nodes/architect_mediation_node");
const { AgentTimeoutError } = require("../../src/core/agent");

test("architect mediation returns directives and protocol patches", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    retryCount: 5,
    testResults: "FAIL tests/users.test.ts\nroute drift",
    executionProtocol: {
      version: "v1",
      project: {
        language: "TypeScript",
        framework: "Express",
        runtime: "node",
        workspaceLayout: {
          sourceRoots: ["src"],
          testRoots: ["tests"],
          entryFiles: ["src/index.ts"],
          configFiles: ["package.json"],
          infraFiles: [],
        },
      },
      contracts: {
        api: { endpoints: [{ method: "GET", path: "/api/users" }] },
        files: {
          "src/routes/users.ts": {
            role: "route",
            allowedDependencyRoles: ["controller", "service", "middleware", "model", "other"],
            ownedEndpoints: [],
          },
        },
      },
      runtime: {},
      workflow: { blockingRules: [], recoveryRules: [] },
      validation: { layoutRules: [], dependencyRules: [], runtimeRules: [], acceptanceRules: [] },
    },
    apiContract: {
      endpoints: [{ method: "GET", path: "/api/users", description: "list users" }],
    },
    issueTracker: [
      {
        id: "BUG-1",
        title: "users route drift",
        description: "route does not align with api contract",
        severity: "major",
        status: "open",
        relatedFiles: ["src/routes/users.ts"],
        detectedRound: 1,
      },
    ],
    consensusCore: {
      projectTitle: "demo",
      requirements: [],
      architectureSummary: "",
      techStack: "",
      framework: "Express",
      port: 10000,
      coreDependencies: {},
      coreDevDependencies: {},
      criticalDecisions: [],
    },
  });

  const agents = {
    architect: {
      async chat() {
        return {
          content: JSON.stringify({
            directives: [
              { file: "src/routes/users.ts", action: "rewrite", detail: "严格对齐 GET /api/users" },
            ],
            protocolPatches: [
              {
                target: "contracts",
                action: "replace",
                path: "files.src/routes/users.ts.ownedEndpoints",
                value: ["GET /api/users"],
                reason: "统一路由端点归属",
              },
            ],
          }),
        };
      },
    },
  };

  try {
    const result = await architectMediationNode(
      state,
      agents,
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.mediationDirectives.length, 1);
    assert.equal(result.protocolPatches.length, 1);
    assert.equal(result.protocolPatches[0].target, "contracts");
    assert.deepEqual(
      result.executionProtocol.contracts.files["src/routes/users.ts"].ownedEndpoints,
      ["GET /api/users"]
    );
    assert.equal(recorder.snapshots.at(-1).node, "architect_mediation");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("architect mediation falls back to protocol failures when issue tracker is empty", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    retryCount: 5,
    testResults: "FAIL tests/users.test.ts\nroute drift",
    executionProtocol: {
      version: "v1",
      project: {
        language: "TypeScript",
        framework: "Express",
        runtime: "node",
        workspaceLayout: {
          sourceRoots: ["src"],
          testRoots: ["tests"],
          entryFiles: ["src/index.ts"],
          configFiles: ["package.json"],
          infraFiles: [],
        },
      },
      contracts: {
        api: { endpoints: [{ method: "GET", path: "/api/users" }] },
        files: {
          "src/routes/users.ts": {
            role: "route",
            allowedDependencyRoles: ["controller", "service", "middleware", "model", "other"],
            ownedEndpoints: [],
          },
        },
      },
      runtime: {},
      workflow: { blockingRules: [], recoveryRules: [] },
      validation: { layoutRules: [], dependencyRules: [], runtimeRules: [], acceptanceRules: [] },
    },
    apiContract: {
      endpoints: [{ method: "GET", path: "/api/users", description: "list users" }],
    },
    issueTracker: [],
    protocolFailures: [
      {
        type: "contract_drift",
        node: "verifier",
        file: "src/routes/users.ts",
        summary: "users route 与 API 契约不一致",
        evidence: ["missing GET /api/users"],
        blocking: true,
      },
    ],
    consensusCore: {
      projectTitle: "demo",
      requirements: [],
      architectureSummary: "",
      techStack: "",
      framework: "Express",
      port: 10000,
      coreDependencies: {},
      coreDevDependencies: {},
      criticalDecisions: [],
    },
  });

  const agents = {
    architect: {
      async chat() {
        return {
          content: JSON.stringify({
            directives: [
              { file: "src/routes/users.ts", action: "rewrite", detail: "严格对齐 GET /api/users" },
            ],
            protocolPatches: [],
          }),
        };
      },
    },
  };

  try {
    const result = await architectMediationNode(
      state,
      agents,
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.mediationDirectives.length, 1);
    assert.equal(result.protocolPatches.length > 0, true);
    assert.deepEqual(
      result.executionProtocol.contracts.files["src/routes/users.ts"].ownedEndpoints,
      ["GET /api/users"]
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("architect mediation falls back to deterministic directives on recoverable timeout", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    retryCount: 5,
    testResults: "FAIL tests/users.test.ts\nroute drift",
    executionProtocol: {
      version: "v1",
      project: {
        language: "TypeScript",
        framework: "Express",
        runtime: "node",
        workspaceLayout: {
          sourceRoots: ["src"],
          testRoots: ["tests"],
          entryFiles: ["src/index.ts"],
          configFiles: ["package.json"],
          infraFiles: [],
        },
      },
      contracts: {
        api: { endpoints: [{ method: "GET", path: "/api/users" }] },
        files: {
          "src/routes/users.ts": {
            role: "route",
            allowedDependencyRoles: ["controller", "service", "middleware", "model", "other"],
            ownedEndpoints: [],
          },
        },
      },
      runtime: {},
      workflow: { blockingRules: [], recoveryRules: [] },
      validation: { layoutRules: [], dependencyRules: [], runtimeRules: [], acceptanceRules: [] },
    },
    apiContract: {
      endpoints: [{ method: "GET", path: "/api/users", description: "list users" }],
    },
    issueTracker: [
      {
        id: "BUG-1",
        title: "users route drift",
        description: "route does not align with api contract",
        severity: "major",
        status: "open",
        relatedFiles: ["src/routes/users.ts"],
        detectedRound: 1,
      },
    ],
    consensusCore: {
      projectTitle: "demo",
      requirements: [],
      architectureSummary: "",
      techStack: "",
      framework: "Express",
      port: 10000,
      coreDependencies: {},
      coreDevDependencies: {},
      criticalDecisions: [],
    },
  });

  const agents = {
    architect: {
      async chat() {
        throw new AgentTimeoutError("独孤", 12345);
      },
    },
  };

  try {
    const result = await architectMediationNode(
      state,
      agents,
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.mediationDirectives.length > 0, true);
    assert.equal(result.protocolPatches.length > 0, true);
    assert.equal(recorder.snapshots.at(-1).node, "architect_mediation");
  } finally {
    await removeTempWorkspace(workspace);
  }
});
