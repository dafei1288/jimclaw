import * as fs from "fs/promises";
import * as path from "path";
import { AgentResourceExhaustedError, AgentServiceUnavailableError, AgentTimeoutError, BaseAgent } from "../agent";
import { ConsensusCore, ConsensusProgress, JimClawState, PlanningSource, TechSpecSchema } from "../graph_types";
import {
  buildCustomerApprovalState,
  buildExecutionProtocol,
  buildRepairPlan,
  buildRequirementProtocol,
  buildSolutionProtocol,
  buildSystemContext,
  buildTechnologyDecision,
  buildValidationReport,
  ensureRequirementDrivenApiContract,
  logPrefix,
  stabilizeSpecForExecution,
  writeMeetingNote,
} from "../logic_utils";
import { extractText, parseJsonFromResponse } from "../../utils/common";
import { getTemplateEngine } from "../template_engine";
import { FindFreePortSkill } from "../../skills/find_free_port";

const ARCHITECT_MODEL_TIMEOUT_MS = 120000;
const ARCHITECT_README_TIMEOUT_MS = 30000;

function isRecoverableAgentError(error: unknown): error is AgentTimeoutError | AgentServiceUnavailableError | AgentResourceExhaustedError {
  return (
    error instanceof AgentTimeoutError ||
    error instanceof AgentServiceUnavailableError ||
    error instanceof AgentResourceExhaustedError
  );
}

function singularizeStem(value: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "item";
  if (normalized.endsWith("ies")) return `${normalized.slice(0, -3)}y`;
  if (normalized.endsWith("ses")) return normalized.slice(0, -2);
  if (normalized.endsWith("s") && normalized.length > 1) return normalized.slice(0, -1);
  return normalized;
}

function getPrimaryEntity(requirementProtocol: any): { singular: string; plural: string } {
  const primary = requirementProtocol?.capabilities?.crudEntities?.[0]
    || requirementProtocol?.capabilities?.entities?.[0]
    || "item";
  const singular = singularizeStem(primary);
  const plural = singular.endsWith("s") ? singular : `${singular}s`;
  return { singular, plural };
}

/**
 * 判断用户目标是否为简单的 API 服务（只需几个端点，不需要完整 CRUD 分层）
 */
function isSimpleApiGoal(goal: string): boolean {
  const g = String(goal || "").toLowerCase();
  // 注意：status/check 不能单独匹配，因为它们可能出现在 CRUD 字段名中（如 {title,status}）
  // 只匹配明确指向健康检查的语境
  return /简单|simple|basic|^health$|健康|hello|ping|存活|探活|连通/i.test(g)
    || /\b(health[- ]?check|status[- ]?check|readiness|liveness)\b/i.test(g);
}

/**
 * 检测用户目标中提到的语言/框架偏好
 * 返回 { language, framework, templateId }
 */
function detectTargetStack(userGoal: string, contractTitle: string): { language: string; framework: string; templateId: string; frontend?: "Vue" | "React" | "Svelte" } {
  const text = String(userGoal + " " + (contractTitle || "")).toLowerCase();
  // 检测混合项目（前端 + 后端）
  const hasVue = /vue|前端页面|前端界面/.test(text);
  const hasReact = /react/.test(text);
  const frontend = hasVue ? "Vue" : hasReact ? "React" : undefined;

  if (/python|flask|fastapi|django/.test(text)) {
    const framework = /fastapi/.test(text) ? "FastAPI" : /flask/.test(text) ? "Flask" : /django/.test(text) ? "Django" : "FastAPI";
    return { language: "Python", framework: `${framework} ^0.104`, templateId: "fastapi-python", frontend };
  }
  if (/rust|axum|actix|cargo/.test(text)) {
    return { language: "Rust", framework: "Axum ^0.7", templateId: "axum-rust", frontend };
  }
  if (/java|spring|gradle|maven/.test(text)) {
    return { language: "Java", framework: "Spring Boot ^3.0", templateId: "spring-java", frontend };
  }
  if (/go|gin|fiber/.test(text)) {
    return { language: "Go", framework: "Gin ^1.9", templateId: "gin-go", frontend };
  }
  // 默认 Express + TypeScript
  return { language: "TypeScript", framework: "Express.js ^5.0", templateId: "express-typescript" };
}

/**
 * 从 contract 的 requirements 中提取用户真正需要的端点
 * 奥卡姆剃刀：只生成需求中明确提到的，不加任何额外功能
 */
function inferMinimalApiEndpoints(contract: any, singular: string, plural: string): Array<{ path: string; method: string; description: string }> {
  const reqText = (contract?.requirements || []).join(" ").toLowerCase();
  const endpoints: Array<{ path: string; method: string; description: string }> = [];

  // 健康检查类
  if (/健康|health|存活|live|readiness|ready|ping|状态|status/i.test(reqText)) {
    endpoints.push({ path: "/api/health", method: "GET", description: "健康检查" });
  }

  // CRUD 类
  const wantsList = /列表|list|查询|getAll|findAll|获取.*全部|检索/i.test(reqText);
  const wantsDetail = /详情|detail|getOne|findById|获取.*单个/i.test(reqText);
  const wantsCreate = /新增|创建|create|add|post/i.test(reqText);
  const wantsUpdate = /修改|更新|update|edit|put/i.test(reqText);
  const wantsDelete = /删除|delete|remove/i.test(reqText);

  if (wantsList) endpoints.push({ path: `/api/${plural}`, method: "GET", description: `${singular}列表` });
  if (wantsCreate) endpoints.push({ path: `/api/${plural}`, method: "POST", description: `创建${singular}` });
  if (wantsDetail) endpoints.push({ path: `/api/${plural}/:id`, method: "GET", description: `${singular}详情` });
  if (wantsUpdate) endpoints.push({ path: `/api/${plural}/:id`, method: "PUT", description: `更新${singular}` });
  if (wantsDelete) endpoints.push({ path: `/api/${plural}/:id`, method: "DELETE", description: `删除${singular}` });

  // 如果没有匹配到任何端点，兜底只加健康检查
  if (endpoints.length === 0) {
    endpoints.push({ path: "/api/health", method: "GET", description: "健康检查" });
  }

  return endpoints;
}

