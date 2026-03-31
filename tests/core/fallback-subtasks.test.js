require("ts-node/register/transpile-only");

const test = require("node:test");
const assert = require("node:assert/strict");

const { generateFallbackSubTasks } = require("../../src/core/logic_utils");

test("fallback subtasks use file targets as dependencies instead of synthetic task ids", () => {
  const tasks = generateFallbackSubTasks(
    {
      language: "TypeScript",
      filesToCreate: [
        "package.json",
        "src/index.ts",
        "src/models/book.ts",
        "src/services/bookService.ts",
      ],
    },
    { endpoints: [] }
  );

  const indexTask = tasks.find((task) => task.fileTarget === "src/index.ts");
  const serviceTask = tasks.find((task) => task.fileTarget === "src/services/bookService.ts");

  assert.deepEqual(indexTask.dependencies, ["package.json"]);
  assert.deepEqual(serviceTask.dependencies, ["src/models/book.ts"]);
  assert.equal(tasks.some((task) => (task.dependencies || []).some((dependency) => /^fallback_task_/.test(dependency))), false);
});

test("fallback subtasks skip install artifacts and build outputs", () => {
  const tasks = generateFallbackSubTasks(
    {
      language: "TypeScript",
      filesToCreate: [
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        "node_modules/.cache/foo",
        "dist/index.js",
        "coverage/lcov.info",
        "src/index.ts",
      ],
    },
    { endpoints: [] }
  );

  const fileTargets = tasks.map((task) => task.fileTarget);

  assert.deepEqual(fileTargets, ["package.json", "src/index.ts"]);
});

test("fallback subtasks do not serialize unrelated docs and infra files into a deadlock chain", () => {
  const tasks = generateFallbackSubTasks(
    {
      language: "TypeScript",
      filesToCreate: [
        "package.json",
        ".env.example",
        "README.md",
        "Dockerfile",
        "docker-compose.yml",
        "src/models/book.ts",
        "src/services/bookService.ts",
        "src/controllers/bookController.ts",
        "src/middleware/auth.ts",
        "src/routes/books.ts",
        "src/index.ts",
        "tests/setup.test.ts",
      ],
    },
    { endpoints: [{ method: "GET", path: "/api/books" }] }
  );

  const byTarget = Object.fromEntries(tasks.map((task) => [task.fileTarget, task]));

  assert.deepEqual(byTarget[".env.example"].dependencies, []);
  assert.deepEqual(byTarget["README.md"].dependencies, []);
  assert.deepEqual(byTarget["Dockerfile"].dependencies, ["package.json"]);
  assert.deepEqual(byTarget["docker-compose.yml"].dependencies, ["Dockerfile"]);
  assert.deepEqual(byTarget["src/models/book.ts"].dependencies, []);
  assert.deepEqual(byTarget["src/services/bookService.ts"].dependencies, ["src/models/book.ts"]);
  assert.deepEqual(byTarget["src/controllers/bookController.ts"].dependencies, ["src/services/bookService.ts", "src/models/book.ts"]);
  assert.deepEqual(byTarget["src/routes/books.ts"].dependencies, ["src/controllers/bookController.ts", "src/middleware/auth.ts"]);
  assert.deepEqual(byTarget["src/index.ts"].dependencies, ["src/routes/books.ts", "src/middleware/auth.ts"]);
  assert.deepEqual(byTarget["tests/setup.test.ts"].dependencies, ["package.json"]);
});

test("fallback subtasks let aggregate services depend on same-domain helper services instead of unrelated models", () => {
  const tasks = generateFallbackSubTasks(
    {
      language: "TypeScript",
      filesToCreate: [
        "package.json",
        "src/errors.ts",
        "src/logging/logger.ts",
        "src/models/book.ts",
        "src/services/authSessionService.ts",
        "src/services/authCredentialService.ts",
        "src/services/authAccountPolicyService.ts",
        "src/services/authService.ts",
        "src/services/bookQueryService.ts",
        "src/services/bookMutationService.ts",
        "src/services/bookInventoryService.ts",
        "src/services/bookService.ts",
        "src/controllers/bookController.ts",
        "src/routes/books.ts",
      ],
    },
    { endpoints: [{ method: "GET", path: "/api/books" }] }
  );

  const byTarget = Object.fromEntries(tasks.map((task) => [task.fileTarget, task]));

  assert.deepEqual([...byTarget["src/services/authService.ts"].dependencies].sort(), [
    "src/services/authAccountPolicyService.ts",
    "src/services/authCredentialService.ts",
    "src/services/authSessionService.ts",
  ].sort());
  assert.deepEqual([...byTarget["src/services/bookService.ts"].dependencies].sort(), [
    "src/models/book.ts",
    "src/services/bookInventoryService.ts",
    "src/services/bookMutationService.ts",
    "src/services/bookQueryService.ts",
  ].sort());
  assert.deepEqual(byTarget["src/controllers/bookController.ts"].dependencies, [
    "src/services/bookService.ts",
    "src/models/book.ts",
  ]);
  assert.deepEqual(byTarget["src/routes/books.ts"].dependencies, ["src/controllers/bookController.ts"]);
});
