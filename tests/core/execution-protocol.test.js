const test = require("node:test");
const assert = require("node:assert/strict");
const { createBaseState } = require("./test-helpers");
const {
  buildRequirementProtocol,
  buildTechnologyDecision,
  buildSolutionProtocol,
  buildExecutionProtocol,
  buildValidationReport,
  buildRepairPlan,
  buildCustomerApprovalState,
  buildSystemContext,
} = require("../../src/core/logic_utils");

test("buildExecutionProtocol emits normalized layout and file contracts", () => {
  const requirementProtocol = buildRequirementProtocol({
    title: "图书管理系统",
    requirements: ["实现前后端图书管理系统，前端可直接操作", "提供后端 API"],
    acceptanceCriteria: ["用户能够在前端页面查看图书列表"],
  });
  const protocol = buildExecutionProtocol(
    {
      language: "TypeScript",
      framework: "Express.js ^4.18",
      testCommand: "npm test",
      runCommand: "npm start",
      entryPoint: "src/index.ts",
      filesToCreate: [
        "package.json",
        "tsconfig.json",
        "src/index.ts",
        "src/routes/users.ts",
        "src/controllers/userController.ts",
        "src/tests/user.test.ts",
      ],
    },
    {
      services: [{ name: "api", port: 12345 }],
    },
    {
      endpoints: [{ method: "GET", path: "/api/users" }],
    },
    requirementProtocol
  );

  assert.equal(protocol.version, "v1");
  assert.equal(protocol.requirements.capabilities.frontendRequired, true);
  assert.deepEqual(protocol.project.workspaceLayout.testRoots, ["tests"]);
  assert.deepEqual(protocol.project.workspaceLayout.frontendRoots, ["public"]);
  assert.equal(protocol.solution.coverage.frontendPlanned, true);
  assert.equal(protocol.contracts.files["public/index.html"].role, "other");
  assert.equal(protocol.contracts.files["tests/user.test.ts"].role, "test");
  assert.equal(protocol.contracts.files["src/routes/users.ts"].role, "route");
  assert.deepEqual(protocol.contracts.files["src/routes/users.ts"].ownedEndpoints, ["GET /api/users"]);
  assert.equal(protocol.runtime.listenPort, 12345);
  assert.equal(protocol.runtime.healthCheckPath, "/");
});

test("buildSolutionProtocol reports uncovered frontend requirements when no UI files exist", () => {
  const requirementProtocol = buildRequirementProtocol({
    title: "图书管理系统",
    requirements: ["需要前端页面和后端 API"],
    acceptanceCriteria: ["用户能够在前端页面添加图书"],
  });
  const solution = buildSolutionProtocol(
    requirementProtocol,
    {
      language: "TypeScript",
      filesToCreate: ["src/index.ts", "src/routes/books.ts"],
    },
    {
      endpoints: [{ method: "GET", path: "/api/books" }],
    }
  );

  assert.equal(solution.coverage.frontendPlanned, false);
  assert.equal(solution.coverage.backendPlanned, true);
  assert.equal(solution.coverage.uncoveredRequirements.length > 0, true);
  assert.equal(solution.coverage.uncoveredAcceptanceCriteria.length > 0, true);
});