async function buildDeterministicArchitectOutput(state: JimClawState) {
  const requirementProtocol = state.requirementProtocol || buildRequirementProtocol(state.contract);
  const { singular, plural } = getPrimaryEntity(requirementProtocol);
  const detectedPort = Number(await FindFreePortSkill.config.run({ start_port: 4000, end_port: 4999 })) || 4000;
  const goal = String(state.userGoal || "");
  const isSimple = isSimpleApiGoal(goal);

  // 检测目标语言/框架
  const targetStack = detectTargetStack(goal, state.contract?.title || "");
  const isPython = targetStack.language === "Python";
  const isGo = targetStack.language === "Go";
  const isJava = targetStack.language === "Java";
  const isRust = targetStack.language === "Rust";

  // ── Python / FastAPI 路径 ──
  if (isPython) {
    return buildDeterministicPythonOutput(state, requirementProtocol, singular, plural, detectedPort, targetStack, isSimple);
  }

  // ── Go / Gin 路径 ──
  if (isGo) {
    return buildDeterministicGoOutput(state, requirementProtocol, singular, plural, detectedPort, targetStack, isSimple);
  }

  // ── Java / Spring Boot 路径 ──
  if (isJava) {
    return buildDeterministicJavaOutput(state, requirementProtocol, singular, plural, detectedPort, targetStack, isSimple);
  }

  // ── Rust / Axum 路径 ──
  if (isRust) {
    return buildDeterministicRustOutput(state, requirementProtocol, singular, plural, detectedPort, targetStack, isSimple);
  }

  // ── Express / TypeScript 路径（原有逻辑） ──
  let filesToCreate: string[];
  let architecture: string;

  if (isSimple) {
    // 简单目标：最小文件集（入口 + 测试 + 部署）
    filesToCreate = [
      "package.json",
      "tsconfig.json",
      "jest.config.cjs",
      "src/index.ts",
      "tests/health.test.ts",
      "Dockerfile",
      "docker-compose.yml",
    ];
    architecture = `确定性降级骨架：基于 Express + TypeScript 的最小 API 服务，仅包含用户要求的核心端点。`;
  } else {
    // 标准目标：精简分层（奥卡姆剃刀——确定性降级不应生成过多文件）
    filesToCreate = [
      "package.json",
      "tsconfig.json",
      "jest.config.cjs",
      "src/index.ts",
      `src/routes/${plural}.ts`,
      `src/services/${singular}Service.ts`,
      `src/models/${singular}.ts`,
      `tests/${plural}.test.ts`,
      "Dockerfile",
      "docker-compose.yml",
    ];
    if (requirementProtocol?.capabilities?.authRequired) filesToCreate.push("src/middleware/auth.ts");
    architecture = `确定性降级骨架：基于 Express + TypeScript 的单体应用，围绕 ${singular} 资源提供 API 与部署入口。`;
  }

  const spec = stabilizeSpecForExecution(normalizeNodeDependencyLayout({
    architecture,
    language: "TypeScript",
    framework: "Express.js ^5.0",
    testCommand: "npm test",
    runCommand: "npm start",
    entryPoint: "src/index.ts",
    authScaffoldMode: "compact",
    filesToCreate,
    interfaces: "REST API",
    dependencies: {
      express: "^5.0.0",
      cors: "^2.8.5",
      ...(requirementProtocol?.capabilities?.authRequired ? { jsonwebtoken: "^9.0.2" } : {}),
    },
    devDependencies: {
      typescript: "^5.0.0",
      "ts-node": "^10.9.2",
      jest: "^29.7.0",
      "ts-jest": "^29.1.1",
      "@types/jest": "^29.5.12",
      "@types/node": "^20.11.30",
      supertest: "^7.0.0",
      "@types/supertest": "^6.0.3",
    },
  }), requirementProtocol);

  const manifest = {
    services: [{ name: "api", port: detectedPort, description: "主应用服务" }],
    environment: {},
    sharedConfig: {},
  };

  // 奥卡姆剃刀：API 端点只包含需求中明确提到的
  const endpoints = inferMinimalApiEndpoints(state.contract, singular, plural);
  if (requirementProtocol?.capabilities?.authRequired) {
    endpoints.push({ path: "/api/auth/login", method: "POST", description: "用户登录" });
  }
  const apiContract = ensureRequirementDrivenApiContract({ endpoints }, requirementProtocol);

  const endpointsSummary = endpoints.map((e: any) => `${e.method} ${e.path}`).join(", ");
  const readme = `# ${state.contract?.title || "项目"}\n\n## 说明\n本次使用确定性降级骨架生成最小可执行方案，以便在模型暂不可用时继续推进流程。\n\n## 技术栈\n- TypeScript\n- Express\n- Jest\n- Docker\n\n## 启动\n- 安装依赖：\`npm install\`\n- 运行测试：\`npm test\`\n- 启动服务：\`npm start\`\n\n## 接口\n${endpoints.map((e: any) => `- \`${e.method} ${e.path}\`：${e.description}`).join("\n")}\n`;

  return { requirementProtocol, spec, manifest, apiContract, readme };
}

/**
 * 确定性降级 — Python / FastAPI 路径
 */
function buildDeterministicPythonOutput(
  state: JimClawState,
  requirementProtocol: any,
  singular: string,
  plural: string,
  port: number,
  targetStack: { language: string; framework: string; templateId: string; frontend?: string },
  isSimple: boolean
) {
  const fwName = /flask/i.test(targetStack.framework) ? "Flask" : /django/i.test(targetStack.framework) ? "Django" : "FastAPI";
  const hasAuth = requirementProtocol.capabilities?.authRequired;

  let filesToCreate: string[];
  let architecture: string;

  if (isSimple) {
    filesToCreate = [
      "requirements.txt",
      "app/__init__.py",
      "app/main.py",
      "Dockerfile",
      "pytest.ini",
      "conftest.py",
      "tests/__init__.py",
      "tests/test_health.py",
    ];
    architecture = `确定性降级骨架：基于 Python ${fwName} 的最小 API 服务。`;
  } else {
    filesToCreate = [
      "requirements.txt",
      "app/__init__.py",
      "app/main.py",
      "app/routers/__init__.py",
      `app/routers/${plural}.py`,
      "Dockerfile",
      "pytest.ini",
      "conftest.py",
      "tests/__init__.py",
      `tests/test_${plural}.py`,
    ];
    if (hasAuth) {
      filesToCreate.push("app/routers/auth.py");
    }
    architecture = `确定性降级骨架：基于 Python ${fwName} 的单体应用，围绕 ${singular} 资源提供 API 与部署入口。`;
  }

  // 混合项目：追加前端文件
  const frontendFiles_py = buildFrontendFiles(targetStack, singular, plural);
  if (frontendFiles_py) filesToCreate.push(...frontendFiles_py);

  const spec = {
    architecture,
    language: "Python",
    framework: targetStack.framework,
    testCommand: "pytest -v",
    runCommand: `uvicorn app.main:app --host 0.0.0.0 --port ${port}`,
    entryPoint: "app/main.py",
    authScaffoldMode: "compact",
    filesToCreate,
    interfaces: "REST API",
    dependencies: {
      fastapi: ">=0.104.0",
      "uvicorn[standard]": ">=0.24.0",
      pydantic: ">=2.0.0",
      pytest: ">=7.4.0",
      httpx: ">=0.25.0",
    },
    devDependencies: {},
    frontend: buildFrontendSpec(targetStack),
    // 确定性 requirements.txt 内容——裸包名，无版本约束
    // pip 会自动安装最新兼容版本，避免约束冲突和下载慢
    _pinnedRequirements: [
      "fastapi",
      "uvicorn[standard]",
      "pydantic",
      "pytest",
      "httpx",
    ].join("\n"),
  };

  const manifest = {
    services: [{ name: "api", port, description: "主应用服务" }],
    environment: {},
    sharedConfig: {},
  };

  // 混合项目：追加前端文件
  const frontendFiles_go = buildFrontendFiles(targetStack, singular, plural);
  if (frontendFiles_go) filesToCreate.push(...frontendFiles_go);

  const endpoints = inferMinimalApiEndpoints(state.contract, singular, plural);
  if (hasAuth) {
    endpoints.push({ path: "/api/auth/register", method: "POST", description: "用户注册" });
    endpoints.push({ path: "/api/auth/login", method: "POST", description: "用户登录" });
    endpoints.push({ path: "/api/auth/me", method: "GET", description: "当前用户" });
  }
  const apiContract = ensureRequirementDrivenApiContract({ endpoints }, requirementProtocol);

  const readme = `# ${state.contract?.title || "项目"}\n\n## 说明\n本次使用确定性降级骨架生成最小可执行方案（Python ${fwName}）。\n\n## 启动\n- 安装依赖：\\\`pip install -r requirements.txt\\\`\n- 运行测试：\\\`pytest\\\`\n- 启动服务：\\\`uvicorn app.main:app --port ${port}\\\`\n`;

  // Python 确定性骨架不处理前端/认证/审计，强制关闭
  requirementProtocol = {
    ...requirementProtocol,
    capabilities: {
      ...(requirementProtocol?.capabilities || {}),
      frontendRequired: false,
      authRequired: false,
      auditLogRequired: false,
    },
  };

  return {
    requirementProtocol,
    spec: stabilizeSpecForExecution(spec, requirementProtocol),
    manifest,
    apiContract,
    readme,
  };
}

