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
  ensureTypeScriptTestBaseline,
  ensureRequirementDrivenApiContract,
  stabilizeSpecForExecution,
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
        "src/repositories/userRepository.ts",
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
  assert.equal(protocol.contracts.files["src/repositories/userRepository.ts"].role, "repository");
  assert.equal(protocol.contracts.files["src/repositories/userRepository.ts"].allowedDependencyRoles.includes("model"), true);
  assert.deepEqual(protocol.contracts.files["src/routes/users.ts"].ownedEndpoints, ["GET /api/users"]);
  assert.equal(protocol.runtime.listenPort, 12345);
  assert.equal(protocol.runtime.healthCheckPath, "/");
});

test("buildExecutionProtocol does not synthesize write endpoints for read-only book APIs", () => {
  const requirementProtocol = buildRequirementProtocol({
    title: "TypeScript Express 图书列表应用 MVP",
    requirements: [
      "使用 TypeScript 与 Express 创建服务端应用，并提供可启动的 HTTP 服务，包含图书数据的基础领域模型与最小必要的数据来源，以支撑页面与 API 返回一致的图书列表内容。",
      "实现图书列表页面路由 /books，返回可在浏览器中访问的 HTML 内容，并展示图书列表中的关键信息，满足最小可用的列表浏览需求。",
      "实现图书列表 JSON API 路由 /api/books，返回图书数组数据，响应格式稳定且可被自动化测试验证。",
      "提供自动化测试与可执行的验证脚本，覆盖服务启动后对 /books 与 /api/books 的核心行为校验，确保应用功能可重复验证。",
    ],
    acceptanceCriteria: [
      "访问 /books 时返回包含图书列表的 HTML 页面。",
      "访问 GET /api/books 时返回图书数组 JSON。",
      "GET /api/books returns a book array.",
      "自动化测试覆盖 /books 与 GET /api/books。",
    ],
  });
  assert.equal(requirementProtocol.capabilities.crudEntities.includes("book"), true);

  const apiContract = ensureRequirementDrivenApiContract(
    {
      endpoints: [{ method: "GET", path: "/api/books", description: "返回图书数组" }],
    },
    requirementProtocol
  );

  const protocol = buildExecutionProtocol(
    {
      language: "TypeScript",
      framework: "Express.js ^4.18",
      testCommand: "npm test",
      runCommand: "npm start",
      entryPoint: "src/index.ts",
      filesToCreate: ["package.json", "tsconfig.json", "src/index.ts", "src/bookService.ts", "tests/books.test.ts"],
    },
    {
      services: [{ name: "api", port: 4000 }],
    },
    apiContract,
    requirementProtocol
  );

  const bookEndpoints = protocol.contracts.api.endpoints
    .map((endpoint) => `${endpoint.method} ${endpoint.path}`)
    .filter((endpoint) => endpoint.includes("/api/books"));

  assert.deepEqual(bookEndpoints, ["GET /api/books"]);
});

test("ensureRequirementDrivenApiContract synthesizes write endpoints for explicit entity mutations", () => {
  const requirementProtocol = buildRequirementProtocol({
    title: "图书管理系统",
    requirements: ["前端页面支持图书列表、添加、编辑、删除。"],
    acceptanceCriteria: ["用户可以新增图书、编辑图书并删除图书。"],
  });

  const apiContract = ensureRequirementDrivenApiContract(
    {
      endpoints: [{ method: "GET", path: "/api/books", description: "返回图书数组" }],
    },
    requirementProtocol
  );

  const bookEndpoints = apiContract.endpoints
    .map((endpoint) => `${endpoint.method} ${endpoint.path}`)
    .filter((endpoint) => endpoint.includes("/api/books"));

  assert.deepEqual(bookEndpoints, ["GET /api/books", "POST /api/books", "PUT /api/books/:id", "DELETE /api/books/:id"]);
});