test("control-plane builders produce technology, validation, repair and approval objects", () => {
  const requirementProtocol = buildRequirementProtocol({
    title: "电器销售系统",
    requirements: ["需要前后端页面和后端 API", "需要 Docker 部署"],
    acceptanceCriteria: ["用户可以在前端管理商品"],
  });
  const technologyDecision = buildTechnologyDecision(requirementProtocol, {
    language: "TypeScript",
    framework: "Express.js ^4.18",
    testCommand: "npm test",
    entryPoint: "src/index.ts",
    filesToCreate: ["public/index.html", "src/index.ts", "docker-compose.yml"],
  });
  const validationReport = buildValidationReport(
    [
      {
        summary: "缺少前端页面挂载",
        file: "src/index.ts",
        evidence: ["未检测到静态资源入口"],
      },
    ],
    { failureType: "planning_gap" }
  );
  const repairPlan = buildRepairPlan(validationReport);
  const customerApprovalState = buildCustomerApprovalState({
    autoApprove: { requirements: true, solution: false, deploy: false },
    summaries: {
      requirements: "需求默认授权",
      solution: "方案需确认",
      deploy: "部署需确认",
    },
  });

  assert.equal(technologyDecision.frontend.framework, "vanilla");
  assert.equal(technologyDecision.backend.framework, "express-typescript");
  assert.equal(technologyDecision.deploy.docker, true);
  assert.equal(validationReport.failureType, "planning_gap");
  assert.equal(repairPlan.repairType, "planning");
  assert.equal(customerApprovalState.checkpoints.length, 3);
  assert.equal(customerApprovalState.checkpoints[0].approved, true);
  assert.equal(customerApprovalState.checkpoints[1].approved, false);
});

test("buildSystemContext includes control-plane summaries", () => {
  const requirementProtocol = buildRequirementProtocol({
    title: "demo",
    requirements: ["需要前端页面和后端 API"],
    acceptanceCriteria: ["用户可以打开首页"],
  });
  const protocol = buildExecutionProtocol(
    {
      language: "TypeScript",
      framework: "Express.js ^4.18",
      testCommand: "npm test",
      runCommand: "npm start",
      entryPoint: "src/index.ts",
      filesToCreate: ["package.json", "src/index.ts", "tests/setup.test.ts"],
    },
    {
      services: [{ name: "api", port: 10000 }],
    },
    {
      endpoints: [{ method: "GET", path: "/api/health" }],
    },
    requirementProtocol
  );
  const technologyDecision = buildTechnologyDecision(requirementProtocol, {
    language: "TypeScript",
    framework: "Express.js ^4.18",
    testCommand: "npm test",
    entryPoint: "src/index.ts",
    filesToCreate: ["package.json", "src/index.ts", "public/index.html", "tests/setup.test.ts"],
  });
  const validationReport = buildValidationReport(
    [
      {
        summary: "缺少前端入口",
        file: "src/index.ts",
        evidence: ["未检测到 express.static"],
      },
    ],
    { failureType: "planning_gap" }
  );
  const repairPlan = buildRepairPlan(validationReport);
  const customerApprovalState = buildCustomerApprovalState({
    autoApprove: { requirements: true, solution: true, deploy: false },
    summaries: {
      requirements: "需求默认授权",
      solution: "方案默认授权",
      deploy: "部署需人工确认",
    },
  });
  const state = createBaseState({
    consensusCore: {
      projectTitle: "demo",
      requirements: ["x"],
      architectureSummary: "summary",
      techStack: "TypeScript + Express",
      framework: "Express",
      port: 10000,
      coreDependencies: { express: "^4.18.2" },
      coreDevDependencies: { typescript: "^5.0.0" },
      criticalDecisions: [],
    },
    requirementProtocol,
    technologyDecision,
    solutionProtocol: protocol.solution,
    executionProtocol: protocol,
    validationReport,
    repairPlan,
    customerApprovalState,
  });

  const context = buildSystemContext(state).join("\n");
  assert.match(context, /\[需求协议\]/);
  assert.match(context, /frontendRequired：是/);
  assert.match(context, /\[方案覆盖\]/);
  assert.match(context, /\[执行协议\]/);
  assert.match(context, /testRoots：tests/);
  assert.match(context, /frontendRoots：public/);
  assert.match(context, /healthCheckPath：\/api\/health/);
  assert.match(context, /\[技术决策\]/);
  assert.match(context, /backend: express-typescript/);
  assert.match(context, /\[验证报告\]/);
  assert.match(context, /failureType: planning_gap/);
  assert.match(context, /\[修复计划\]/);
  assert.match(context, /repairType: planning/);
  assert.match(context, /\[客户确认\]/);
  assert.match(context, /deploy=否/);
});