function buildDeterministicGoOutput(
  state: JimClawState,
  requirementProtocol: any,
  singular: string,
  plural: string,
  port: number,
  targetStack: { language: string; framework: string; templateId: string; frontend?: string },
  isSimple: boolean
) {
  const hasAuth = requirementProtocol.capabilities?.authRequired;

  let filesToCreate: string[];
  let architecture: string;

  if (isSimple) {
    filesToCreate = [
      "go.mod",
      "main.go",
      "handler/health.go",
      "Dockerfile",
      "handler/health_test.go",
    ];
    architecture = "确定性降级骨架：基于 Go Gin 的最小 API 服务。";
  } else {
    filesToCreate = [
      "go.mod",
      "main.go",
      `handler/${plural}.go`,
      "handler/health.go",
      "Dockerfile",
      `handler/${plural}_test.go`,
      "handler/health_test.go",
    ];
    if (hasAuth) {
      filesToCreate.push("handler/auth.go");
    }
    architecture = `确定性降级骨架：基于 Go Gin 的单体应用，围绕 ${singular} 资源提供 API 与部署入口。`;
  }

  const spec = {
    architecture,
    language: "Go",
    framework: "Gin ^1.9",
    testCommand: "go test ./... -v",
    runCommand: `go run main.go`,
    entryPoint: "main.go",
    authScaffoldMode: "compact",
    filesToCreate,
    interfaces: "REST API",
    dependencies: {},
    devDependencies: {},
    frontend: buildFrontendSpec(targetStack),
    _goModule: "jimclaw-app",
    _goGinVersion: "v1.9.1",
  };

  const manifest = {
    services: [{ name: "api", port, description: "主应用服务" }],
    environment: {},
    sharedConfig: {},
  };

  const endpoints = inferMinimalApiEndpoints(state.contract, singular, plural);
  if (hasAuth) {
    endpoints.push({ path: "/api/auth/register", method: "POST", description: "用户注册" });
    endpoints.push({ path: "/api/auth/login", method: "POST", description: "用户登录" });
  }
  const apiContract = ensureRequirementDrivenApiContract({ endpoints }, requirementProtocol);

  const readme = `# ${state.contract?.title || "项目"}\n\n## 说明\n本次使用确定性降级骨架生成最小可执行方案（Go Gin）。\n\n## 启动\n- 安装依赖：\`go mod tidy\`\n- 运行测试：\`go test ./... -v\`\n- 启动服务：\`go run main.go\`\n`;

  // Go 确定性骨架强制关闭不需要的能力
  requirementProtocol = {
    ...requirementProtocol,
    capabilities: {
      ...(requirementProtocol?.capabilities || {}),
      frontendRequired: false,
      authRequired: false,
      auditLogRequired: false,
    },
  };

  return {
    requirementProtocol,
    spec: stabilizeSpecForExecution(spec, requirementProtocol),
    manifest,
    apiContract,
    readme,
  };
}

// ── Java / Spring Boot 确定性输出 ──
// ── 混合项目：前端文件注入 ──
function buildFrontendFiles(
  targetStack: { language: string; framework: string; templateId: string; frontend?: string },
  singular?: string,
  plural?: string
): string[] | null {
  if (!targetStack.frontend) return null;
  const fw = targetStack.frontend.toLowerCase();
  if (fw === "vue") {
    const files = [
      "frontend/package.json",
      "frontend/vite.config.ts",
      "frontend/tsconfig.json",
      "frontend/tsconfig.node.json",
      "frontend/vitest.config.ts",
      "frontend/index.html",
      "frontend/src/main.ts",
      "frontend/src/App.vue",
      "frontend/src/env.d.ts",
      "frontend/src/components/HealthCheck.vue",
      "frontend/tests/HealthCheck.test.ts",
    ];
    // CRUD 实体组件
    if (singular && plural) {
      const pascal = singular.charAt(0).toUpperCase() + singular.slice(1);
      files.push(
        `frontend/src/components/${pascal}List.vue`,
        `frontend/src/api/${plural}.ts`,
        `frontend/tests/${pascal}List.test.ts`,
      );
    }
    return files;
  }
  return null;
}

function buildFrontendSpec(targetStack: { language: string; framework: string; templateId: string; frontend?: string }): any | undefined {
  if (!targetStack.frontend) return undefined;
  const fw = targetStack.frontend;
  if (fw === "Vue") {
    return {
      language: "TypeScript",
      framework: "Vue",
      buildCommand: "cd frontend && npm run build",
      testCommand: "cd frontend && npx vitest run",
      outputDir: "frontend/dist",
      sourceDir: "frontend",
    };
  }
  return undefined;
}

