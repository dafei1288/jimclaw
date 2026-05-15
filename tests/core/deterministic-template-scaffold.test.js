require("ts-node/register/transpile-only");

const test = require("node:test");
const assert = require("node:assert/strict");

const { createBaseState } = require("./test-helpers");
const { getDeterministicTemplateScaffold } = require("../../src/core/logic_utils");

function createTemplateState() {
  return createBaseState({
    templateId: "express-typescript",
    contract: { title: "图书管理系统", requirements: [], acceptanceCriteria: [] },
    manifest: { services: [{ name: "api", port: 4100 }], environment: {}, sharedConfig: {} },
    spec: {
      language: "TypeScript",
      framework: "Express.js ^5.0",
      filesToCreate: [
        "package.json",
        ".env.example",
        "src/models/book.ts",
        "src/services/bookService.ts",
        "src/services/authService.ts",
        "src/controllers/bookController.ts",
        "src/controllers/authController.ts",
        "src/middleware/auth.ts",
        "src/routes/books.ts",
      ],
      dependencies: {
        express: "^5.0.0",
        cors: "^2.8.5",
        jsonwebtoken: "^9.0.2",
      },
      devDependencies: {},
    },
    apiContract: {
      endpoints: [
        { method: "GET", path: "/api/books", description: "图书列表" },
        { method: "POST", path: "/api/books", description: "新增图书" },
        { method: "GET", path: "/api/books/:id", description: "图书详情" },
        { method: "PUT", path: "/api/books/:id", description: "更新图书" },
        { method: "DELETE", path: "/api/books/:id", description: "删除图书" },
        { method: "POST", path: "/api/auth/login", description: "登录" },
      ],
    },
    requirementProtocol: {
      capabilities: {
        authRequired: true,
      },
    },
  });
}

test("deterministic template scaffold covers common entity files for express typescript", () => {
  const state = createTemplateState();

  const modelCode = getDeterministicTemplateScaffold(state, "src/models/book.ts");
  const serviceCode = getDeterministicTemplateScaffold(state, "src/services/bookService.ts");
  const controllerCode = getDeterministicTemplateScaffold(state, "src/controllers/bookController.ts");
  const authControllerCode = getDeterministicTemplateScaffold(state, "src/controllers/authController.ts");
  const authRouteCode = getDeterministicTemplateScaffold(state, "src/routes/auth.ts");
  const envCode = getDeterministicTemplateScaffold(state, ".env.example");

  assert.match(modelCode || "", /export interface Book/);
  assert.match(modelCode || "", /createBook/);
  assert.match(serviceCode || "", /export function listBooks/);
  assert.match(serviceCode || "", /export function createBook/);
  assert.match(controllerCode || "", /export async function listBooks/);
  assert.match(controllerCode || "", /export async function createBook/);
  assert.match(authControllerCode || "", /export async function login/);
  assert.match(authControllerCode || "", /authService/);
  assert.match(authRouteCode || "", /Router/);
  assert.match(authRouteCode || "", /router\.post\(\"\/login\"/);
  assert.doesNotMatch(authRouteCode || "", /router\.post\(\"\/register\"/);
  assert.match(envCode || "", /JWT_SECRET/);
});

test("deterministic template scaffold emits .dockerignore for dockerized express typescript projects", () => {
  const state = createTemplateState();
  state.spec.filesToCreate.push("Dockerfile", "docker-compose.yml", ".dockerignore");

  const dockerignoreCode = getDeterministicTemplateScaffold(state, ".dockerignore");

  assert.match(dockerignoreCode || "", /^node_modules$/m);
  assert.match(dockerignoreCode || "", /^dist$/m);
  assert.match(dockerignoreCode || "", /^coverage$/m);
  assert.match(dockerignoreCode || "", /^workspace$/m);
  assert.match(dockerignoreCode || "", /^audit$/m);
  assert.match(dockerignoreCode || "", /^\.git$/m);
});

test("deterministic controller scaffold narrows req.params.id to string before service calls", () => {
  const state = createTemplateState();

  const controllerCode = getDeterministicTemplateScaffold(state, "src/controllers/bookController.ts");

  assert.match(controllerCode || "", /const resourceId = Array\.isArray\(req\.params\.id\) \? req\.params\.id\[0\] : req\.params\.id;/);
  assert.match(controllerCode || "", /getBookById\(resourceId\)/);
  assert.match(controllerCode || "", /updateBookRecord\(resourceId, req\.body \|\| \{\}\)/);
  assert.match(controllerCode || "", /deleteBookRecord\(resourceId\)/);
});

test("deterministic index scaffold wires logger middleware and complete health endpoints", () => {
  const state = createTemplateState();
  state.spec.filesToCreate.push("src/index.ts", "public/index.html", "src/logging/logger.ts", "tests/health.test.ts");

  const indexCode = getDeterministicTemplateScaffold(state, "src/index.ts");

  assert.match(indexCode || "", /import \{ requestLogger \} from "\.\/logging\/logger";/);
  assert.match(indexCode || "", /app\.use\(requestLogger\);/);
  assert.match(indexCode || "", /app\.get\("\/api\/health",/);
  assert.match(indexCode || "", /status: "ok"/);
  assert.match(indexCode || "", /uptime: process\.uptime\(\)/);
  assert.match(indexCode || "", /app\.get\("\/api\/health\/ping",/);
  assert.match(indexCode || "", /message: "pong"/);
});