test("buildExecutionProtocol emits frontend contract for React SPA", () => {
  const requirementProtocol = buildRequirementProtocol({
    title: "商品目录应用",
    requirements: ["使用 React 构建现代前端页面", "提供商品列表 API GET /api/products"],
    acceptanceCriteria: ["前端可以展示商品列表。", "GET /api/products 返回商品数组。"],
  });

  const protocol = buildExecutionProtocol(
    {
      language: "TypeScript",
      framework: "Express.js ^4.18",
      testCommand: "npm test",
      runCommand: "npm start",
      entryPoint: "src/index.ts",
      frontend: {
        language: "TypeScript",
        framework: "React",
        buildCommand: "cd frontend && npm run build",
        testCommand: "cd frontend && npx vitest run",
        outputDir: "frontend/dist",
        sourceDir: "frontend",
      },
      filesToCreate: [
        "package.json",
        "tsconfig.json",
        "src/index.ts",
        "tests/products.test.ts",
        "frontend/package.json",
        "frontend/index.html",
        "frontend/src/main.tsx",
        "frontend/src/App.tsx",
        "frontend/src/api.ts",
      ],
    },
    {
      services: [{ name: "api", port: 4100 }],
    },
    {
      endpoints: [{ method: "GET", path: "/api/products", description: "返回商品数组" }],
    },
    requirementProtocol
  );

  assert.deepEqual(protocol.project.workspaceLayout.frontendRoots, ["frontend"]);
  assert.equal(protocol.contracts.frontend.appType, "spa");
  assert.equal(protocol.contracts.frontend.framework, "react");
  assert.equal(protocol.contracts.frontend.rootDir, "frontend");
  assert.deepEqual(protocol.contracts.frontend.entryFiles, ["frontend/index.html", "frontend/src/main.tsx", "frontend/src/App.tsx"]);
  assert.deepEqual(protocol.contracts.frontend.apiUsage, [
    {
      resourcePath: "/api/products",
      methods: ["GET"],
      supportsList: true,
      supportsCreate: false,
      supportsUpdate: false,
      supportsDelete: false,
    },
  ]);
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

test("customer approval rebuild preserves existing manual approvals", () => {
  const previous = buildCustomerApprovalState({
    autoApprove: { requirements: false, solution: false, deploy: false },
    summaries: { requirements: "旧需求摘要", solution: "旧方案摘要" },
  });
  previous.checkpoints = previous.checkpoints.map((checkpoint) =>
    checkpoint.stage === "requirements"
      ? {
          ...checkpoint,
          approved: true,
          approvedBy: "customer",
          timestamp: "2026-05-14 13:00:00",
        }
      : checkpoint
  );

  const rebuilt = buildCustomerApprovalState({
    previous,
    autoApprove: previous.autoApprove,
    summaries: { requirements: "新需求摘要", solution: "新方案摘要" },
  });

  const requirements = rebuilt.checkpoints.find((item) => item.stage === "requirements");
  const solution = rebuilt.checkpoints.find((item) => item.stage === "solution");
  assert.equal(requirements.approved, true);
  assert.equal(requirements.approvedBy, "customer");
  assert.equal(requirements.timestamp, "2026-05-14 13:00:00");
  assert.equal(requirements.summary, "新需求摘要");
  assert.equal(solution.approved, false);
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

test("buildExecutionProtocol detects java and rust runtimes", () => {
  const requirementProtocol = buildRequirementProtocol({
    title: "多语言服务",
    requirements: ["提供后端 API"],
    acceptanceCriteria: ["服务可启动"],
  });

  const javaProtocol = buildExecutionProtocol(
    {
      language: "Java",
      framework: "Spring Boot",
      testCommand: "mvn test",
      runCommand: "mvn spring-boot:run",
      entryPoint: "src/main/java/com/example/Application.java",
      filesToCreate: ["pom.xml", "src/main/java/com/example/Application.java"],
    },
    { services: [{ name: "api", port: 18080 }] },
    { endpoints: [{ method: "GET", path: "/api/health" }] },
    requirementProtocol
  );
  const rustProtocol = buildExecutionProtocol(
    {
      language: "Rust",
      framework: "Axum",
      testCommand: "cargo test",
      runCommand: "cargo run",
      entryPoint: "src/main.rs",
      filesToCreate: ["Cargo.toml", "src/main.rs"],
    },
    { services: [{ name: "api", port: 18081 }] },
    { endpoints: [{ method: "GET", path: "/api/health" }] },
    requirementProtocol
  );

  assert.equal(javaProtocol.project.runtime, "java");
  assert.equal(rustProtocol.project.runtime, "rust");
});

test("ensureTypeScriptTestBaseline preserves vitest projects without injecting jest baseline", () => {
  const nextSpec = ensureTypeScriptTestBaseline({
    language: "TypeScript",
    testCommand: "npm test",
    filesToCreate: ["package.json", "vitest.config.ts", "tests/books.test.ts"],
    devDependencies: {
      vitest: "^2.1.8",
    },
  });

  assert.deepEqual(nextSpec.filesToCreate, ["package.json", "vitest.config.ts", "tests/books.test.ts"]);
  assert.equal("jest" in (nextSpec.devDependencies || {}), false);
  assert.equal("ts-jest" in (nextSpec.devDependencies || {}), false);
  assert.equal("@types/jest" in (nextSpec.devDependencies || {}), false);
});

test("stabilizeSpecForExecution compacts aliased simple CRUD files into a bounded canonical plan", () => {
  const requirementProtocol = buildRequirementProtocol({
    title: "图书管理系统",
    requirements: [
      "实现一个图书管理系统：包含前端页面和后端 API",
      "支持图书列表、添加图书、借阅/归还状态切换",
      "提供 /api/health 健康检查",
      "必须带基础测试与 Docker 部署",
      "需要基础权限管理和审计日志",
    ],
    acceptanceCriteria: ["界面可直接在浏览器访问"],
  });

  const nextSpec = stabilizeSpecForExecution(
    {
      language: "TypeScript",
      framework: "Express.js ^4.18",
      testCommand: "vitest run",
      runCommand: "npm start",
      entryPoint: "src/index.ts",
      filesToCreate: [
        "package.json",
        "tsconfig.json",
        ".env.example",
        "README.md",
        "Dockerfile",
        "docker-compose.yml",
        "vitest.config.ts",
        "src/index.ts",
        "src/app.ts",
        "src/public/index.html",
        "src/public/styles.css",
        "src/public/app.js",
        "public/index.html",
        "src/routes/book-routes.ts",
        "src/routes/books.ts",
        "src/controllers/book-controller.ts",
        "src/controllers/bookController.ts",
        "src/services/book-service.ts",
        "src/services/bookService.ts",
        "src/models/book.ts",
        "src/repositories/book-repository.ts",
        "src/middleware/authenticate.ts",
        "src/routes/auth.ts",
        "src/logging/logger.ts",
        "src/errors.ts",
        "src/scripts/verify.ts",
        "scripts/verify.ps1",
        "tests/health.test.ts",
        "tests/books.test.ts",
        "tests/auth.test.ts",
        "jest.config.cjs",
        "tests/setup.test.ts",
      ],
      dependencies: { express: "^4.18.3", zod: "^3.23.8" },
      devDependencies: { vitest: "^2.1.8", jest: "^29.7.0" },
    },
    requirementProtocol
  );

  assert.equal(nextSpec.filesToCreate.includes("src/public/index.html"), false);
  assert.equal(nextSpec.filesToCreate.includes("src/routes/book-routes.ts"), false);
  assert.equal(nextSpec.filesToCreate.includes("src/controllers/book-controller.ts"), false);
  assert.equal(nextSpec.filesToCreate.includes("src/services/book-service.ts"), false);
  assert.equal(nextSpec.filesToCreate.includes("jest.config.cjs"), false);
  assert.equal(nextSpec.filesToCreate.includes("tests/setup.test.ts"), false);
  assert.equal(nextSpec.filesToCreate.includes("public/index.html"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/routes/books.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/controllers/bookController.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/services/bookService.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/services/bookQueryService.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/services/bookMutationService.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/services/bookInventoryService.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/models/book.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/middleware/auth.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/controllers/authController.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/services/authService.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/services/authSessionService.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/services/authCredentialService.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/services/authAccountPolicyService.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/errors.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("scripts/verify.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/repositories/bookRepository.ts"), false);
  assert.equal(nextSpec.filesToCreate.includes("src/app.ts"), false);
  assert.equal(nextSpec.filesToCreate.length <= 30, true);
});

test("stabilizeSpecForExecution removes install artifacts and build outputs from filesToCreate", () => {
  const nextSpec = stabilizeSpecForExecution(
    {
      language: "TypeScript",
      framework: "Express.js ^4.18",
      testCommand: "npm test",
      runCommand: "npm start",
      entryPoint: "src/index.ts",
      filesToCreate: [
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lockb",
        "node_modules/.cache/foo",
        "dist/index.js",
        "coverage/lcov.info",
        ".next/server.js",
        "Cargo.lock",
        "target/debug/app",
        "gradle.lockfile",
        ".gradle/8.0/fileHashes.bin",
        "target/classes/App.class",
        "src/index.ts",
        "tests/health.test.ts",
      ],
    },
    buildRequirementProtocol({
      title: "图书管理系统",
      requirements: ["提供图书管理 API"],
      acceptanceCriteria: ["健康检查可用"],
    })
  );

  assert.equal(nextSpec.filesToCreate.includes("package-lock.json"), false);
  assert.equal(nextSpec.filesToCreate.includes("pnpm-lock.yaml"), false);
  assert.equal(nextSpec.filesToCreate.includes("yarn.lock"), false);
  assert.equal(nextSpec.filesToCreate.includes("bun.lockb"), false);
  assert.equal(nextSpec.filesToCreate.includes("node_modules/.cache/foo"), false);
  assert.equal(nextSpec.filesToCreate.includes("dist/index.js"), false);
  assert.equal(nextSpec.filesToCreate.includes("coverage/lcov.info"), false);
  assert.equal(nextSpec.filesToCreate.includes(".next/server.js"), false);
  assert.equal(nextSpec.filesToCreate.includes("Cargo.lock"), false);
  assert.equal(nextSpec.filesToCreate.includes("target/debug/app"), false);
  assert.equal(nextSpec.filesToCreate.includes("gradle.lockfile"), false);
  assert.equal(nextSpec.filesToCreate.includes(".gradle/8.0/fileHashes.bin"), false);
  assert.equal(nextSpec.filesToCreate.includes("target/classes/App.class"), false);
  assert.equal(nextSpec.filesToCreate.includes("package.json"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/index.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("tests/health.test.ts"), true);
});

test("stabilizeSpecForExecution keeps fallback auth layout compact when explicitly requested", () => {
  const nextSpec = stabilizeSpecForExecution(
    {
      language: "TypeScript",
      framework: "Express.js ^5.0",
      testCommand: "npm test",
      runCommand: "npm start",
      entryPoint: "src/index.ts",
      authScaffoldMode: "compact",
      filesToCreate: [
        "package.json",
        "tsconfig.json",
        "src/index.ts",
        "src/routes/books.ts",
        "src/controllers/bookController.ts",
        "src/services/bookService.ts",
        "src/models/book.ts",
        "src/middleware/auth.ts",
        "src/routes/auth.ts",
        "src/controllers/authController.ts",
        "src/services/authService.ts",
        "tests/books.test.ts",
        "tests/auth.test.ts",
      ],
    },
    buildRequirementProtocol({
      title: "图书管理系统",
      requirements: ["实现图书管理系统，包含登录鉴权"],
      acceptanceCriteria: ["用户能够登录并访问受保护接口"],
    })
  );

  assert.equal(nextSpec.filesToCreate.includes("src/services/authService.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/services/authSessionService.ts"), false);
  assert.equal(nextSpec.filesToCreate.includes("src/services/authCredentialService.ts"), false);
  assert.equal(nextSpec.filesToCreate.includes("src/services/authAccountPolicyService.ts"), false);
});

test("stabilizeSpecForExecution auto-adds .dockerignore when docker artifacts are planned", () => {
  const nextSpec = stabilizeSpecForExecution(
    {
      language: "TypeScript",
      framework: "Express.js ^4.18",
      testCommand: "npm test",
      runCommand: "npm start",
      entryPoint: "src/index.ts",
      filesToCreate: [
        "package.json",
        "tsconfig.json",
        "Dockerfile",
        "docker-compose.yml",
        "src/index.ts",
        "tests/health.test.ts",
      ],
    },
    buildRequirementProtocol({
      title: "图书管理系统",
      requirements: ["提供可 Docker 部署的图书管理系统"],
      acceptanceCriteria: ["容器构建时不应把 node_modules 带入上下文"],
    })
  );

  assert.equal(nextSpec.filesToCreate.includes("Dockerfile"), true);
  assert.equal(nextSpec.filesToCreate.includes("docker-compose.yml"), true);
  assert.equal(nextSpec.filesToCreate.includes(".dockerignore"), true);
});

test("stabilizeSpecForExecution also applies bounded service splitting to backend-only CRUD contracts", () => {
  const requirementProtocol = buildRequirementProtocol({
    title: "图书管理系统",
    requirements: [
      "提供图书新增、编辑、删除、检索与借阅相关后端 API",
      "需要登录鉴权、日志审计、统一错误处理与验证脚本",
    ],
    acceptanceCriteria: ["后端接口可通过测试脚本验证"],
  });

  const nextSpec = stabilizeSpecForExecution(
    {
      language: "TypeScript",
      framework: "Express.js ^4.18",
      testCommand: "npm test",
      runCommand: "npm start",
      entryPoint: "src/index.ts",
      filesToCreate: [
        "package.json",
        "tsconfig.json",
        "jest.config.cjs",
        "src/index.ts",
        "src/errors.ts",
        "src/logging/logger.ts",
        "src/models/book.ts",
        "src/services/authService.ts",
        "src/services/bookService.ts",
        "src/middleware/auth.ts",
        "src/controllers/authController.ts",
        "src/controllers/bookController.ts",
        "src/routes/auth.ts",
        "src/routes/books.ts",
        "tests/auth.test.ts",
        "tests/books.test.ts",
        "tests/setup.test.ts",
        "scripts/verify.ts",
      ],
    },
    requirementProtocol
  );

  assert.equal(nextSpec.filesToCreate.includes("src/services/authSessionService.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/services/authCredentialService.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/services/authAccountPolicyService.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/services/bookQueryService.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/services/bookMutationService.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/services/bookInventoryService.ts"), true);
});

test("stabilizeSpecForExecution prefers the title entity over support entities like user when selecting the primary domain", () => {
  const requirementProtocol = buildRequirementProtocol({
    title: "图书管理系统",
    requirements: [
      "支持用户注册、登录与权限控制",
      "支持图书新增、检索、库存管理与验证脚本",
    ],
    acceptanceCriteria: ["图书接口可正常工作"],
  });

  const nextSpec = stabilizeSpecForExecution(
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
        "src/models/user.ts",
        "src/models/book.ts",
        "src/services/authService.ts",
        "src/services/bookService.ts",
        "src/controllers/authController.ts",
        "src/controllers/bookController.ts",
        "src/routes/auth.ts",
        "src/routes/books.ts",
        "src/errors.ts",
        "src/logging/logger.ts",
        "tests/auth.test.ts",
        "tests/books.test.ts",
      ],
    },
    requirementProtocol
  );

  assert.equal(nextSpec.filesToCreate.includes("src/services/bookQueryService.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/services/bookMutationService.ts"), true);
  assert.equal(nextSpec.filesToCreate.includes("src/services/userQueryService.ts"), false);
  assert.equal(nextSpec.filesToCreate.includes("src/services/userMutationService.ts"), false);
});