function buildDeterministicJavaOutput(
  state: JimClawState,
  requirementProtocol: any,
  singular: string,
  plural: string,
  port: number,
  targetStack: { language: string; framework: string; templateId: string; frontend?: string },
  isSimple: boolean
): any {
  const pkgPath = "src/main/java/com/example/app";
  const testPkgPath = "src/test/java/com/example/app";
  const pascalSingular = singular.charAt(0).toUpperCase() + singular.slice(1);
  const pascalPlural = plural.charAt(0).toUpperCase() + plural.slice(1);

  let filesToCreate: string[];
  let architecture: string;

  if (isSimple) {
    filesToCreate = [
      "pom.xml",
      "src/main/resources/application.properties",
      `${pkgPath}/Application.java`,
      `${pkgPath}/HealthController.java`,
      `${testPkgPath}/HealthControllerTest.java`,
      "Dockerfile",
    ];
    architecture = `Spring Boot 3 + Maven 确定性骨架：最小健康检查 API 服务`;
  } else {
    filesToCreate = [
      "pom.xml",
      "src/main/resources/application.properties",
      `${pkgPath}/Application.java`,
      `${pkgPath}/HealthController.java`,
      `${pkgPath}/${pascalPlural}Controller.java`,
      `${testPkgPath}/HealthControllerTest.java`,
      `${testPkgPath}/${pascalPlural}ControllerTest.java`,
      "Dockerfile",
    ];
    architecture = `Spring Boot 3 + Maven 确定性骨架：${singular} CRUD API 服务，内存存储`;
  }

  const endpoints = inferMinimalApiEndpoints(state.contract, singular, plural);
  const apiContract = ensureRequirementDrivenApiContract({ endpoints }, requirementProtocol);

  // 混合项目：追加前端文件
  const frontendFiles = buildFrontendFiles(targetStack, singular, plural);
  if (frontendFiles) filesToCreate.push(...frontendFiles);

  const spec = {
    language: targetStack.language,
    framework: targetStack.framework,
    architecture,
    interfaces: "REST API",
    testCommand: "mvn test -B",
    runCommand: "mvn spring-boot:run",
    entryPoint: `${pkgPath}/Application.java`,
    filesToCreate,
    dependencies: {},
    devDependencies: {},
    frontend: buildFrontendSpec(targetStack),
  };
  const manifest = {
    services: [{ name: "java-api", port }],
    environment: { PORT: String(port) },
  };
  const readme = `# ${state.contract?.title || "Java API"}\n\nSpring Boot 3 确定性骨架项目。\n\n## 运行\n\n\\\`\\\`\\\`bash\nmvn spring-boot:run\n\\\`\\\`\\\`\n\n## 测试\n\n\\\`\\\`\\\`bash\nmvn test\n\\\`\\\`\\\`\n`;

  return {
    spec: stabilizeSpecForExecution(spec, requirementProtocol),
    manifest,
    apiContract,
    readme,
  };
}

// ── Rust / Axum 确定性输出 ──
function buildDeterministicRustOutput(
  state: JimClawState,
  requirementProtocol: any,
  singular: string,
  plural: string,
  port: number,
  targetStack: { language: string; framework: string; templateId: string; frontend?: string },
  isSimple: boolean
): any {
  const snakeSingular = singular.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
  const snakePlural = plural.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");

  let filesToCreate: string[];
  let architecture: string;

  if (isSimple) {
    filesToCreate = [
      "Cargo.toml",
      "src/main.rs",
      "src/handlers/mod.rs",
      "src/handlers/health.rs",
      "tests/health_test.rs",
      "Dockerfile",
    ];
    architecture = `Rust + Axum 确定性骨架：最小健康检查 API 服务`;
  } else {
    filesToCreate = [
      "Cargo.toml",
      "src/main.rs",
      "src/handlers/mod.rs",
      "src/handlers/health.rs",
      `src/handlers/${snakePlural}.rs`,
      "tests/health_test.rs",
      `tests/${snakePlural}_test.rs`,
      "Dockerfile",
    ];
    architecture = `Rust + Axum 确定性骨架：${singular} CRUD API 服务，内存存储`;
  }

  const endpoints = inferMinimalApiEndpoints(state.contract, singular, plural);
  const apiContract = ensureRequirementDrivenApiContract({ endpoints }, requirementProtocol);
  const spec = {
    language: targetStack.language,
    framework: targetStack.framework,
    architecture,
    interfaces: "REST API",
    testCommand: "cargo test -- --nocapture",
    runCommand: "cargo run",
    entryPoint: "src/main.rs",
    filesToCreate,
    dependencies: {},
    devDependencies: {},
    frontend: buildFrontendSpec(targetStack),
  };
  const manifest = {
    services: [{ name: "rust-api", port }],
    environment: { PORT: String(port) },
  };
  const readme = `# ${state.contract?.title || "Rust API"}\n\nAxum 确定性骨架项目。\n\n## 运行\n\n\`\`\`bash\ncargo run\n\`\`\`\n\n## 测试\n\n\`\`\`bash\ncargo test\n\`\`\`\n`;

  return {
    spec: stabilizeSpecForExecution(spec, requirementProtocol),
    manifest,
    apiContract,
    readme,
  };
}

function normalizeNodeDependencyLayout(spec: any): any {
  const language = String(spec?.language || "").toLowerCase();
  if (!/typescript|javascript|node/.test(language)) return spec;

  const dependencies = { ...(spec?.dependencies || {}) } as Record<string, string>;
  const devDependencies = { ...(spec?.devDependencies || {}) } as Record<string, string>;

  for (const pkg of Object.keys(dependencies)) {
    if (pkg.startsWith("@types/")) {
      devDependencies[pkg] = dependencies[pkg];
      delete dependencies[pkg];
    }
  }

  if ("@types/mongoose" in devDependencies) {
    delete devDependencies["@types/mongoose"];
  }

  return {
    ...spec,
    dependencies,
    devDependencies,
  };
}

export async function architectNode(
  state: JimClawState,
  agents: { architect: BaseAgent },
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("architect");
  console.log(`${logPrefix(agents.architect.getPersona().name)} 正在制定技术规范...`);
  emit("phase-change", "System", "design");
  emit("thinking", agents.architect.getPersona().name, "正在制定技术规范...");

  // ── 动态语言/框架检测 ──
  const targetStackHint = detectTargetStack(String(state.userGoal || ""), state.contract?.title || "");
  const isHintPython = targetStackHint.language === "Python";
  const isHintGo = targetStackHint.language === "Go";
  const isHintJava = targetStackHint.language === "Java";
  const isHintRust = targetStackHint.language === "Rust";

  let requirementProtocol = state.requirementProtocol || buildRequirementProtocol(state.contract);
  let spec: any;
  let manifest: any;
  let apiContract: any;
  let readmeContent = "";
  let designSource: PlanningSource = "model";
  let savedModifyFiles: string[] = [];  // 增量修改模式：需要重写的文件列表

  // ── 增量修改模式：复用上次 spec，LLM 决定新增文件 ──
  if (state.previousSpec && state.existingFiles) {
    emit("thinking", "System", `增量修改模式：复用上次技术规范，保留 ${Object.keys(state.existingFiles).length} 个已有文件`, {});
    const prevSpec = state.previousSpec as any;
    const prevManifest = (state as any).previousManifest || null;
    const prevApiContract = (state as any).previousApiContract || null;
    const existingFileSet = new Set(Object.keys(state.existingFiles));
    const newRequirementProtocol = buildRequirementProtocol(state.contract);
    const { singular: newSingular, plural: newPlural } = getPrimaryEntity(newRequirementProtocol);
    const targetStack = detectTargetStack(String(state.userGoal || ""), state.contract?.title || "");

    // 让 LLM 决定需要新增/修改哪些文件
    const existingFileList = Array.from(existingFileSet).sort().join(", ");
    const prevFilesToCreate = (prevSpec.filesToCreate || []).join(", ");
    const goal = String(state.userGoal || "");

    let newFiles: string[] = [...(prevSpec.filesToCreate || [])];

    try {
      const response = await agents.architect.chat([
        { role: "user", content: `## 增量修改 — 需要新增/修改哪些文件？

### 用户修改需求
${goal}

### 现有项目
语言: ${prevSpec.language}
框架: ${prevSpec.framework}
端口: ${prevSpec.entryPoint}

### 已有文件
${existingFileList}

### 原始 filesToCreate
${prevFilesToCreate}

请分析用户需求，列出需要**新增或修改**的文件路径。
已有文件保持不变，只列出需要新增或内容需要修改的文件。

严格按照以下 JSON 格式输出（不要其他内容）：
{
  "newFiles": ["path/to/NewFile.java"],
  "modifiedFiles": ["path/to/ExistingFile.java"],
  "description": "简要说明修改内容"
}` }
      ], (ev) => emit(ev.type, ev.sender, ev.type === 'llm_call_start' ? "正在分析修改范围" : "分析完成", ev), {
        brief: buildSystemContext(state),
        workspaceDir: WORKSPACE,
        timeoutMs: 45000,
      });

      const content = extractText(response.content);
      const plan = parseJsonFromResponse(content, {});
      if (plan.newFiles && Array.isArray(plan.newFiles)) {
        for (const f of plan.newFiles) {
          if (!existingFileSet.has(f)) newFiles.push(f);
        }
      }
      const modifyFilesToOverwrite: string[] = [];
      if (plan.modifiedFiles && Array.isArray(plan.modifiedFiles)) {
        for (const f of plan.modifiedFiles) {
          if (existingFileSet.has(f)) {
            modifyFilesToOverwrite.push(f);
          }
        }
      }
      // 存入返回值，让 Orchestrator 和 Coder 识别
      if (modifyFilesToOverwrite.length > 0) {
        savedModifyFiles = modifyFilesToOverwrite;
      }
      const modCount = modifyFilesToOverwrite.length;
      emit("thinking", "System", `[Architect] LLM 修改计划：${plan.description || ""} | 新增 ${plan.newFiles?.length || 0} 个文件，重写 ${modCount} 个文件`, {});
    } catch (e: any) {
      emit("thinking", "System", `[Architect] 修改模式 LLM 调用失败，使用保守策略: ${e.message}`, {});
    }

    // 去重
    newFiles = [...new Set(newFiles)];

    spec = { ...prevSpec, filesToCreate: newFiles };
    manifest = prevManifest || { services: [{ name: "app", port: 4000 }] };
    apiContract = prevApiContract || { endpoints: [] };
    readmeContent = "";
    designSource = "modify-incremental";

    const newCount = newFiles.filter((f: string) => !existingFileSet.has(f)).length;
    console.log(`[Architect] 增量修改：保留 ${existingFileSet.size} 个文件，新增 ${newCount} 个`);
  } else
  // ── 非 TypeScript 快速通道：直接走确定性路径，不调 LLM ──
  // LLM 倾向于输出 TypeScript（因训练数据偏移），强制用确定性骨架更可靠
  if (isHintPython || isHintGo || isHintJava || isHintRust) {
    emit("thinking", "System", `检测到 ${targetStackHint.language} 目标，使用确定性骨架（跳过 LLM）`, {});
    const fallback = await buildDeterministicArchitectOutput(state);
    requirementProtocol = fallback.requirementProtocol;
    spec = fallback.spec;
    manifest = fallback.manifest;
    apiContract = fallback.apiContract;
    readmeContent = fallback.readme;
    designSource = "deterministic-fallback";
  } else {
    // ── TypeScript 默认路径：调 LLM ──
    const langExample = {
      lang: "TypeScript", fw: "Express.js ^4.18", testCmd: "npm test", runCmd: "npm start",
      entry: "src/index.ts", files: ["package.json", "tsconfig.json", "src/index.ts"],
      deps: { express: "^4.18" }, devDeps: { jest: "^29", tsj: "^1" },
    };

    const langFileConstraints = `   - 服务层：每个业务资源最多 1 个 service 文件（如 auth → authService.ts，不要拆成 credential/session/policy 三个）
   - 不要生成 scripts/verify.ts（测试用 jest，不用单独验证脚本）
   - 不要生成 .env.example（运行时不需要）
   - 不要生成 README.md（由系统自动生成）
   - 模型层：最多 1 个 model 文件（如 user.ts）
   - 测试文件：最多 2 个（一个主要业务测试 + 一个健康检查测试）
   - 不要生成用户未明确要求的资源对应文件
   - 文件总数上限：12 个`;

    const architectPrompt = `基于此任务契约：${JSON.stringify(state.contract)}，设计技术方案。

要求：
1. 先调用 find_free_port，为服务选择真实空闲端口。
2. 方案只覆盖用户明确要求的需求，不要添加认证、权限、审计、前端等用户未提及的功能。
3. 明确主框架、核心 dependencies、devDependencies、测试命令、运行命令、入口文件。
4. **filesToCreate 奥卡姆剃刀硬约束（必须严格遵守）：**
${langFileConstraints}
5. 需要同时输出 spec、manifest、apiContract 三部分。

严格按以下 JSON 输出：
{
  "spec": {
    "architecture": "...",
    "language": "TypeScript",
    "framework": "Express.js ^4.18",
    "testCommand": "npm test",
    "runCommand": "npm start",
    "entryPoint": "src/index.ts",
    "filesToCreate": ${JSON.stringify(langExample.files)},
    "interfaces": "...",
    "dependencies": ${JSON.stringify(langExample.deps)},
    "devDependencies": ${JSON.stringify(langExample.devDeps)}
  },
  "manifest": {
    "services": [{ "name": "api", "port": PORT, "description": "..." }],
    "environment": {},
    "sharedConfig": {}
  },
  "apiContract": {
    "endpoints": [{ "path": "/api/health", "method": "GET", "description": "健康检查" }]
  }
}`;

    try {
      const response = await agents.architect.chat(
        [{ role: "user", content: architectPrompt }],
        (ev) => emit(ev.type, ev.sender, ev.type === "llm_call_start" ? "正在制定技术规范" : ev.type === "tool_use" ? ev.content : "技术规范已完成", ev),
        {
          brief: buildSystemContext(state),
          workspaceDir: WORKSPACE,
          timeoutMs: ARCHITECT_MODEL_TIMEOUT_MS,
        }
      );

      const output = parseJsonFromResponse(extractText(response.content), {});
      const rawSpec = output.spec || {
        architecture: "未知",
        language: "TypeScript",
        framework: "Express.js ^4.18",
        testCommand: "npm test",
        runCommand: "npm start",
        entryPoint: "src/index.ts",
        filesToCreate: [],
        interfaces: "",
        dependencies: {},
        devDependencies: {},
      };

      spec = stabilizeSpecForExecution(normalizeNodeDependencyLayout(rawSpec), requirementProtocol);
      manifest = output.manifest || { services: [], environment: {}, sharedConfig: {} };
      apiContract = ensureRequirementDrivenApiContract(output.apiContract || { endpoints: [] }, requirementProtocol);
  } catch (error: any) {
    if (!isRecoverableAgentError(error)) throw error;
    designSource = "deterministic-fallback";
    emit("thinking", "System", `架构师模型暂不可用，改用确定性技术骨架继续执行：${error.message || error}`, {});
    const fallback = await buildDeterministicArchitectOutput(state);
    requirementProtocol = fallback.requirementProtocol;
    spec = fallback.spec;
    manifest = fallback.manifest;
    apiContract = fallback.apiContract;
    readmeContent = fallback.readme;
  }
  } // end of else (TypeScript LLM path)

  // ── 奥卡姆剃刀：根据 apiContract 裁剪多余的业务文件 ──
  // 原理：apiContract.endpoints 是需求唯一真相源，不在端点里的资源无需路由/控制器/服务/模型
  const apiEndpoints = apiContract?.endpoints || [];
  const apiResourceNames = new Set<string>();
  for (const ep of apiEndpoints) {
    const parts = String(ep.path || "").split("/").filter(Boolean); // e.g. ["api", "health"] or ["api", "items"]
    if (parts.length >= 2) {
      apiResourceNames.add(parts[1].toLowerCase()); // "health", "items", "auth" etc.
    }
    if (parts.length >= 3 && !parts[2].startsWith(":")) {
      apiResourceNames.add(parts[2].toLowerCase()); // sub-resources
    }
  }
  // "health" 是基础设施端点，不算业务资源
  apiResourceNames.delete("health");
  apiResourceNames.delete("live");
  apiResourceNames.delete("ready");

  const infraPatterns = [
    // Node/TS 基础设施
    /^(package|tsconfig|jest\.config|\.env|Dockerfile|docker-compose|README|\.gitignore|\.eslintrc)/i,
    /^src\/index\./,
    /^src\/config\//,
    /^src\/middleware\/error/i,
    /^src\/utils\//,
    /^src\/app\./,
    /^tests?\/(setup|health|base)/i,
    /^tests?\/test_health\.py$/i,
    /^tests?\/__init__\.py$/i,
    /^conftest\.py$/i,
    // Python 基础设施
    /^(requirements|setup|pyproject)\.(txt|cfg|toml)/i,
    /^(pytest\.ini|conftest\.py|\.flake8|tox\.ini|setup\.py)/i,
    /^app\/(?:__init__|main)\.py$/,
    /^app\/routers\/__init__\.py$/,
    // Go 基础设施
    /^(go\.(mod|sum)|Makefile)$/i,
    /^main\.go$/,
    /^handler\//,
    // Go 测试文件
    /_test\.go$/,
    // Java 基础设施
    /^(pom\.xml|build\.gradle|gradle\.properties)/i,
    /^src\/main\/resources\//,
    /Controller\.java$/i,
    /Test\.java$/i,
    /Application\.java$/i,
    // Rust 基础设施
    /^Cargo\.(toml|lock)$/i,
    /^src\/main\.rs$/,
    /^src\/handlers\//,
    /_test\.rs$/,
    // 前端文件（混合项目）
    /^frontend\//,
  ];

  if (apiResourceNames.size === 0) {
    // 没有业务资源（纯 health-check 类）：只保留基础设施 + 测试文件
    const before = spec.filesToCreate.length;
    spec.filesToCreate = spec.filesToCreate.filter((f: string) =>
      infraPatterns.some(p => p.test(f))
    );
    // 确保至少有一个测试文件
    const hasTest = spec.filesToCreate.some((f: string) => /^tests?\//.test(f) || /_test\.go$/.test(f) || /test_.*\.py$/.test(f) || /Test\.java$/.test(f) || /_test\.rs$/.test(f));
    if (!hasTest) {
      const lang = String(spec?.language || "").toLowerCase();
      if (/go/.test(lang)) spec.filesToCreate.push("handler/health_test.go");
      else if (/python/.test(lang)) spec.filesToCreate.push("tests/test_health.py");
      else if (/java/.test(lang)) spec.filesToCreate.push("src/test/java/com/example/app/HealthControllerTest.java");
      else if (/rust/.test(lang)) spec.filesToCreate.push("tests/health_test.rs");
      else spec.filesToCreate.push("tests/health.test.ts");
    }
    if (before !== spec.filesToCreate.length) {
      emit("thinking", "System", `[Architect] 奥卡姆剃刀：无业务端点，${before} → ${spec.filesToCreate.length} 文件（${spec.filesToCreate.join(", ")}）`, {});
    }
  } else {
    // 有业务资源：只保留对应资源的文件 + 基础设施
    const before = spec.filesToCreate.length;
    const resourcePatterns = [...apiResourceNames].map(r => new RegExp(r, "i"));
    spec.filesToCreate = spec.filesToCreate.filter((f: string) => {
      if (infraPatterns.some(p => p.test(f))) return true;
      // 业务文件必须匹配某个 apiContract 资源名
      return resourcePatterns.some(p => p.test(f));
    });

    // ── Service 文件去重：同一资源前缀只保留主 service ──
    const serviceFiles = spec.filesToCreate.filter((f: string) => /src\/services\//.test(f));
    if (serviceFiles.length > 2) {
      // 按 service 前缀分组（如 auth*Service, user*Service）
      const prefixGroups = new Map<string, string[]>();
      for (const sf of serviceFiles) {
        const base = (sf.match(/\/([^/]+)Service/i) || [])[1] || "unknown";
        const prefix = base.replace(/(credential|session|account|policy|token|repository)+$/i, "").toLowerCase();
        if (!prefixGroups.has(prefix)) prefixGroups.set(prefix, []);
        prefixGroups.get(prefix)!.push(sf);
      }
      // 每组只保留主 service（最短名称的）
      const toRemove = new Set<string>();
      for (const [, files] of prefixGroups) {
        if (files.length > 1) {
          files.sort((a, b) => a.length - b.length);
          for (let i = 1; i < files.length; i++) toRemove.add(files[i]);
        }
      }
      if (toRemove.size > 0) {
        spec.filesToCreate = spec.filesToCreate.filter((f: string) => !toRemove.has(f));
        emit("thinking", "System", `[Architect] 奥卡姆剃刀：service 去重，移除 ${[...toRemove].join(", ")}`, {});
      }
    }

    if (before !== spec.filesToCreate.length) {
      const removed = before - spec.filesToCreate.length;
      emit("thinking", "System", `[Architect] 奥卡姆剃刀：裁剪 ${removed} 个多余文件（apiContract 资源：${[...apiResourceNames].join(", ")}）`, {});
    }
  }

  // ── 文件数限制：超过上限时裁剪到 MVP 子集，防止 Coder 超时 ──
  const MAX_FILES = 25;
  if ((spec.filesToCreate || []).length > MAX_FILES) {
    const original = spec.filesToCreate.length;
    const keepPatterns = [
      // Node/TS
      /^package\.json$/,
      /^tsconfig\.json$/,
      /^jest\.config/,
      /^\.env/,
      /^src\/index\./,
      /^src\/config\//,
      /^src\/models?\//,
      /^src\/services?\//,
      /^src\/controllers?\//,
      /^src\/routes?\//,
      /^src\/middleware\//,
      /^tests?\//,
      // Docker
      /^Dockerfile$/,
      /^docker-compose/,
      // Java
      /^pom\.xml$/,
      /^src\/main\/java\//,
      /^src\/test\/java\//,
      /^src\/main\/resources\//,
      // Go
      /^go\.mod$/,
      /^main\.go$/,
      /^handler\//,
      // Python
      /^requirements\.txt$/,
      /^app\//,
      /^pytest\.ini$/,
      // Rust
      /^Cargo\.toml$/,
      /^src\/main\.rs$/,
      /^src\/handlers\//,
      // 前端（混合项目）
      /^frontend\//,
    ];
    const kept = spec.filesToCreate.filter((f: string) => keepPatterns.some(p => p.test(f)));
    const remaining = MAX_FILES - kept.length;
    const extras = spec.filesToCreate.filter((f: string) => !keepPatterns.some(p => p.test(f)));
    spec.filesToCreate = [...kept, ...extras.slice(0, Math.max(0, remaining))];
    emit("thinking", "System", `[Architect] filesToCreate ${original} → ${spec.filesToCreate.length}（上限 ${MAX_FILES}，已裁剪到 MVP 子集）`, {});
  }

  // ── Service 依赖的 Model 文件自动补充 ──
  // 原理：确定性 scaffold 中 buildAggregateCrudServiceScaffold 会 import "../models/<entity>"。
  // 如果 filesToCreate 中有 service 但缺少对应 model，scaffold 会生成无法编译的代码。
  // 此处自动补充缺失的 model 文件。
  {
    const declaredSet = new Set((spec.filesToCreate || []).map((f: string) => f.replace(/\\/g, "/")));
    const serviceFiles = (spec.filesToCreate || []).filter((f: string) => /src\/services\/.+Service\.(ts|js)$/i.test(f.replace(/\\/g, "/")));
    const missingModels: string[] = [];
    for (const sf of serviceFiles) {
      const match = sf.replace(/\\/g, "/").match(/src\/services\/(.+?)Service\.(ts|js)$/i);
      if (!match) continue;
      // auth 系列有专用 scaffold（buildAuthServiceScaffold 等），不依赖外部 model
      if (/^auth/i.test(match[1])) continue;
      // Query/Mutation/Inventory 分割型 service 也是自包含的
      if (/(Query|Mutation|Inventory)$/i.test(match[1])) continue;
      const entityStem = singularizeStem(match[1]);
      const modelFile = `src/models/${entityStem}.ts`;
      if (!declaredSet.has(modelFile)) {
        // 检查是否有类似名称的 model 文件已存在（如 book → books.ts）
        const pluralModel = `src/models/${entityStem.endsWith("s") ? entityStem : entityStem + "s"}.ts`;
        if (!declaredSet.has(pluralModel)) {
          missingModels.push(modelFile);
        }
      }
    }
    if (missingModels.length > 0) {
      const before = spec.filesToCreate.length;
      for (const model of missingModels) {
        if (!spec.filesToCreate.includes(model)) {
          spec.filesToCreate.push(model);
        }
      }
      emit("thinking", "System", `[Architect] Service 依赖补充：添加缺失的 model 文件 ${missingModels.join(", ")}（${before} → ${spec.filesToCreate.length}）`, {});
    }
  }

  const technologyDecision = buildTechnologyDecision(requirementProtocol, spec);
  const solutionProtocol = buildSolutionProtocol(requirementProtocol, spec, apiContract);
  const executionProtocol = buildExecutionProtocol(spec, manifest, apiContract, requirementProtocol);
  const customerApprovalState = buildCustomerApprovalState({
    autoApprove: state.customerApprovalState?.autoApprove,
    summaries: {
      requirements: state.customerApprovalState?.checkpoints?.find((item) => item.stage === "requirements")?.summary || `${state.contract?.title || "项目"}需求已确认`,
      solution: `${spec.framework || spec.language || "方案"}，文件 ${spec.filesToCreate?.length || 0} 个，服务 ${manifest.services?.length || 0} 个`,
      deploy: state.customerApprovalState?.checkpoints?.find((item) => item.stage === "deploy")?.summary || "",
    },
  });

  const planningFindings = [
    ...solutionProtocol.coverage.uncoveredRequirements.map((requirement) => ({
      summary: `方案未覆盖需求：${requirement}`,
      evidence: [`未覆盖需求：${requirement}`],
    })),
    ...solutionProtocol.coverage.uncoveredAcceptanceCriteria.map((criteria) => ({
      summary: `方案未覆盖验收：${criteria}`,
      evidence: [`未覆盖验收：${criteria}`],
    })),
  ];
  if (requirementProtocol?.capabilities?.frontendRequired && !solutionProtocol.coverage.frontendPlanned) {
    planningFindings.push({
      summary: "方案未覆盖需求：用户要求前端，但方案中缺少前端页面入口",
      evidence: ["frontendRequired=true", `filesToCreate=${JSON.stringify(spec.filesToCreate || [])}`],
    });
  }
  if (requirementProtocol?.capabilities?.backendRequired && !solutionProtocol.coverage.backendPlanned) {
    planningFindings.push({
      summary: "方案未覆盖需求：用户要求后端 API，但方案中缺少后端入口或接口规划",
      evidence: ["backendRequired=true", `filesToCreate=${JSON.stringify(spec.filesToCreate || [])}`, `apiEndpoints=${JSON.stringify(apiContract.endpoints || [])}`],
    });
  }
  if (requirementProtocol?.capabilities?.authRequired && !solutionProtocol.coverage.authPlanned) {
    planningFindings.push({
      summary: "方案未覆盖需求：用户要求认证能力，但方案中缺少认证模块规划",
      evidence: ["authRequired=true"],
    });
  }
  if (requirementProtocol?.capabilities?.auditLogRequired && !solutionProtocol.coverage.auditLogPlanned) {
    planningFindings.push({
      summary: "方案未覆盖需求：用户要求日志审计，但方案中缺少日志模块规划",
      evidence: ["auditLogRequired=true"],
    });
  }
  const validationReport = buildValidationReport(planningFindings, {
    failureType: "planning_gap",
    status: planningFindings.length > 0 ? "fail" : "pass",
    blocking: planningFindings.length > 0,
  });
  const repairPlan = buildRepairPlan(validationReport);

  const specValidation = TechSpecSchema.safeParse(spec);
  if (!specValidation.success) {
    console.warn("[Architect] TechSpec 校验失败:", specValidation.error.message);
  }

  if (!readmeContent) {
    try {
      // README 生成是附加功能，用 Promise.race 实现独立超时
      // 避免通过 agent.chat 的 timeout 触发 [Critical Error] 噪音日志
      const readmePromise = agents.architect.chat(
        [{
          role: "user",
          content: `基于以下设计，生成一份中文 README.md：

项目规范：${JSON.stringify(spec, null, 2)}
API 接口：${JSON.stringify(apiContract, null, 2)}
服务配置：${JSON.stringify(manifest, null, 2)}

请包含：项目简介、快速开始、API 文档、架构说明。`,
        }],
        (ev) => emit(ev.type, ev.sender, "正在生成 README", ev),
        {
          brief: buildSystemContext(state),
          workspaceDir: WORKSPACE,
          // 不设 agent 级超时，由 Promise.race 控制
        }
      );
      const readmeResponse = await Promise.race([
        readmePromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("README timeout")), ARCHITECT_README_TIMEOUT_MS)
        ),
      ]);
      readmeContent = extractText(readmeResponse.content);
    } catch (error: any) {
      // README 生成失败不影响主流程，静默 fallback
      designSource = readmeContent ? designSource : "deterministic-fallback";
      readmeContent = `# ${state.contract?.title || "项目"}\n\n## 说明\nREADME 由确定性降级骨架生成，因为架构师 README 补充阶段超时或暂不可用。\n\n## 启动\n- npm install\n- npm test\n- npm start\n`;
      console.warn(`[Architect] README 生成超时/失败，使用确定性 fallback (${String(error?.message || error).slice(0, 80)})`);
    }
  }

  await fs.writeFile(path.join(WORKSPACE, "spec.json"), JSON.stringify(spec, null, 2));
  await fs.writeFile(path.join(WORKSPACE, "manifest.json"), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(WORKSPACE, "api_contract.json"), JSON.stringify(apiContract, null, 2));
  await fs.writeFile(path.join(WORKSPACE, "README.md"), readmeContent);

  const architectName = agents.architect.getPersona().name;
  const templateEngine = getTemplateEngine();
  await templateEngine.loadTemplates();
  const template = templateEngine.recommendTemplate(spec.language || "TypeScript", []);
  const port = manifest.services?.[0]?.port || 0;

  // 确定 templateId：优先用 template_engine 的结果，fallback 到 detectTargetStack 推断
  let effectiveTemplateId = template?.id || null;
  if (!effectiveTemplateId) {
    const stackHint = detectTargetStack(String(state.userGoal || ""), state.contract?.title || "");
    effectiveTemplateId = stackHint.templateId;
  }

  const criticalDecisions: string[] = ["单元测试文件只能测试导出的纯函数"];
  if (template) {
    criticalDecisions.push(`推荐模板: ${template.name}`);
  }
  criticalDecisions.push("需求协议/技术决策/方案协议/执行协议已建立，用户需求优先于架构收缩");

  const consensusCore: ConsensusCore = {
    projectTitle: state.consensusCore?.projectTitle || state.contract?.title || "",
    requirements: state.consensusCore?.requirements || state.contract?.requirements || [],
    architectureSummary: spec.architecture || "",
    techStack: `${spec.language}${spec.framework ? ` + ${spec.framework}` : ""}`,
    framework: spec.framework || "",
    port,
    coreDependencies: spec.dependencies || {},
    coreDevDependencies: spec.devDependencies || {},
    criticalDecisions,
  };

  const consensusProgress: ConsensusProgress = {
    completedFiles: [],
    pendingFiles: spec.filesToCreate || [],
    currentRound: 0,
    openIssues: planningFindings.map((finding) => finding.summary),
  };

  const noteId = "note-architect-r0";
  const summary = `${designSource === "model" ? "架构完成" : "架构降级完成"}：${spec.language}，${(spec.filesToCreate || []).length}个文件，端口${port}${planningFindings.length > 0 ? `，缺口${planningFindings.length}项` : ""}`;
  const fullContent = `# 架构设计纪要

## 来源
- ${designSource === "model" ? "模型生成" : "确定性降级骨架"}

## 需求协议
\`\`\`json
${JSON.stringify(requirementProtocol, null, 2)}
\`\`\`

## 技术决策
\`\`\`json
${JSON.stringify(technologyDecision, null, 2)}
\`\`\`

## 技术规范
\`\`\`json
${JSON.stringify(spec, null, 2)}
\`\`\`

## 服务清单
\`\`\`json
${JSON.stringify(manifest, null, 2)}
\`\`\`

## API 契约
\`\`\`json
${JSON.stringify(apiContract, null, 2)}
\`\`\`

## 方案协议
\`\`\`json
${JSON.stringify(solutionProtocol, null, 2)}
\`\`\`

## 执行协议
\`\`\`json
${JSON.stringify(executionProtocol, null, 2)}
\`\`\`

## 验证报告
\`\`\`json
${JSON.stringify(validationReport, null, 2)}
\`\`\`
`;
  const meetingNote = await writeMeetingNote(WORKSPACE, noteId, "architect", 0, summary, fullContent);

  emit("artifact", architectName, "技术方案已完成。", {
    requirementProtocol,
    technologyDecision,
    solutionProtocol,
    spec,
    manifest,
    apiContract,
    executionProtocol,
    validationReport,
    customerApprovalState,
  });

  const result = {
    templateId: effectiveTemplateId,
    designSource,
    spec,
    manifest,
    apiContract,
    requirementProtocol,
    technologyDecision,
    solutionProtocol,
    executionProtocol,
    validationReport,
    repairPlan,
    customerApprovalState,
    consensusCore,
    consensusProgress,
    meetingNotes: [meetingNote],
    teamChatLog: [{ sender: architectName, content: "我已经完成系统设计。" }],
    ...(savedModifyFiles.length > 0 ? { modifyFilesToOverwrite: savedModifyFiles } : {}),
  };
  await saveBoulder({ ...state, ...result }, "architect");

  // ── 覆盖缺口不阻塞：转为警告 ──
  // PM 生成的 capabilities 可能包含用户未明确要求的能力（如前端、认证、审计），
  // architect 的奥卡姆剃刀已经做了最小可行方案，不应因这些额外"需求"而崩溃
  if (validationReport.blocking && designSource === "model") {
    emit("thinking", "Architect", `[Architect] 方案覆盖缺口警告（非阻塞）：${validationReport.findings.map(f => f.summary).join("；")}`, {});
  }

  return result;
}
