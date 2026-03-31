const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const {
  createTempWorkspace,
  removeTempWorkspace,
  createBaseState,
  createCoderAgent,
  createNoopEmit,
  createNoopStartSpan,
  createSnapshotRecorder,
} = require("./test-helpers");
const { coderNode } = require("../../src/core/nodes/coder_node");
const {
  ensureTypeScriptTestBaseline,
  normalizeNodeProjectFileLayout,
  stabilizeSpecForExecution,
  buildExecutionProtocol,
  buildRequirementProtocol,
  buildSystemContext,
} = require("../../src/core/logic_utils");
const {
  classifyPrettierFailure,
} = require("../../src/skills/lint_fix");

test("invalid code payload is recorded as failed instead of completed", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    subTasks: [
      {
        id: "task-001",
        description: "write broken controller",
        fileTarget: "src/controllers/bookController.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: createCoderAgent("```typescript\n{success, message, data}\n```"),
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks[0].status, "failed");
    assert.match(result.subTasks[0].lastError || "", /syntax|invalid|校验|代码|片段|结构/i);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("syntax blocker includes line and column details for faster repair", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    subTasks: [
      {
        id: "task-syntax",
        description: "write broken test",
        fileTarget: "tests/logController.test.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: createCoderAgent("```typescript\ndescribe('x', () => {\n  it('y', () => {\n    const value = \n  });\n});\n```"),
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks[0].status, "failed");
    assert.match(result.subTasks[0].lastError || "", /L\d+:C\d+/);
    assert.match(result.testResults || "", /L\d+:C\d+/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder repairs a transient syntax error within the same task before escalating", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    subTasks: [
      {
        id: "task-self-heal",
        description: "write recoverable test",
        fileTarget: "tests/bookService.test.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            if (chatCalls === 1) {
              return {
                content: "```typescript\ndescribe('book', () => {\n  it('works', () => {\n    const value = \n  });\n});\n```",
              };
            }
            return {
              content: "```typescript\ndescribe('book', () => {\n  it('works', () => {\n    const value = 1;\n    expect(value).toBe(1);\n  });\n});\n```",
            };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(chatCalls, 2);
    assert.equal(result.subTasks[0].status, "completed");
    assert.equal(result.blockedReason, "");
    const written = await fs.readFile(path.join(workspace, "tests/bookService.test.ts"), "utf-8");
    assert.match(written, /expect\(value\)\.toBe\(1\)/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder prioritizes reopened files ahead of ordinary pending work", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const attemptedTargets = [];
  const state = createBaseState({
    qaFailures: {
      failedFiles: ["tests/books.test.ts"],
      testErrors: ["tests/books.test.ts 需要重开修复"],
      failedTestNames: [],
    },
    fixPlan: [
      {
        fileTarget: "tests/books.test.ts",
        diagnosis: "测试文件导入错误",
        proposedChange: "修正导入并保留断言",
        qaApproval: "approved",
      },
    ],
    subTasks: [
      {
        id: "task-service",
        description: "write service",
        fileTarget: "src/services/bookService.ts",
        dependencies: [],
        contextRequirement: "service",
        status: "pending",
      },
      {
        id: "task-test",
        description: "repair books test",
        fileTarget: "tests/books.test.ts",
        dependencies: [],
        contextRequirement: "test",
        status: "completed",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat(messages) {
            const prompt = messages[0]?.content || "";
            const target = prompt.match(/请(?:实现|修复)\s+([^\n。]+)/)?.[1]?.trim() || "";
            attemptedTargets.push(target);
            if (target === "tests/books.test.ts") {
              return {
                content: "```typescript\ndescribe('books', () => {\n  it('works', () => {\n    expect(true).toBe(true);\n  });\n});\n```",
              };
            }
            return {
              content: "```typescript\nexport const bookService = { ok: true };\nexport default bookService;\n```",
            };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(attemptedTargets[0], "tests/books.test.ts");
    assert.equal(result.subTasks.find((task) => task.fileTarget === "tests/books.test.ts").status, "completed");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder regression harness is ready for snapshot consistency checks", () => {
  assert.equal(true, true);
});

test("snapshot persistence failure marks task failed instead of leaving a false success", async () => {
  const workspace = await createTempWorkspace();
  const state = createBaseState({
    subTasks: [
      {
        id: "task-002",
        description: "write valid module",
        fileTarget: "src/index.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: createCoderAgent("```typescript\nexport const value = 1;\n```"),
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      async () => {
        throw new Error("snapshot write failed");
      }
    );

    assert.equal(result.subTasks[0].status, "failed");
    assert.match(result.subTasks[0].lastError || "", /snapshot|persist|保存|写入/i);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("typescript jest projects auto-include a runnable jest baseline", () => {
  const spec = ensureTypeScriptTestBaseline({
    language: "TypeScript",
    testCommand: "npm test",
    filesToCreate: ["package.json", "tsconfig.json", "src/index.ts"],
    devDependencies: {
      typescript: "^5.0.0",
      jest: "^29.0.0",
    },
  });

  assert.equal(spec.filesToCreate.includes("jest.config.cjs"), true);
  assert.equal(spec.filesToCreate.includes("tests/setup.test.ts"), true);
  assert.equal(spec.devDependencies["ts-jest"] !== undefined, true);
  assert.equal(spec.devDependencies["@types/jest"] !== undefined, true);
});

test("node jest spec layout normalizes src/tests into tests root", () => {
  const spec = normalizeNodeProjectFileLayout(
    ensureTypeScriptTestBaseline({
      language: "TypeScript",
      testCommand: "npm test",
      filesToCreate: ["src/tests/user.test.ts", "src/index.ts"],
      devDependencies: {
        jest: "^29.0.0",
      },
    })
  );

  assert.equal(spec.filesToCreate.includes("tests/user.test.ts"), true);
  assert.equal(spec.filesToCreate.includes("src/tests/user.test.ts"), false);
});

test("coder requests staged validation after first-round core skeleton is ready", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const requirementProtocol = buildRequirementProtocol({
    title: "图书管理系统",
    requirements: ["需要前端页面和后端 API", "需要基础权限管理", "需要基础测试"],
    acceptanceCriteria: ["可以在浏览器访问首页"],
  });
  const spec = {
    language: "TypeScript",
    framework: "Express.js ^4.18",
    testCommand: "npm test",
    runCommand: "npm start",
    entryPoint: "src/index.ts",
    filesToCreate: [
      "package.json",
      "tsconfig.json",
      "jest.config.cjs",
      "src/models/book.ts",
      "src/repositories/bookRepository.ts",
      "src/services/bookService.ts",
      "src/controllers/bookController.ts",
      "src/routes/books.ts",
      "src/middleware/auth.ts",
      "src/app.ts",
      "src/index.ts",
      "public/index.html",
      "tests/books.test.ts",
      "README.md",
    ],
  };
  const executionProtocol = buildExecutionProtocol(
    spec,
    { services: [{ name: "app", port: 4000 }], environment: {}, sharedConfig: {} },
    { endpoints: [{ method: "GET", path: "/api/books" }] },
    requirementProtocol
  );
  const state = createBaseState({
    spec,
    requirementProtocol,
    executionProtocol,
    code: JSON.stringify({
      "package.json": "{\n  \"name\": \"demo\",\n  \"scripts\": {\n    \"test\": \"jest --runInBand\",\n    \"start\": \"node dist/index.js\"\n  }\n}\n",
      "tsconfig.json": "{\n  \"compilerOptions\": {\n    \"target\": \"ES2020\",\n    \"module\": \"commonjs\"\n  }\n}\n",
      "jest.config.cjs": "module.exports = { roots: ['<rootDir>/tests'], testMatch: ['**/*.test.ts'] };\n",
    }),
    subTasks: [
      { id: "task-1", description: "pkg", fileTarget: "package.json", dependencies: [], contextRequirement: "pkg", status: "completed" },
      { id: "task-2", description: "tsconfig", fileTarget: "tsconfig.json", dependencies: [], contextRequirement: "tsconfig", status: "completed" },
      { id: "task-3", description: "jest", fileTarget: "jest.config.cjs", dependencies: [], contextRequirement: "jest", status: "completed" },
      { id: "task-4", description: "model", fileTarget: "src/models/book.ts", dependencies: [], contextRequirement: "model", status: "pending" },
      { id: "task-5", description: "repo", fileTarget: "src/repositories/bookRepository.ts", dependencies: [], contextRequirement: "repo", status: "pending" },
      { id: "task-6", description: "service", fileTarget: "src/services/bookService.ts", dependencies: [], contextRequirement: "service", status: "pending" },
      { id: "task-7", description: "controller", fileTarget: "src/controllers/bookController.ts", dependencies: [], contextRequirement: "controller", status: "pending" },
      { id: "task-8", description: "route", fileTarget: "src/routes/books.ts", dependencies: [], contextRequirement: "route", status: "pending" },
      { id: "task-9", description: "auth", fileTarget: "src/middleware/auth.ts", dependencies: [], contextRequirement: "auth", status: "pending" },
      { id: "task-10", description: "app", fileTarget: "src/app.ts", dependencies: [], contextRequirement: "app", status: "pending" },
      { id: "task-11", description: "index", fileTarget: "src/index.ts", dependencies: [], contextRequirement: "index", status: "pending" },
      { id: "task-12", description: "ui", fileTarget: "public/index.html", dependencies: [], contextRequirement: "ui", status: "pending" },
      { id: "task-13", description: "test", fileTarget: "tests/books.test.ts", dependencies: [], contextRequirement: "test", status: "pending" },
      { id: "task-14", description: "readme", fileTarget: "README.md", dependencies: [], contextRequirement: "readme", status: "pending" },
    ],
  });

  const genericCoder = {
    getPersona() {
      return { name: "测试Coder" };
    },
    async chat(messages) {
      const prompt = messages[0]?.content || "";
      const targetMatch = prompt.match(/请实现\s+([^\n。]+)/);
      const target = targetMatch?.[1]?.trim() || "";
      if (target === "public/index.html") {
        return { content: "```html\n<!doctype html><html><body><div id=\"app\">books</div></body></html>\n```" };
      }
      if (target === "README.md") {
        return { content: "```md\n# demo\n```\n" };
      }
      if (target === "package.json") {
        return { content: "```json\n{\"name\":\"demo\",\"scripts\":{\"test\":\"jest --runInBand\",\"start\":\"node dist/index.js\"}}\n```" };
      }
      if (target === "tsconfig.json") {
        return { content: "```json\n{\"compilerOptions\":{\"target\":\"ES2020\",\"module\":\"commonjs\"}}\n```" };
      }
      if (target === "jest.config.cjs") {
        return { content: "```javascript\nmodule.exports = { roots: ['<rootDir>/tests'], testMatch: ['**/*.test.ts'] };\n```" };
      }
      return { content: "```typescript\nexport const value = true;\nexport default value;\n```" };
    },
  };

  try {
    await fs.mkdir(path.join(workspace), { recursive: true });
    await fs.writeFile(path.join(workspace, "package.json"), "{\n  \"name\": \"demo\",\n  \"scripts\": {\n    \"test\": \"jest --runInBand\",\n    \"start\": \"node dist/index.js\"\n  }\n}\n");
    await fs.writeFile(path.join(workspace, "tsconfig.json"), "{\n  \"compilerOptions\": {\n    \"target\": \"ES2020\",\n    \"module\": \"commonjs\"\n  }\n}\n");
    await fs.writeFile(path.join(workspace, "jest.config.cjs"), "module.exports = { roots: ['<rootDir>/tests'], testMatch: ['**/*.test.ts'] };\n");

    const result = await coderNode(
      state,
      { coder: genericCoder },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.validationCheckpointRequested, true);
    assert.equal(result.validationCheckpointCompleted, false);
    assert.equal(result.resumeAfterValidation, false);
    assert.equal(result.blockedReason, "");
    assert.equal(result.subTasks.some((task) => task.status === "pending"), true);
    assert.equal(result.subTasks.find((task) => task.fileTarget === "README.md").status, "pending");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder first round defers ui test and docs files until staged validation after backend core is ready", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const attemptedTargets = [];
  const requirementProtocol = buildRequirementProtocol({
    title: "图书管理系统",
    requirements: ["需要前端页面和后端 API", "需要基础权限管理", "需要基础测试"],
    acceptanceCriteria: ["可以在浏览器访问首页"],
  });
  const spec = {
    language: "TypeScript",
    framework: "Express.js ^4.18",
    testCommand: "npm test",
    runCommand: "npm start",
    entryPoint: "src/index.ts",
    filesToCreate: [
      "package.json",
      "tsconfig.json",
      "jest.config.cjs",
      "src/models/book.ts",
      "src/repositories/bookRepository.ts",
      "src/services/bookService.ts",
      "src/controllers/bookController.ts",
      "src/routes/books.ts",
      "src/middleware/auth.ts",
      "src/app.ts",
      "src/index.ts",
      "public/index.html",
      "tests/books.test.ts",
      "README.md",
    ],
  };
  const executionProtocol = buildExecutionProtocol(
    spec,
    { services: [{ name: "app", port: 4000 }], environment: {}, sharedConfig: {} },
    { endpoints: [{ method: "GET", path: "/api/books" }] },
    requirementProtocol
  );
  const state = createBaseState({
    spec,
    requirementProtocol,
    executionProtocol,
    code: JSON.stringify({
      "package.json": "{\n  \"name\": \"demo\",\n  \"scripts\": {\n    \"test\": \"jest --runInBand\",\n    \"start\": \"node dist/index.js\"\n  }\n}\n",
      "tsconfig.json": "{\n  \"compilerOptions\": {\n    \"target\": \"ES2020\",\n    \"module\": \"commonjs\"\n  }\n}\n",
      "jest.config.cjs": "module.exports = { roots: ['<rootDir>/tests'], testMatch: ['**/*.test.ts'] };\n",
    }),
    subTasks: [
      { id: "task-1", description: "pkg", fileTarget: "package.json", dependencies: [], contextRequirement: "pkg", status: "completed" },
      { id: "task-2", description: "tsconfig", fileTarget: "tsconfig.json", dependencies: [], contextRequirement: "tsconfig", status: "completed" },
      { id: "task-3", description: "jest", fileTarget: "jest.config.cjs", dependencies: [], contextRequirement: "jest", status: "completed" },
      { id: "task-4", description: "model", fileTarget: "src/models/book.ts", dependencies: [], contextRequirement: "model", status: "pending" },
      { id: "task-5", description: "repo", fileTarget: "src/repositories/bookRepository.ts", dependencies: [], contextRequirement: "repo", status: "pending" },
      { id: "task-6", description: "service", fileTarget: "src/services/bookService.ts", dependencies: [], contextRequirement: "service", status: "pending" },
      { id: "task-7", description: "controller", fileTarget: "src/controllers/bookController.ts", dependencies: [], contextRequirement: "controller", status: "pending" },
      { id: "task-8", description: "route", fileTarget: "src/routes/books.ts", dependencies: [], contextRequirement: "route", status: "pending" },
      { id: "task-9", description: "auth", fileTarget: "src/middleware/auth.ts", dependencies: [], contextRequirement: "auth", status: "pending" },
      { id: "task-10", description: "app", fileTarget: "src/app.ts", dependencies: [], contextRequirement: "app", status: "pending" },
      { id: "task-11", description: "index", fileTarget: "src/index.ts", dependencies: [], contextRequirement: "index", status: "pending" },
      { id: "task-12", description: "ui", fileTarget: "public/index.html", dependencies: [], contextRequirement: "ui", status: "pending" },
      { id: "task-13", description: "test", fileTarget: "tests/books.test.ts", dependencies: [], contextRequirement: "test", status: "pending" },
      { id: "task-14", description: "readme", fileTarget: "README.md", dependencies: [], contextRequirement: "readme", status: "pending" },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat(messages) {
            const prompt = messages[0]?.content || "";
            const target = prompt.match(/请实现\s+([^\n。]+)/)?.[1]?.trim() || "";
            attemptedTargets.push(target);
            return { content: "```typescript\nexport const value = true;\nexport default value;\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.validationCheckpointRequested, true);
    assert.equal(attemptedTargets.includes("public/index.html"), false);
    assert.equal(attemptedTargets.includes("tests/books.test.ts"), false);
    assert.equal(attemptedTargets.includes("README.md"), false);
    assert.equal(result.subTasks.find((task) => task.fileTarget === "public/index.html").status, "pending");
    assert.equal(result.subTasks.find((task) => task.fileTarget === "tests/books.test.ts").status, "pending");
    assert.equal(result.subTasks.find((task) => task.fileTarget === "README.md").status, "pending");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder blocks imports that violate execution protocol file roles", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
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
        api: { endpoints: [] },
        files: {
          "src/models/userModel.ts": {
            role: "model",
            allowedDependencyRoles: ["other"],
          },
          "src/controllers/userController.ts": {
            role: "controller",
            allowedDependencyRoles: ["service", "model", "middleware", "other"],
          },
        },
      },
      runtime: {},
      workflow: { blockingRules: [], recoveryRules: [] },
      validation: { layoutRules: [], dependencyRules: [], runtimeRules: [], acceptanceRules: [] },
    },
    code: JSON.stringify({
      "src/controllers/userController.ts": "export const handler = () => 'ok';\n",
    }),
    subTasks: [
      {
        id: "task-model-protocol",
        description: "write model",
        fileTarget: "src/models/userModel.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: createCoderAgent("```typescript\nimport { handler } from \"../controllers/userController\";\nexport const userModel = { handler };\n```"),
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks[0].status, "failed");
    assert.match(result.subTasks[0].lastError || "", /执行协议依赖角色校验失败/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder still emits a meeting note when snapshot persistence fails", async () => {
  const workspace = await createTempWorkspace();
  const state = createBaseState({
    subTasks: [
      {
        id: "task-003",
        description: "write valid module with failing snapshot",
        fileTarget: "src/feature.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: createCoderAgent("```typescript\nexport function feature() { return 'ok'; }\n```"),
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      async () => {
        throw new Error("snapshot write failed");
      }
    );

    assert.equal(Array.isArray(result.meetingNotes), true);
    assert.equal(result.meetingNotes.length, 1);
    assert.equal(result.meetingNotes[0].id, "note-coder-r0");
    const notePath = `${workspace}/nodes/note-coder-r0.md`;
    const noteContent = await fs.readFile(notePath, "utf-8");
    assert.match(noteContent, /src\/feature\.ts|feature/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder revisits tasks after their file dependencies are completed in the same round", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    subTasks: [
      {
        id: "task-controller",
        description: "controller depends on model",
        fileTarget: "src/controllers/taskController.ts",
        dependencies: ["src/models/taskModel.ts"],
        contextRequirement: "none",
        status: "pending",
      },
      {
        id: "task-model",
        description: "model file",
        fileTarget: "src/models/taskModel.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: createCoderAgent("```typescript\nexport const value = 1;\n```"),
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    const controllerTask = result.subTasks.find((task) => task.id === "task-controller");
    const modelTask = result.subTasks.find((task) => task.id === "task-model");

    assert.equal(controllerTask.status, "completed");
    assert.equal(modelTask.status, "completed");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder accepts valid final code after a transient pre-write lint failure", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    subTasks: [
      {
        id: "task-004",
        description: "write index after transient lint failure",
        fileTarget: "src/index.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "娴嬭瘯Coder" };
          },
          async chat(_messages, onEvent) {
            onEvent({
              type: "tool_use",
              tool: "lint_fix",
              content:
                '淇瑙勮寖鏃跺嚭閿?src/index.ts): Command failed: npx --yes prettier@3 --write "src/index.ts"\n[error] No files matching the pattern were found: "src/index.ts".',
              sender: "娴嬭瘯Coder",
            });
            onEvent({
              type: "tool_use",
              tool: "write_file",
              content: "Successfully wrote to src/index.ts",
              sender: "娴嬭瘯Coder",
            });
            return {
              content:
                "```typescript\nimport express from 'express';\nconst app = express();\nexport default app;\n```",
            };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks[0].status, "completed");
    assert.equal(result.codeLog[0].status, "written");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder trusts validated disk output over natural-language completion summaries", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    subTasks: [
      {
        id: "task-008",
        description: "write logger module",
        fileTarget: "src/utils/logger.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat(_messages, onEvent) {
            const filePath = `${workspace}\\src\\utils\\logger.ts`;
            onEvent({
              type: "tool_use",
              tool: "write_file",
              content: "Successfully wrote to src/utils/logger.ts",
              sender: "测试Coder",
            });
            await fs.mkdir(`${workspace}/src/utils`, { recursive: true });
            await fs.writeFile(
              `${workspace}/src/utils/logger.ts`,
              "export const logger = { info: console.log, error: console.error, warn: console.warn };\n",
              "utf-8"
            );
            onEvent({
              type: "tool_use",
              tool: "diagnose_code",
              content: "[SUCCESS] No TypeScript errors found.",
              sender: "测试Coder",
            });
            onEvent({
              type: "tool_use",
              tool: "lint_fix",
              content: `文件 ${filePath} (JS/TS) 已完成格式化和规范修复。`,
              sender: "测试Coder",
            });
            return {
              content:
                "✅ src/utils/logger.ts 已修复\n\n【执行操作】\n1. 重新写入完整模块代码，确保文件完整性\n2. TypeScript 诊断：无错误\n3. 代码规范检查：已通过",
            };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks[0].status, "completed");
    const persisted = await fs.readFile(`${workspace}/src/utils/logger.ts`, "utf-8");
    assert.match(persisted, /export const logger/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder trusts validated disk output even if an early transient tool error was reported", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    subTasks: [
      {
        id: "task-disk-overrides-tool-error",
        description: "write logger module",
        fileTarget: "src/utils/logger.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  const agent = {
    getPersona() {
      return { name: "测试Coder" };
    },
    async chat(_messages, onEvent) {
      onEvent({
        type: "tool_use",
        tool: "lint_fix",
        content: "Error executing prettier: spawn transient failure",
      });
      onEvent({
        type: "tool_use",
        tool: "write_file",
        content: "Successfully wrote to src/utils/logger.ts",
      });
      onEvent({
        type: "tool_use",
        tool: "diagnose_code",
        content: "[SUCCESS] No TypeScript errors found.",
      });
      await fs.mkdir(path.join(workspace, "src", "utils"), { recursive: true });
      await fs.writeFile(
        path.join(workspace, "src", "utils", "logger.ts"),
        "export function logger(message: string) { return message; }\n",
        "utf-8"
      );
      return { content: "已完成。" };
    },
  };

  try {
    const result = await coderNode(
      state,
      { coder: agent },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks[0].status, "completed");
    assert.equal(result.blockedReason, "");
    assert.equal(result.lastFailedNode, "");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("missing-file diagnose on current target does not block a later successful disk write", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    subTasks: [
      {
        id: "task-009",
        description: "write auth middleware after delayed disk flush",
        fileTarget: "src/middleware/auth.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat(_messages, onEvent) {
            onEvent({
              type: "tool_use",
              tool: "write_file",
              content: "Successfully wrote to src/middleware/auth.ts",
              sender: "测试Coder",
            });
            onEvent({
              type: "tool_use",
              tool: "diagnose_code",
              content: `[ERROR] File not found: ${workspace}\\src\\middleware\\auth.ts`,
              sender: "测试Coder",
            });
            await fs.mkdir(`${workspace}/src/middleware`, { recursive: true });
            await fs.writeFile(
              `${workspace}/src/middleware/auth.ts`,
              "export function authenticate() { return true; }\nexport function requireAdmin() { return true; }\n",
              "utf-8"
            );
            return {
              content: "已写入完成",
            };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks[0].status, "completed");
    assert.match(result.code || "", /authenticate/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder clears stale blocking state when disk reconciliation recovers the failed file", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    subTasks: [
      {
        id: "task-route-recover",
        description: "write books route after summary-only response",
        fileTarget: "src/routes/books.ts",
        dependencies: [],
        contextRequirement: "route",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat(_messages, onEvent) {
            onEvent({
              type: "tool_use",
              tool: "write_file",
              content: "Successfully wrote to src/routes/books.ts",
              sender: "测试Coder",
            });
            await fs.mkdir(path.join(workspace, "src", "routes"), { recursive: true });
            await fs.writeFile(
              path.join(workspace, "src", "routes", "books.ts"),
              "import { Router } from 'express';\nconst router = Router();\nexport default router;\n",
              "utf-8"
            );
            return {
              content: "## 修复完成\n已同步写入 src/routes/books.ts",
            };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks[0].status, "completed");
    assert.equal(result.blockedReason, "");
    assert.equal(result.lastFailedNode, "");
    assert.equal(result.testResults, "");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder gives format-only drift a second in-task self-heal chance before escalating", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let attempts = 0;
  const state = createBaseState({
    subTasks: [
      {
        id: "task-test-self-heal",
        description: "write books api test",
        fileTarget: "tests/books.test.ts",
        dependencies: [],
        contextRequirement: "test",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            attempts += 1;
            if (attempts < 3) {
              return {
                content: attempts === 1
                  ? "我先提交修复计划，然后再写代码。"
                  : "{\"diagnosis\":\"格式偏移\",\"action\":\"rewrite\"}",
              };
            }
            return {
              content: "```typescript\nimport request from 'supertest';\ndescribe('books api', () => { it('placeholder', () => { expect(true).toBe(true); }); });\n```",
            };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(attempts, 3);
    assert.equal(result.subTasks[0].status, "completed");
    assert.equal(result.blockedReason, "");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder reconciles valid disk files into final snapshot even if they were missed in the main loop", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    subTasks: [
      {
        id: "task-010",
        description: "reconcile delayed middleware file",
        fileTarget: "src/middleware/auth.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  await fs.mkdir(`${workspace}/src/middleware`, { recursive: true });
  await fs.writeFile(
    `${workspace}/src/middleware/auth.ts`,
    "export function authenticate() { return true; }\n",
    "utf-8"
  );

  try {
    const result = await coderNode(
      state,
      {
        coder: createCoderAgent("```typescript\nexport const ignored = true;\n```"),
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    const finalSnapshot = recorder.snapshots[recorder.snapshots.length - 1];
    assert.equal(result.subTasks[0].status, "completed");
    assert.ok(finalSnapshot);
    assert.equal(finalSnapshot.node, "coder_final");
    assert.equal(
      finalSnapshot.state.subTasks.find((task) => task.id === "task-010").status,
      "completed"
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder stops the round after a blocking file failure instead of spending tokens on later tasks", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    subTasks: [
      {
        id: "task-005",
        description: "broken first file",
        fileTarget: "src/index.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
      {
        id: "task-006",
        description: "later file should not run",
        fileTarget: "src/routes/user.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "娴嬭瘯Coder" };
          },
          async chat() {
            chatCalls += 1;
            return {
              content: "```typescript\n{ success: true }\n```",
            };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(chatCalls, 1);
    assert.equal(result.subTasks[0].status, "failed");
    assert.equal(result.subTasks[1].status, "pending");
    assert.match(result.blockedReason || "", /src\/index\.ts|index\.ts/);
    assert.match(result.testResults || "", /Coder 阻塞失败|index\.ts/);
    assert.deepEqual(result.qaFailures.failedFiles, ["src/index.ts"]);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder rejects cross-file writes outside the current subtask target", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    code: JSON.stringify(
      {
        "package.json": '{ "name": "demo", "version": "1.0.0" }',
      },
      null,
      2
    ),
    subTasks: [
      {
        id: "task-package",
        description: "package manifest",
        fileTarget: "package.json",
        dependencies: [],
        contextRequirement: "none",
        status: "completed",
      },
      {
        id: "task-test",
        description: "health route test",
        fileTarget: "tests/health.test.ts",
        dependencies: ["package.json"],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat(_messages, onEvent) {
            onEvent({
              type: "tool_use",
              tool: "write_file",
              content: "Successfully wrote to tests/health.test.ts",
              sender: "测试Coder",
            });
            onEvent({
              type: "tool_use",
              tool: "write_file",
              content: "Successfully wrote to package.json",
              sender: "测试Coder",
            });
            return {
              content:
                '```typescript\nimport request from "supertest";\nexport const ok = true;\n```',
            };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    const targetTask = result.subTasks.find((task) => task.id === "task-test");
    assert.equal(targetTask.status, "failed");
    assert.match(targetTask.lastError || "", /越权|package\.json|tests\/health\.test\.ts/i);
    assert.match(result.blockedReason || "", /package\.json|越权/i);
    const packageContent = await fs.readFile(`${workspace}/package.json`, "utf-8").catch(() => "");
    assert.equal(packageContent.trim(), '{ "name": "demo", "version": "1.0.0" }');
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("prettier install or network failure is downgraded to non-blocking warning", () => {
  const result = classifyPrettierFailure(
    "npm ERR! code ENOTFOUND\nnpm ERR! request to https://registry.npmjs.org/prettier failed"
  );

  assert.equal(result, "warning");
});

test("prettier missing target file is downgraded to non-blocking warning", () => {
  const result = classifyPrettierFailure(
    '[error] No files matching the pattern were found: "D:\\working\\mycode\\jimclaw\\workspace\\run_1774840135522\\src\\services\\bookService.ts".'
  );

  assert.equal(result, "warning");
});

test("prettier parse failure remains blocking", () => {
  const result = classifyPrettierFailure(
    "[error] src/index.ts: SyntaxError: Unterminated string literal. (12:4)"
  );

  assert.equal(result, "blocking");
});

test("coder node uses coding mode for file generation", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let observedMode = "";
  const state = createBaseState({
    subTasks: [
      {
        id: "task-007",
        description: "write app module",
        fileTarget: "src/app.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat(_messages, _onEvent, options) {
            observedMode = options?.mode || "";
            return {
              content: "```typescript\nexport const app = true;\n```",
            };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(observedMode, "coding");
    assert.equal(result.subTasks[0].status, "completed");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold deterministically generates tsconfig without llm drift", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "Health Service" },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      dependencies: { express: "^4.18.2", cors: "^2.8.5" },
      devDependencies: { typescript: "^5.3.3", jest: "^29.7.0", "ts-jest": "^29.1.1", "@types/jest": "^29.5.11", "@types/node": "^20.10.0", "ts-node": "^10.9.2" },
      filesToCreate: ["tsconfig.json"],
    },
    subTasks: [
      {
        id: "task-tsconfig",
        description: "write tsconfig",
        fileTarget: "tsconfig.json",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            return { content: "```json\n[]\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks[0].status, "completed");
    const tsconfig = JSON.parse(await fs.readFile(`${workspace}/tsconfig.json`, "utf-8"));
    assert.equal(tsconfig.compilerOptions.module, "commonjs");
    assert.deepEqual(tsconfig.compilerOptions.types, ["node", "jest"]);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold normalizes non-ascii project title into valid npm package name", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "TypeScript Express 健康检查服务" },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      dependencies: { express: "^4.18.2", cors: "^2.8.5" },
      devDependencies: { typescript: "^5.3.3" },
      filesToCreate: ["package.json"],
    },
    subTasks: [
      {
        id: "task-package",
        description: "write package",
        fileTarget: "package.json",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      { coder: createCoderAgent("```json\n{}\n```") },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks[0].status, "completed");
    const pkg = JSON.parse(await fs.readFile(`${workspace}/package.json`, "utf-8"));
    assert.equal(pkg.name, "typescript-express");
    assert.equal(pkg.main, "dist/src/index.js");
    assert.equal(pkg.scripts.start, "node dist/src/index.js");
    assert.equal(pkg.devDependencies["@types/cors"], "^2.8.17");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold deterministically generates logger module", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "Health Service" },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      dependencies: { express: "^4.18.2", cors: "^2.8.5" },
      devDependencies: { typescript: "^5.3.3" },
      filesToCreate: ["src/logger.ts"],
    },
    subTasks: [
      {
        id: "task-logger",
        description: "write logger",
        fileTarget: "src/logger.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            return { content: "```typescript\n({ broken: true })\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks[0].status, "completed");
    const loggerCode = await fs.readFile(`${workspace}/src/logger.ts`, "utf-8");
    assert.match(loggerCode, /export const requestLogger = loggerMiddleware/);
    assert.match(loggerCode, /next\(\)/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold also covers src/logging/logger.ts", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "Library Service" },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      dependencies: { express: "^4.18.2", cors: "^2.8.5" },
      devDependencies: { typescript: "^5.3.3" },
      filesToCreate: ["src/logging/logger.ts"],
    },
    subTasks: [
      {
        id: "task-logging-logger",
        description: "write logging logger",
        fileTarget: "src/logging/logger.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            return { content: "```typescript\n({ broken: true })\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks[0].status, "completed");
    assert.equal(chatCalls, 0);
    const loggerCode = await fs.readFile(`${workspace}/src/logging/logger.ts`, "utf-8");
    assert.match(loggerCode, /export const requestLogger = loggerMiddleware/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold deterministically generates middleware logger with originalUrl tracking", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "Health Service" },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      dependencies: { express: "^4.18.2", cors: "^2.8.5" },
      devDependencies: { typescript: "^5.3.3" },
      filesToCreate: ["src/middleware/logger.ts"],
    },
    subTasks: [
      {
        id: "task-middleware-logger",
        description: "write middleware logger",
        fileTarget: "src/middleware/logger.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            return { content: "```typescript\nexport const broken = true;\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );
    assert.equal(result.subTasks[0].status, "completed");
    const loggerCode = await fs.readFile(`${workspace}/src/middleware/logger.ts`, "utf-8");
    assert.match(loggerCode, /req\.originalUrl/);
    assert.match(loggerCode, /export function getLogs/);
    assert.match(loggerCode, /export function clearLogs/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("middleware structural normalization removes route dependencies to avoid deadlock", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    subTasks: [
      {
        id: "task-route",
        description: "write route",
        fileTarget: "src/routes/health.ts",
        dependencies: ["src/middleware/auth.ts", "src/middleware/logger.ts"],
        contextRequirement: "none",
        status: "pending",
      },
      {
        id: "task-auth",
        description: "write auth middleware",
        fileTarget: "src/middleware/auth.ts",
        dependencies: ["src/routes/health.ts"],
        contextRequirement: "none",
        status: "pending",
      },
      {
        id: "task-logger",
        description: "write logger middleware",
        fileTarget: "src/middleware/logger.ts",
        dependencies: ["src/routes/health.ts"],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: createCoderAgent("```typescript\nexport default {};\n```"),
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    const authTask = result.subTasks.find((task) => task.id === "task-auth");
    const loggerTask = result.subTasks.find((task) => task.id === "task-logger");
    assert.deepEqual(authTask.dependencies, []);
    assert.deepEqual(loggerTask.dependencies, []);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold deterministically generates health route with auth and ping support", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "Health Service" },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      dependencies: { express: "^4.18.2", cors: "^2.8.5" },
      devDependencies: { typescript: "^5.3.3" },
      filesToCreate: ["src/routes/health.ts", "src/middleware/auth.ts", "src/middleware/logger.ts"],
    },
    subTasks: [
      {
        id: "task-health-route",
        description: "write health route",
        fileTarget: "src/routes/health.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            return { content: "```typescript\nexport default {};\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(chatCalls, 0);
    assert.equal(result.subTasks[0].status, "completed");
    const routeCode = await fs.readFile(`${workspace}/src/routes/health.ts`, "utf-8");
    assert.match(routeCode, /authMiddleware/);
    assert.match(routeCode, /loggerMiddleware/);
    assert.match(routeCode, /healthRouter\.get\("\/ping"/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold index does not import undeclared support modules", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "Health Service" },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      dependencies: { express: "^4.18.2", cors: "^2.8.5" },
      devDependencies: { typescript: "^5.3.3" },
      filesToCreate: ["package.json", "tsconfig.json", "src/index.ts", "tests/health.test.ts"],
    },
    subTasks: [
      {
        id: "task-index",
        description: "write index",
        fileTarget: "src/index.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            return { content: "```typescript\nexport default {};\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(chatCalls, 0);
    assert.equal(result.subTasks[0].status, "completed");
    const indexCode = await fs.readFile(`${workspace}/src/index.ts`, "utf-8");
    assert.doesNotMatch(indexCode, /"\.\/logger"|"\.\/errorHandler"/);
    assert.match(indexCode, /NextFunction/);
    assert.match(indexCode, /app\.get\("\/api\/health"/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold mounts declared health route without redefining the endpoint inline", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "Health Service" },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      dependencies: { express: "^4.18.2", cors: "^2.8.5" },
      devDependencies: { typescript: "^5.3.3" },
      filesToCreate: ["src/index.ts", "src/routes/health.ts"],
    },
    subTasks: [
      {
        id: "task-index",
        description: "write index",
        fileTarget: "src/index.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
      {
        id: "task-route",
        description: "write route",
        fileTarget: "src/routes/health.ts",
        dependencies: ["src/index.ts"],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            return { content: "```typescript\nexport default {};\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(chatCalls, 0);
    assert.equal(result.subTasks[0].status, "completed");
    assert.equal(result.subTasks[1].status, "completed");
    const indexCode = await fs.readFile(`${workspace}/src/index.ts`, "utf-8");
    const routeCode = await fs.readFile(`${workspace}/src/routes/health.ts`, "utf-8");
    assert.match(indexCode, /import healthRouter from "\.\/routes\/health"/);
    assert.match(indexCode, /app\.use\("\/api\/health", healthRouter\)/);
    assert.doesNotMatch(indexCode, /app\.get\("\/api\/health"/);
    assert.match(routeCode, /const healthRouter = Router\(\)/);
    assert.match(routeCode, /healthRouter\.get\("\/"/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold deterministically generates errors and split auth helper services", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "图书管理系统" },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      framework: "Express.js ^4.18",
      dependencies: { express: "^4.18.2" },
      devDependencies: { typescript: "^5.3.3" },
      filesToCreate: [
        "src/errors.ts",
        "src/logging/logger.ts",
        "src/services/authSessionService.ts",
        "src/services/authCredentialService.ts",
        "src/services/authAccountPolicyService.ts",
      ],
    },
    subTasks: [
      {
        id: "task-errors",
        description: "write errors",
        fileTarget: "src/errors.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
      {
        id: "task-logger",
        description: "logger ready",
        fileTarget: "src/logging/logger.ts",
        dependencies: ["src/errors.ts"],
        contextRequirement: "none",
        status: "completed",
      },
      {
        id: "task-auth-session",
        description: "write auth session helper",
        fileTarget: "src/services/authSessionService.ts",
        dependencies: ["src/errors.ts", "src/logging/logger.ts"],
        contextRequirement: "none",
        status: "pending",
      },
      {
        id: "task-auth-credential",
        description: "write auth credential helper",
        fileTarget: "src/services/authCredentialService.ts",
        dependencies: ["src/errors.ts", "src/logging/logger.ts"],
        contextRequirement: "none",
        status: "pending",
      },
      {
        id: "task-auth-policy",
        description: "write auth policy helper",
        fileTarget: "src/services/authAccountPolicyService.ts",
        dependencies: ["src/errors.ts", "src/logging/logger.ts"],
        contextRequirement: "none",
        status: "pending",
      },
    ],
    code: JSON.stringify({
      "src/logging/logger.ts": "export const requestLogger = () => undefined;\n",
    }),
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            return { content: "```typescript\nexport const unreachable = true;\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(chatCalls, 0);
    assert.equal(result.subTasks.every((task) => task.status === "completed"), true);

    const errorsCode = await fs.readFile(`${workspace}/src/errors.ts`, "utf-8");
    const sessionCode = await fs.readFile(`${workspace}/src/services/authSessionService.ts`, "utf-8");
    const credentialCode = await fs.readFile(`${workspace}/src/services/authCredentialService.ts`, "utf-8");
    const policyCode = await fs.readFile(`${workspace}/src/services/authAccountPolicyService.ts`, "utf-8");

    assert.match(errorsCode, /export class AppError extends Error/);
    assert.match(errorsCode, /export class UnauthorizedError extends AppError/);
    assert.match(errorsCode, /export function toErrorResponse/);

    assert.match(sessionCode, /export function createSession/);
    assert.match(sessionCode, /export function verifySessionToken/);
    assert.match(sessionCode, /export function buildSessionUser/);

    assert.match(credentialCode, /export function hashCredential/);
    assert.match(credentialCode, /export function verifyCredential/);
    assert.match(credentialCode, /export function assertCredential/);

    assert.match(policyCode, /export function ensureAccountPolicy/);
    assert.match(policyCode, /export function hasRequiredRole/);
    assert.match(policyCode, /export function normalizeRoles/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold deterministically generates auth orchestration service", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "Library Auth Service" },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      dependencies: { express: "^4.18.2", cors: "^2.8.5" },
      devDependencies: { typescript: "^5.3.3" },
      filesToCreate: [
        "src/errors.ts",
        "src/logging/logger.ts",
        "src/services/authSessionService.ts",
        "src/services/authCredentialService.ts",
        "src/services/authAccountPolicyService.ts",
        "src/services/authService.ts",
      ],
    },
    subTasks: [
      {
        id: "task-auth-service",
        description: "write auth service",
        fileTarget: "src/services/authService.ts",
        dependencies: [
          "src/errors.ts",
          "src/logging/logger.ts",
          "src/services/authSessionService.ts",
          "src/services/authCredentialService.ts",
          "src/services/authAccountPolicyService.ts",
        ],
        contextRequirement: "none",
        status: "pending",
      },
    ],
    code: JSON.stringify(
      {
        "src/errors.ts": "export class AppError extends Error {}\nexport class ConflictError extends AppError {}\nexport class NotFoundError extends AppError {}\nexport class UnauthorizedError extends AppError {}\nexport class ValidationError extends AppError {}\n",
        "src/logging/logger.ts": "export const logEntries = [];\n",
        "src/services/authSessionService.ts": "export interface AuthSessionUser { id: string; username: string; role?: string; }\nexport interface AuthSession { token: string; user: AuthSessionUser; }\nexport function createSession(user) { return { token: 't', user }; }\nexport function verifySessionToken() { return { sub: 'u-1', username: 'admin', role: 'admin' }; }\nexport function buildSessionUser(payload) { return { id: payload.sub, username: payload.username, role: payload.role }; }\n",
        "src/services/authCredentialService.ts": "export interface CredentialHash { algorithm: 'sha256'; salt: string; digest: string; }\nexport function hashCredential(secret) { return { algorithm: 'sha256', salt: 's', digest: secret }; }\nexport function assertCredential() {}\n",
        "src/services/authAccountPolicyService.ts": "export interface AuthAccountPolicyContext { accountId: string; status?: string; roles?: string[]; }\nexport function ensureAccountPolicy() {}\nexport function buildAccountPolicySnapshot(input) { return input; }\nexport function normalizeRoles(roles = []) { return roles; }\n",
      },
      null,
      2
    ),
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            return { content: "```typescript\nexport const unreachable = true;\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(chatCalls, 0);
    assert.equal(result.subTasks[0].status, "completed");
    const authServiceCode = await fs.readFile(`${workspace}/src/services/authService.ts`, "utf-8");
    assert.match(authServiceCode, /export function login/);
    assert.match(authServiceCode, /export function logout/);
    assert.match(authServiceCode, /export function createUser/);
    assert.match(authServiceCode, /export function assignRoles/);
    assert.match(authServiceCode, /logEntries\.push/);
    assert.match(authServiceCode, /__resetAuthStore/);
    assert.doesNotMatch(authServiceCode, /\.\/authSessionService/);
    assert.doesNotMatch(authServiceCode, /\.\/authCredentialService/);
    assert.doesNotMatch(authServiceCode, /\.\/authAccountPolicyService/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold deterministically generates split domain services", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "图书管理系统" },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      framework: "Express.js ^4.18",
      dependencies: { express: "^4.18.2" },
      devDependencies: { typescript: "^5.3.3" },
      filesToCreate: [
        "src/errors.ts",
        "src/models/book.ts",
        "src/services/bookQueryService.ts",
        "src/services/bookMutationService.ts",
        "src/services/bookInventoryService.ts",
      ],
    },
    subTasks: [
      {
        id: "task-errors",
        description: "errors ready",
        fileTarget: "src/errors.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "completed",
      },
      {
        id: "task-model",
        description: "model ready",
        fileTarget: "src/models/book.ts",
        dependencies: ["src/errors.ts"],
        contextRequirement: "none",
        status: "completed",
      },
      {
        id: "task-query",
        description: "write book query helper",
        fileTarget: "src/services/bookQueryService.ts",
        dependencies: ["src/errors.ts", "src/models/book.ts"],
        contextRequirement: "none",
        status: "pending",
      },
      {
        id: "task-mutation",
        description: "write book mutation helper",
        fileTarget: "src/services/bookMutationService.ts",
        dependencies: ["src/errors.ts", "src/models/book.ts"],
        contextRequirement: "none",
        status: "pending",
      },
      {
        id: "task-inventory",
        description: "write book inventory helper",
        fileTarget: "src/services/bookInventoryService.ts",
        dependencies: ["src/errors.ts", "src/models/book.ts"],
        contextRequirement: "none",
        status: "pending",
      },
    ],
    code: JSON.stringify({
      "src/errors.ts": "export class AppError extends Error {}\nexport class NotFoundError extends AppError {}\nexport class ValidationError extends AppError {}\n",
      "src/models/book.ts": "export interface Book { id: string; }\n",
    }),
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            return { content: "```typescript\nexport const unreachable = true;\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(chatCalls, 0);
    assert.equal(result.subTasks.every((task) => task.status === "completed"), true);

    const queryCode = await fs.readFile(`${workspace}/src/services/bookQueryService.ts`, "utf-8");
    const mutationCode = await fs.readFile(`${workspace}/src/services/bookMutationService.ts`, "utf-8");
    const inventoryCode = await fs.readFile(`${workspace}/src/services/bookInventoryService.ts`, "utf-8");

    assert.match(queryCode, /export interface BookRecord/);
    assert.match(queryCode, /export function listBookRecords/);
    assert.match(queryCode, /export function findBookById/);

    assert.match(mutationCode, /export interface BookMutationInput/);
    assert.match(mutationCode, /export function createBookRecord/);
    assert.match(mutationCode, /export function updateBookRecord/);

    assert.match(inventoryCode, /export interface BookInventoryRecord/);
    assert.match(inventoryCode, /export function adjustBookInventory/);
    assert.match(inventoryCode, /export function summarizeBookInventory/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold derives route mount path from owned endpoints instead of singularizing file names", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "Book Service" },
    apiContract: {
      endpoints: [
        { method: "GET", path: "/api/books" },
        { method: "POST", path: "/api/books" },
        { method: "PUT", path: "/api/books/:id" },
        { method: "DELETE", path: "/api/books/:id" },
      ],
    },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      dependencies: { express: "^4.18.2", cors: "^2.8.5" },
      devDependencies: { typescript: "^5.3.3" },
      filesToCreate: ["src/index.ts", "src/routes/bookRoutes.ts", "src/controllers/bookController.ts", "src/middleware/authMiddleware.ts"],
    },
    subTasks: [
      {
        id: "task-index",
        description: "write index",
        fileTarget: "src/index.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
      {
        id: "task-route",
        description: "write route",
        fileTarget: "src/routes/bookRoutes.ts",
        dependencies: ["src/index.ts"],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            return { content: "```typescript\nexport default {};\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(chatCalls, 0);
    assert.equal(result.subTasks[0].status, "completed");
    const indexCode = await fs.readFile(`${workspace}/src/index.ts`, "utf-8");
    assert.match(indexCode, /app\.use\("\/api\/books", bookRoutesRouter\)/);
    assert.doesNotMatch(indexCode, /app\.use\("\/api\/book", bookRoutesRouter\)/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold aligns crud route imports with existing controller and auth module conventions", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "Library Service" },
    apiContract: {
      endpoints: [
        { method: "GET", path: "/api/books" },
        { method: "POST", path: "/api/books" },
        { method: "GET", path: "/api/books/:id" },
        { method: "PUT", path: "/api/books/:id" },
        { method: "PATCH", path: "/api/books/:id/status" },
        { method: "DELETE", path: "/api/books/:id" },
        { method: "POST", path: "/api/books/:id/borrow" },
        { method: "POST", path: "/api/books/:id/return" },
        { method: "POST", path: "/api/books/:id/reservations" },
      ],
    },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      dependencies: { express: "^4.18.2", cors: "^2.8.5" },
      devDependencies: { typescript: "^5.3.3" },
      filesToCreate: ["src/routes/books.ts", "src/controllers/bookController.ts", "src/middleware/auth.ts"],
    },
    code: JSON.stringify(
      {
        "src/controllers/bookController.ts": `export async function listBooks() {}\nexport async function createBook() {}\nexport async function getBook() {}\nexport async function updateBook() {}\nexport async function updateBookStatus() {}\nexport async function deleteBook() {}\nexport async function borrowBook() {}\nexport async function returnBook() {}\nexport async function reserveBook() {}\n`,
        "src/middleware/auth.ts": "export function authMiddleware(_req, _res, next) { next(); }\n",
      },
      null,
      2
    ),
    subTasks: [
      {
        id: "task-books-route",
        description: "write books route",
        fileTarget: "src/routes/books.ts",
        dependencies: ["src/controllers/bookController.ts", "src/middleware/auth.ts"],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            return { content: "```typescript\nexport default {};\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(chatCalls, 0);
    assert.equal(result.subTasks[0].status, "completed");
    const routeCode = await fs.readFile(`${workspace}/src/routes/books.ts`, "utf-8");
    assert.match(routeCode, /import \{[^}]*listBooks[^}]*createBook[^}]*getBook[^}]*updateBook[^}]*updateBookStatus[^}]*deleteBook[^}]*borrowBook[^}]*returnBook[^}]*reserveBook[^}]*\} from "\.\.\/controllers\/bookController"/);
    assert.match(routeCode, /import \{ authMiddleware \} from "\.\.\/middleware\/auth"/);
    assert.match(routeCode, /router\.get\("\/", listBooks\)/);
    assert.match(routeCode, /router\.get\("\/:id", getBook\)/);
    assert.match(routeCode, /router\.patch\("\/:id\/status", authMiddleware, updateBookStatus\)/);
    assert.match(routeCode, /router\.post\("\/:id\/borrow", authMiddleware, borrowBook\)/);
    assert.match(routeCode, /router\.post\("\/:id\/return", authMiddleware, returnBook\)/);
    assert.match(routeCode, /router\.post\("\/:id\/reservations", authMiddleware, reserveBook\)/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold deterministically generates health test", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "Health Service" },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      dependencies: { express: "^4.18.2", cors: "^2.8.5" },
      devDependencies: { typescript: "^5.3.3", jest: "^29.7.0", "ts-jest": "^29.1.1", "@types/jest": "^29.5.11", "@types/node": "^20.10.0" },
      filesToCreate: ["package.json", "tsconfig.json", "src/index.ts", "src/logging/logger.ts", "tests/health.test.ts"],
    },
    subTasks: [
      {
        id: "task-health-test",
        description: "write health test",
        fileTarget: "tests/health.test.ts",
        dependencies: ["src/index.ts"],
        contextRequirement: "none",
        status: "pending",
      },
    ],
    code: JSON.stringify(
      {
        "src/index.ts": 'import express, { Express, Request, Response, NextFunction } from "express";\nimport cors from "cors";\nconst app: Express = express();\napp.use(cors());\napp.use(express.json());\napp.get("/api/health", (_req: Request, res: Response) => res.status(200).json({ success: true }));\napp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ success: false, error: "Internal Server Error", message: err.message }));\nexport default app;\n',
      },
      null,
      2
    ),
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            return { content: "```typescript\n({ nope: true })\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(chatCalls, 0);
    assert.equal(result.subTasks[0].status, "completed");
    const testCode = await fs.readFile(`${workspace}/tests/health.test.ts`, "utf-8");
    assert.match(testCode, /import request from "supertest"/);
    assert.match(testCode, /import \{ clearLogs, getLogs \} from "\.\.\/src\/logging\/logger"/);
    assert.match(testCode, /request\(app\)\.get\("\/api\/health"\)/);
    assert.doesNotMatch(testCode, /X-API-Key/);
    assert.doesNotMatch(testCode, /toBe\(401\)/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold deterministically generates bounded crud api test", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "图书管理系统" },
    requirementProtocol: {
      version: "v1",
      userIntent: {
        title: "图书管理系统",
        requirements: ["需要图书增删改查、借阅、归还和预约能力"],
        acceptanceCriteria: [],
      },
      capabilities: {
        frontendRequired: false,
        backendRequired: true,
        authRequired: true,
        auditLogRequired: true,
        dockerRequired: false,
        entities: ["book"],
        crudEntities: ["book"],
        uiCapabilities: ["create", "edit", "delete", "login"],
      },
    },
    apiContract: {
      endpoints: [
        { method: "GET", path: "/api/books" },
        { method: "POST", path: "/api/books" },
        { method: "GET", path: "/api/books/:id" },
        { method: "PUT", path: "/api/books/:id" },
        { method: "PATCH", path: "/api/books/:id/status" },
        { method: "DELETE", path: "/api/books/:id" },
        { method: "POST", path: "/api/books/:id/borrow" },
        { method: "POST", path: "/api/books/:id/return" },
        { method: "POST", path: "/api/books/:id/reservations" },
        { method: "POST", path: "/api/auth/login" },
      ],
    },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      dependencies: { express: "^4.18.2", cors: "^2.8.5" },
      devDependencies: {
        typescript: "^5.3.3",
        jest: "^29.7.0",
        "ts-jest": "^29.1.1",
        "@types/jest": "^29.5.11",
        "@types/node": "^20.10.0",
      },
      filesToCreate: ["src/index.ts", "src/services/bookService.ts", "tests/books.test.ts"],
    },
    subTasks: [
      {
        id: "task-index-ready",
        description: "index ready",
        fileTarget: "src/index.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "completed",
      },
      {
        id: "task-service-ready",
        description: "service ready",
        fileTarget: "src/services/bookService.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "completed",
      },
      {
        id: "task-books-test",
        description: "write books test",
        fileTarget: "tests/books.test.ts",
        dependencies: ["src/index.ts", "src/services/bookService.ts"],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            return { content: "```typescript\nexport const nope = true;\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(chatCalls, 0);
    assert.equal(result.subTasks[0].status, "completed");
    const testCode = await fs.readFile(`${workspace}/tests/books.test.ts`, "utf-8");
    assert.match(testCode, /import request from "supertest"/);
    assert.match(testCode, /import app from "\.\.\/src\/index"/);
    assert.match(testCode, /const RESOURCE_PATH = "\/api\/books"/);
    assert.match(testCode, /request\(app\)\.get\(RESOURCE_PATH\)/);
    assert.doesNotMatch(testCode, /ServiceCtor/);
    assert.doesNotMatch(testCode, /Book service 基线/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold deterministically generates auth api baseline test", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "图书管理系统" },
    requirementProtocol: {
      version: "v1",
      userIntent: {
        title: "图书管理系统",
        requirements: ["需要登录与当前用户接口"],
        acceptanceCriteria: [],
      },
      capabilities: {
        frontendRequired: false,
        backendRequired: true,
        authRequired: true,
        auditLogRequired: true,
        dockerRequired: false,
        entities: ["book"],
        crudEntities: ["book"],
        uiCapabilities: ["login"],
      },
    },
    apiContract: {
      endpoints: [
        { method: "POST", path: "/api/auth/login" },
        { method: "GET", path: "/api/auth/me" },
      ],
    },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      dependencies: { express: "^4.18.2", cors: "^2.8.5", jsonwebtoken: "^9.0.2" },
      devDependencies: { typescript: "^5.3.3", jest: "^29.7.0", "ts-jest": "^29.1.1", "@types/jest": "^29.5.11", "@types/node": "^20.10.0" },
      filesToCreate: ["src/index.ts", "tests/auth.test.ts"],
    },
    subTasks: [
      {
        id: "task-auth-index-ready",
        description: "index ready",
        fileTarget: "src/index.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "completed",
      },
      {
        id: "task-auth-test",
        description: "write auth test",
        fileTarget: "tests/auth.test.ts",
        dependencies: ["src/index.ts"],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            return { content: "```typescript\nexport const unreachable = true;\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(chatCalls, 0);
    assert.equal(result.subTasks.find((task) => task.fileTarget === "tests/auth.test.ts").status, "completed");
    const testCode = await fs.readFile(`${workspace}/tests/auth.test.ts`, "utf-8");
    assert.match(testCode, /request\(app\)\.post\("\/api\/auth\/login"\)/);
    assert.match(testCode, /request\(app\)\.get\("\/api\/auth\/me"\)/);
    assert.doesNotMatch(testCode, /new ServiceCtor/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("bounded crud plan keeps auth route when auth is required even without spec apiContract", () => {
  const requirementProtocol = buildRequirementProtocol({
    title: "图书管理系统",
    requirements: ["需要登录与图书管理"],
    acceptanceCriteria: [],
  });
  const stabilized = stabilizeSpecForExecution({
    language: "TypeScript",
    framework: "Express.js ^4.18",
    filesToCreate: [
      "package.json",
      "tsconfig.json",
      "src/index.ts",
      "src/routes/books.ts",
      "src/controllers/bookController.ts",
      "src/services/bookService.ts",
      "src/models/book.ts",
      "tests/books.test.ts",
      "tests/auth.test.ts"
    ],
    dependencies: {},
    devDependencies: {},
  }, requirementProtocol);

  assert.ok(stabilized.filesToCreate.includes("src/routes/auth.ts"));
});

test("package scaffold backfills express auth runtime dependencies from requirements when architect deps are empty", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "图书管理系统" },
    requirementProtocol: {
      version: "v1",
      userIntent: {
        title: "图书管理系统",
        requirements: ["需要登录鉴权和图书管理"],
        acceptanceCriteria: [],
      },
      capabilities: {
        frontendRequired: false,
        backendRequired: true,
        authRequired: true,
        auditLogRequired: true,
        dockerRequired: false,
        entities: ["book"],
        crudEntities: ["book"],
        uiCapabilities: ["create", "login"],
      },
    },
    spec: {
      language: "TypeScript",
      framework: "Express.js ^4.18",
      dependencies: {},
      devDependencies: { jest: "^29.7.0" },
      filesToCreate: ["package.json", "src/middleware/auth.ts", "src/index.ts"],
    },
    subTasks: [
      {
        id: "task-package",
        description: "write package",
        fileTarget: "package.json",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      { coder: createCoderAgent("```json\n{}\n```") },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks[0].status, "completed");
    const pkg = JSON.parse(await fs.readFile(`${workspace}/package.json`, "utf-8"));
    assert.equal(pkg.dependencies.express, "^4.18.2");
    assert.equal(pkg.dependencies.cors, "^2.8.5");
    assert.equal(pkg.dependencies.jsonwebtoken, "^9.0.2");
    assert.equal(pkg.devDependencies["@types/jsonwebtoken"], "^9.0.10");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold deterministically generates verify smoke script", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "图书管理系统" },
    requirementProtocol: {
      version: "v1",
      userIntent: {
        title: "图书管理系统",
        requirements: ["需要验证健康检查与图书接口的基本可用性"],
        acceptanceCriteria: [],
      },
      capabilities: {
        frontendRequired: false,
        backendRequired: true,
        authRequired: true,
        auditLogRequired: true,
        dockerRequired: false,
        entities: ["book"],
        crudEntities: ["book"],
        uiCapabilities: ["create", "edit", "delete", "login"],
      },
    },
    apiContract: {
      endpoints: [
        { method: "GET", path: "/api/health" },
        { method: "GET", path: "/api/books" },
        { method: "POST", path: "/api/books" },
      ],
    },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      dependencies: { express: "^4.18.2", cors: "^2.8.5" },
      devDependencies: {
        typescript: "^5.3.3",
        jest: "^29.7.0",
        "ts-jest": "^29.1.1",
        "@types/jest": "^29.5.11",
        "@types/node": "^20.10.0",
      },
      filesToCreate: ["src/index.ts", "scripts/verify.ts"],
    },
    subTasks: [
      {
        id: "task-index-ready",
        description: "index ready",
        fileTarget: "src/index.ts",
        dependencies: [],
        contextRequirement: "none",
        status: "completed",
      },
      {
        id: "task-verify-script",
        description: "write verify script",
        fileTarget: "scripts/verify.ts",
        dependencies: ["src/index.ts"],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            return { content: "```typescript\nexport const unreachable = true;\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(chatCalls, 0);
    assert.equal(result.subTasks.find((task) => task.fileTarget === "scripts/verify.ts").status, "completed");
    const verifyCode = await fs.readFile(`${workspace}/scripts/verify.ts`, "utf-8");
    assert.match(verifyCode, /const baseUrl = process\.env\.VERIFY_BASE_URL \|\| "http:\/\/127\.0\.0\.1:10000"/);
    assert.match(verifyCode, /await requestJson\("\/api\/health"\)/);
    assert.match(verifyCode, /await requestJson\("\/api\/books"\)/);
    assert.match(verifyCode, /process\.exit\(hasFailure \? 1 : 0\)/);
    assert.doesNotMatch(verifyCode, /\.\.\/src\/index/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold deterministically generates docker compose yaml", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "Health Service" },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      dependencies: { express: "^4.18.2", cors: "^2.8.5" },
      devDependencies: { typescript: "^5.3.3" },
      filesToCreate: ["docker-compose.yml"],
    },
    subTasks: [
      {
        id: "task-compose",
        description: "write compose",
        fileTarget: "docker-compose.yml",
        dependencies: [],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            return { content: "```yaml\ndocker-compose up -d --build\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(chatCalls, 0);
    assert.equal(result.subTasks[0].status, "completed");
    const compose = await fs.readFile(`${workspace}/docker-compose.yml`, "utf-8");
    assert.match(compose, /^version:/m);
    assert.match(compose, /services:/);
    assert.match(compose, /health-check-service:/);
    assert.match(compose, /10000:10000/);
    assert.doesNotMatch(compose, /docker-compose up -d --build/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("express template scaffold deterministically generates user controller test", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let chatCalls = 0;
  const state = createBaseState({
    templateId: "express-typescript",
    contract: { title: "User Service" },
    manifest: { services: [{ name: "app", port: 10000 }] },
    spec: {
      language: "TypeScript",
      dependencies: {
        express: "^4.18.2",
        cors: "^2.8.5",
        jsonwebtoken: "^9.0.2",
        mongoose: "^8.0.0",
      },
      devDependencies: {
        typescript: "^5.3.3",
        jest: "^29.7.0",
        "ts-jest": "^29.1.1",
        "@types/jest": "^29.5.11",
        "@types/node": "^20.10.0",
      },
      filesToCreate: ["tests/userController.test.ts"],
    },
    code: JSON.stringify(
      {
        "src/controllers/userController.ts": "export class UserController { static async register() {} static async login() {} }\n",
        "src/models/user.ts": "export interface IUser { username: string; password: string; }\nexport default {};\n",
      },
      null,
      2
    ),
    subTasks: [
      {
        id: "task-user-controller-test",
        description: "write user controller test",
        fileTarget: "tests/userController.test.ts",
        dependencies: ["src/controllers/userController.ts", "src/models/user.ts"],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat() {
            chatCalls += 1;
            return { content: "```typescript\n({ nope: true })\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(chatCalls, 0);
    assert.equal(result.subTasks[0].status, "completed");
    const testCode = await fs.readFile(`${workspace}/tests/userController.test.ts`, "utf-8");
    assert.match(testCode, /describe\("UserController"/);
    assert.match(testCode, /UserController\.register/);
    assert.match(testCode, /UserController\.login/);
    assert.match(testCode, /expect\(res\.status\)/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("test-file repair prompt narrows completed-file context to direct dependencies", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let observedPrompt = "";
  const state = createBaseState({
    retryCount: 1,
    spec: {
      language: "TypeScript",
      filesToCreate: [
        "src/controllers/userController.ts",
        "src/models/user.ts",
        "src/routes/bookRoutes.ts",
        "tests/userController.test.ts",
      ],
    },
    subTasks: [
      {
        id: "task-user-controller-test",
        description: "repair user controller test",
        fileTarget: "tests/userController.test.ts",
        dependencies: ["src/controllers/userController.ts", "src/models/user.ts"],
        contextRequirement: "none",
        status: "pending",
        lastError: "syntax failure",
      },
    ],
    code: JSON.stringify(
      {
        "src/controllers/userController.ts": "export class UserController { static async login() {} static async register() {} }\n",
        "src/models/user.ts": "export interface IUser { username: string; password: string; }\n",
        "src/routes/bookRoutes.ts": "export default {};\n",
      },
      null,
      2
    ),
    qaFailures: {
      failedFiles: ["tests/userController.test.ts"],
      testErrors: ["FAIL tests/userController.test.ts"],
      rootCause: "broken user controller test",
    },
    testResults: "FAIL tests/userController.test.ts\nSyntaxError",
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat(messages) {
            observedPrompt = messages[0]?.content || "";
            return {
              content:
                "```typescript\ndescribe('UserController', () => {\n  it('baseline', () => {\n    expect(true).toBe(true);\n  });\n});\n```",
            };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks[0].status, "completed");
    assert.match(observedPrompt, /测试文件直连上下文/);
    assert.match(observedPrompt, /src\/controllers\/userController\.ts/);
    assert.match(observedPrompt, /src\/models\/user\.ts/);
    assert.doesNotMatch(observedPrompt, /- src\/routes\/bookRoutes\.ts/);
    assert.doesNotMatch(observedPrompt, /已完成的文件列表 - 可安全 import/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("route-file prompt narrows context to declared dependencies and exposes export contracts", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let observedPrompt = "";
  const state = createBaseState({
    retryCount: 1,
    spec: {
      language: "TypeScript",
      filesToCreate: [
        "src/models/user.ts",
        "src/middleware/auth.ts",
        "src/routes/users.ts",
        "src/routes/bookRoutes.ts",
      ],
    },
    subTasks: [
      {
        id: "task-users-route",
        description: "repair users route",
        fileTarget: "src/routes/users.ts",
        dependencies: ["src/models/user.ts", "src/middleware/auth.ts"],
        contextRequirement: "none",
        status: "pending",
        lastError: "missing exports",
      },
    ],
    code: JSON.stringify(
      {
        "src/models/user.ts": "export class User {}\nexport function findAllUsers() { return []; }\n",
        "src/middleware/auth.ts": "export function authMiddleware(_req, _res, next) { next(); }\n",
        "src/routes/bookRoutes.ts": "export default {};\n",
      },
      null,
      2
    ),
    qaFailures: {
      failedFiles: ["src/routes/users.ts"],
      testErrors: ["TS2305 missing exports"],
      rootCause: "route guessed imports",
    },
    testResults: "TS2305 missing exports",
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat(messages) {
            observedPrompt = messages[0]?.content || "";
            return {
              content:
                "```typescript\nimport { Router, Request, Response } from \"express\";\nimport { findAllUsers } from \"../models/user\";\nimport { authMiddleware } from \"../middleware/auth\";\nconst router = Router();\nrouter.get(\"/\", authMiddleware, (_req: Request, res: Response) => {\n  res.status(200).json({ success: true, data: findAllUsers() });\n});\nexport default router;\n```",
            };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks[0].status, "completed");
    assert.match(observedPrompt, /src\/models\/user\.ts/);
    assert.match(observedPrompt, /src\/middleware\/auth\.ts/);
    assert.match(observedPrompt, /依赖文件导出契约/);
    assert.match(observedPrompt, /findAllUsers/);
    assert.match(observedPrompt, /authMiddleware/);
    assert.doesNotMatch(observedPrompt, /- src\/routes\/bookRoutes\.ts/);
    assert.doesNotMatch(observedPrompt, /已完成的文件列表 - 可安全 import/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("route-file generation fails fast when imports drift from dependency exports", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    spec: {
      language: "TypeScript",
      filesToCreate: ["src/routes/users.ts"],
    },
    subTasks: [
      {
        id: "task-users-route",
        description: "write users route",
        fileTarget: "src/routes/users.ts",
        dependencies: ["src/models/user.ts", "src/middleware/auth.ts"],
        contextRequirement: "none",
        status: "pending",
      },
    ],
    code: JSON.stringify(
      {
        "src/models/user.ts":
          "export class User {}\nexport function findAllUsers() { return []; }\n",
        "src/middleware/auth.ts":
          "export function authMiddleware(_req, _res, next) { next(); }\n",
      },
      null,
      2
    ),
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: createCoderAgent(
          "```typescript\nimport { Router } from \"express\";\nimport { User, users } from \"../models/user\";\nimport { authenticate, requireAdmin } from \"../middleware/auth\";\nconst router = Router();\nrouter.get(\"/\", authenticate, requireAdmin, (_req, res) => {\n  res.json({ success: true, data: users });\n});\nexport default router;\n```"
        ),
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks[0].status, "failed");
    assert.match(result.subTasks[0].lastError, /依赖导出契约校验失败/);
    assert.match(result.subTasks[0].lastError, /src\/models\/user\.ts 未导出 users/);
    assert.match(result.subTasks[0].lastError, /src\/middleware\/auth\.ts 未导出 authenticate/);
    assert.match(result.subTasks[0].lastError, /src\/middleware\/auth\.ts 未导出 requireAdmin/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder revisits deferred route tasks after model middleware and controller dependencies are generated", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    spec: {
      language: "TypeScript",
      filesToCreate: [
        "src/routes/userRoutes.ts",
        "src/controllers/userController.ts",
        "src/models/userModel.ts",
        "src/middleware/authMiddleware.ts",
      ],
    },
    subTasks: [
      {
        id: "task-route",
        description: "write routes",
        fileTarget: "src/routes/userRoutes.ts",
        dependencies: ["src/index.ts"],
        contextRequirement: "route layer",
        status: "pending",
      },
      {
        id: "task-controller",
        description: "write controller",
        fileTarget: "src/controllers/userController.ts",
        dependencies: ["src/routes/userRoutes.ts"],
        contextRequirement: "controller layer",
        status: "pending",
      },
      {
        id: "task-model",
        description: "write model",
        fileTarget: "src/models/userModel.ts",
        dependencies: [],
        contextRequirement: "model layer",
        status: "pending",
      },
      {
        id: "task-auth",
        description: "write auth middleware",
        fileTarget: "src/middleware/authMiddleware.ts",
        dependencies: ["src/controllers/userController.ts"],
        contextRequirement: "middleware layer",
        status: "pending",
      },
    ],
    code: JSON.stringify(
      {
        "src/index.ts": "export default {};\n",
      },
      null,
      2
    ),
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat(messages) {
            const prompt = messages[0]?.content || "";
            if (prompt.includes("src/models/userModel.ts")) {
              return {
                content:
                  "```typescript\nexport interface IUser { username: string; }\nconst User = { find: async () => [] as IUser[] };\nexport default User;\n```",
              };
            }
            if (prompt.includes("src/middleware/authMiddleware.ts")) {
              return {
                content:
                  "```typescript\nimport { Request, Response, NextFunction } from \"express\";\nexport function authenticate(_req: Request, _res: Response, next: NextFunction): void { next(); }\nexport function authorizeAdmin(_req: Request, _res: Response, next: NextFunction): void { next(); }\n```",
              };
            }
            if (prompt.includes("src/controllers/userController.ts")) {
              return {
                content:
                  "```typescript\nimport { Request, Response } from \"express\";\nimport User from \"../models/userModel\";\nexport async function getUsers(_req: Request, res: Response): Promise<void> { const users = await User.find(); res.status(200).json({ success: true, data: users }); }\nexport async function register(_req: Request, res: Response): Promise<void> { res.status(201).json({ success: true }); }\nexport async function login(_req: Request, res: Response): Promise<void> { res.status(200).json({ success: true }); }\nexport async function getLogs(_req: Request, res: Response): Promise<void> { res.status(200).json({ success: true, data: [] }); }\nexport async function assignPermissions(_req: Request, res: Response): Promise<void> { res.status(200).json({ success: true }); }\n```",
              };
            }
            return {
              content:
                "```typescript\nimport { Router } from \"express\";\nimport { register, login, getUsers, getLogs, assignPermissions } from \"../controllers/userController\";\nimport { authenticate, authorizeAdmin } from \"../middleware/authMiddleware\";\nconst router = Router();\nrouter.post(\"/register\", register);\nrouter.post(\"/login\", login);\nrouter.get(\"/users\", authenticate, authorizeAdmin, getUsers);\nrouter.get(\"/logs\", authenticate, authorizeAdmin, getLogs);\nrouter.post(\"/permissions\", authenticate, authorizeAdmin, assignPermissions);\nexport default router;\n```",
            };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks.find((task) => task.fileTarget === "src/routes/userRoutes.ts").status, "completed");
    assert.equal(result.subTasks.find((task) => task.fileTarget === "src/controllers/userController.ts").status, "completed");
    assert.equal(result.subTasks.find((task) => task.fileTarget === "src/models/userModel.ts").status, "completed");
    assert.equal(result.subTasks.find((task) => task.fileTarget === "src/middleware/authMiddleware.ts").status, "completed");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("service-file prompt injects only compact relevant API contract instead of the full spec dump", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let capturedPrompt = "";
  const spec = {
    language: "TypeScript",
    framework: "Express.js ^4.18",
    filesToCreate: [
      "src/models/book.ts",
      "src/repositories/bookRepository.ts",
      "src/services/bookService.ts",
    ],
  };
  const state = createBaseState({
    spec,
    executionProtocol: buildExecutionProtocol(
      spec,
      { services: [{ name: "app", port: 4000 }], environment: {}, sharedConfig: {} },
      {
        endpoints: [
          {
            path: "/api/books",
            method: "GET",
            description: "图书列表",
            responses: {
              "200": {
                success: true,
                data: [{ id: "book-1", title: "Domain-Driven Design" }],
              },
            },
          },
          {
            path: "/api/books/:id/borrow",
            method: "PATCH",
            description: "借阅图书",
            responses: {
              "200": {
                success: true,
                data: { id: "book-1", status: "borrowed" },
              },
            },
          },
          {
            path: "/api/auth/login",
            method: "POST",
            description: "用户登录",
            responses: {
              "200": {
                success: true,
                data: { token: "secret-token", profile: { role: "admin" } },
              },
            },
          },
        ],
      }
    ),
    apiContract: {
      endpoints: [
        {
          path: "/api/books",
          method: "GET",
          description: "图书列表",
          request: {
            query: { status: "available" },
          },
          responses: {
            "200": {
              success: true,
              data: [{ id: "book-1", title: "Domain-Driven Design" }],
            },
          },
        },
        {
          path: "/api/books/:id/borrow",
          method: "PATCH",
          description: "借阅图书",
          request: {
            params: { id: "book-1" },
            headers: { "if-match": "1" },
          },
          responses: {
            "200": {
              success: true,
              data: { id: "book-1", status: "borrowed" },
            },
          },
        },
        {
          path: "/api/auth/login",
          method: "POST",
          description: "用户登录",
          request: {
            body: { username: "admin", password: "secret" },
          },
          responses: {
            "200": {
              success: true,
              data: { token: "secret-token", profile: { role: "admin" } },
            },
          },
        },
      ],
    },
    subTasks: [
      {
        id: "task-model",
        description: "book model",
        fileTarget: "src/models/book.ts",
        dependencies: [],
        contextRequirement: "model",
        status: "completed",
      },
      {
        id: "task-repo",
        description: "book repo",
        fileTarget: "src/repositories/bookRepository.ts",
        dependencies: [],
        contextRequirement: "repo",
        status: "completed",
      },
      {
        id: "task-service",
        description: "book service",
        fileTarget: "src/services/bookService.ts",
        dependencies: ["src/models/book.ts", "src/repositories/bookRepository.ts"],
        contextRequirement: "service",
        status: "pending",
      },
    ],
    code: JSON.stringify(
      {
        "src/models/book.ts": "export interface Book { id: string; title: string; status: 'available' | 'borrowed'; }\n",
        "src/repositories/bookRepository.ts": "export class BookRepository { async list() { return []; } }\n",
      },
      null,
      2
    ),
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat(messages) {
            capturedPrompt = messages[0]?.content || "";
            return {
              content:
                "```typescript\nexport class BookService {\n  async listBooks(): Promise<unknown[]> {\n    return [];\n  }\n}\nexport default BookService;\n```",
            };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks.find((task) => task.fileTarget === "src/services/bookService.ts").status, "completed");
    assert.match(capturedPrompt, /\/api\/books/);
    assert.match(capturedPrompt, /\/api\/books\/:id\/borrow/);
    assert.doesNotMatch(capturedPrompt, /\/api\/auth\/login/);
    assert.doesNotMatch(capturedPrompt, /Domain-Driven Design/);
    assert.doesNotMatch(capturedPrompt, /secret-token/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder uses a compact execution brief instead of the full shared system context", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let capturedBrief = [];
  const state = createBaseState({
    spec: {
      language: "TypeScript",
      framework: "Express.js ^4.18",
      filesToCreate: ["src/models/book.ts"],
    },
    consensusCore: {
      projectTitle: "图书管理系统",
      requirements: ["需要前端页面和后端 API"],
      architectureSummary: "summary",
      techStack: "TypeScript + Express",
      framework: "Express",
      port: 4000,
      coreDependencies: { express: "^4.18.2" },
      coreDevDependencies: { typescript: "^5.0.0" },
      criticalDecisions: ["先做最小骨架", "阶段验证后补外围文件"],
    },
    consensusProgress: {
      completedFiles: ["package.json", "tsconfig.json", "src/models/book.ts"],
      pendingFiles: ["README.md", "public/index.html", "tests/books.test.ts", "Dockerfile"],
      currentRound: 0,
      openIssues: ["等待环境验证", "等待部署脚本"],
    },
    customerApprovalState: {
      version: "v1",
      autoApprove: { requirements: false, solution: false, deploy: false },
      checkpoints: [
        { stage: "requirements", required: true, approved: false, summary: "需求待确认" },
        { stage: "solution", required: true, approved: false, summary: "方案待确认" },
        { stage: "deploy", required: true, approved: false, summary: "部署待确认" },
      ],
    },
    subTasks: [
      {
        id: "task-model",
        description: "book model",
        fileTarget: "src/models/book.ts",
        dependencies: [],
        contextRequirement: "model",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat(_messages, _onEvent, options) {
            capturedBrief = options?.brief || [];
            return { content: "```typescript\nexport interface Book { id: string; }\nexport default Book;\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    const compactBrief = capturedBrief.join("\n");
    const fullContext = buildSystemContext(state).join("\n");
    assert.equal(result.subTasks[0].status, "completed");
    assert.equal(compactBrief.length < fullContext.length, true);
    assert.doesNotMatch(compactBrief, /\[客户确认\]/);
    assert.doesNotMatch(compactBrief, /\[方案覆盖\]/);
    assert.doesNotMatch(compactBrief, /待完成：README\.md, public\/index\.html/);
    assert.match(compactBrief, /\[Coder 执行上下文\]/);
    assert.match(compactBrief, /执行阶段：首轮核心骨架/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder prompt uses compact task spec summary instead of serializing the full spec", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let capturedPrompt = "";
  const state = createBaseState({
    spec: {
      language: "TypeScript",
      framework: "Express.js ^4.18",
      testCommand: "npm test",
      runCommand: "npm start",
      entryPoint: "src/index.ts",
      filesToCreate: [
        "package.json",
        "tsconfig.json",
        "src/index.ts",
        "src/models/book.ts",
        "src/services/bookService.ts",
        "src/controllers/bookController.ts",
        "src/routes/books.ts",
        "tests/books.test.ts",
      ],
      dependencies: { express: "^4.18.2", cors: "^2.8.5" },
      devDependencies: { typescript: "^5.0.0", jest: "^29.7.0" },
    },
    subTasks: [
      {
        id: "task-model",
        description: "book model",
        fileTarget: "src/models/book.ts",
        dependencies: [],
        contextRequirement: "model",
        status: "completed",
      },
      {
        id: "task-service",
        description: "book service",
        fileTarget: "src/services/bookService.ts",
        dependencies: ["src/models/book.ts"],
        contextRequirement: "service",
        status: "pending",
      },
    ],
    code: JSON.stringify({
      "src/models/book.ts": "export interface Book { id: string; }\n",
    }),
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat(messages) {
            capturedPrompt = messages[0]?.content || "";
            return { content: "```typescript\nexport const listBooks = async () => [];\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks.find((task) => task.fileTarget === "src/services/bookService.ts").status, "completed");
    assert.match(capturedPrompt, /\[任务规范摘要\]/);
    assert.match(capturedPrompt, /"declaredFiles"/);
    assert.doesNotMatch(capturedPrompt, /"filesToCreate"/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder narrows oversized auth service dependencies to same-domain helper services", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let capturedPrompt = "";
  const state = createBaseState({
    spec: {
      language: "TypeScript",
      framework: "Express.js ^4.18",
      testCommand: "npm test",
      runCommand: "npm start",
      entryPoint: "src/index.ts",
      filesToCreate: [
        "src/errors.ts",
        "src/logging/logger.ts",
        "src/models/book.ts",
        "src/services/authSessionService.ts",
        "src/services/authCredentialService.ts",
        "src/services/authAccountPolicyService.ts",
        "src/services/authService.ts",
      ],
      dependencies: { express: "^4.18.2" },
      devDependencies: { typescript: "^5.0.0" },
    },
    subTasks: [
      {
        id: "task-errors",
        description: "errors",
        fileTarget: "src/errors.ts",
        dependencies: [],
        contextRequirement: "errors",
        status: "completed",
      },
      {
        id: "task-logger",
        description: "logger",
        fileTarget: "src/logging/logger.ts",
        dependencies: ["src/errors.ts"],
        contextRequirement: "logger",
        status: "completed",
      },
      {
        id: "task-book-model",
        description: "book model",
        fileTarget: "src/models/book.ts",
        dependencies: ["src/errors.ts"],
        contextRequirement: "model",
        status: "completed",
      },
      {
        id: "task-auth-session",
        description: "auth session",
        fileTarget: "src/services/authSessionService.ts",
        dependencies: ["src/errors.ts", "src/logging/logger.ts"],
        contextRequirement: "session",
        status: "completed",
      },
      {
        id: "task-auth-credential",
        description: "auth credential",
        fileTarget: "src/services/authCredentialService.ts",
        dependencies: ["src/errors.ts", "src/logging/logger.ts"],
        contextRequirement: "credential",
        status: "completed",
      },
      {
        id: "task-auth-policy",
        description: "auth policy",
        fileTarget: "src/services/authAccountPolicyService.ts",
        dependencies: ["src/errors.ts", "src/logging/logger.ts"],
        contextRequirement: "policy",
        status: "completed",
      },
      {
        id: "task-auth",
        description: "auth service",
        fileTarget: "src/services/authService.ts",
        dependencies: ["src/errors.ts", "src/logging/logger.ts"],
        contextRequirement: "auth facade",
        status: "pending",
      },
    ],
    code: JSON.stringify({
      "src/errors.ts": "export class AppError extends Error {}\n",
      "src/logging/logger.ts": "export const requestLogger = () => undefined;\n",
      "src/models/book.ts": "export interface Book { id: string; }\n",
      "src/services/authSessionService.ts": "export const createSession = () => ({ token: 'x' });\n",
      "src/services/authCredentialService.ts": "export const verifyPassword = () => true;\n",
      "src/services/authAccountPolicyService.ts": "export const ensureActive = () => true;\n",
    }),
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat(messages) {
            capturedPrompt = messages[0]?.content || "";
            return { content: "```typescript\nexport const authService = {};\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks.find((task) => task.fileTarget === "src/services/authService.ts").status, "completed");
    assert.match(capturedPrompt, /authSessionService/);
    assert.match(capturedPrompt, /authCredentialService/);
    assert.match(capturedPrompt, /authAccountPolicyService/);
    assert.doesNotMatch(capturedPrompt, /src\/models\/book\.ts/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder converts a single-file model timeout into a blocking task failure instead of hanging indefinitely", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    coderTaskTimeoutMs: 30,
    subTasks: [
      {
        id: "task-timeout",
        description: "slow service",
        fileTarget: "src/services/bookService.ts",
        dependencies: [],
        contextRequirement: "service",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat(_messages, _onEvent, options) {
            return await new Promise((_resolve, reject) => {
              options.signal.addEventListener("abort", () => {
                reject(options.signal.reason || new Error("aborted"));
              }, { once: true });
            });
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks[0].status, "failed");
    assert.match(result.subTasks[0].lastError || "", /单文件生成超时/);
    assert.match(result.blockedReason || "", /单文件生成超时/);
    assert.equal(result.qaFailures.failedFiles.includes("src/services/bookService.ts"), true);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder aborts oversized service generation early when no write_file occurs before first-write deadline", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    coderTaskTimeoutMs: 200,
    coderFirstWriteTimeoutMs: 30,
    subTasks: [
      {
        id: "task-timeout",
        description: "slow service",
        fileTarget: "src/services/bookService.ts",
        dependencies: [],
        contextRequirement: "service",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat(_messages, _onEvent, options) {
            return await new Promise((_resolve, reject) => {
              options.signal.addEventListener("abort", () => {
                reject(options.signal.reason || new Error("aborted"));
              }, { once: true });
            });
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.subTasks[0].status, "failed");
    assert.match(result.subTasks[0].lastError || "", /首个写入超时/);
    assert.match(result.blockedReason || "", /首个写入超时/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder detects dependency deadlock instead of spinning forever when subtasks form a cycle", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    subTasks: [
      {
        id: "task-a",
        description: "a waits on b",
        fileTarget: "src/a.ts",
        dependencies: ["src/b.ts"],
        contextRequirement: "none",
        status: "pending",
      },
      {
        id: "task-b",
        description: "b waits on a",
        fileTarget: "src/b.ts",
        dependencies: ["src/a.ts"],
        contextRequirement: "none",
        status: "pending",
      },
    ],
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: createCoderAgent("```typescript\nexport const value = 1;\n```"),
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.match(result.blockedReason || "", /依赖死锁|src\/a\.ts/);
    assert.match(result.testResults || "", /Coder 阻塞失败|依赖死锁/);
    assert.equal(result.qaFailures.failedFiles.includes("src/a.ts"), true);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder does not treat completed task-id dependencies as deadlock", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    subTasks: [
      {
        id: "task-package",
        description: "package file",
        fileTarget: "package.json",
        dependencies: [],
        contextRequirement: "none",
        status: "completed",
      },
      {
        id: "task-entry",
        description: "entry file",
        fileTarget: "src/index.ts",
        dependencies: ["task-package"],
        contextRequirement: "write entry",
        status: "pending",
      },
    ],
    code: JSON.stringify({
      "package.json": JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2),
    }),
  });

  try {
    const result = await coderNode(
      state,
      {
        coder: createCoderAgent("```typescript\nexport const app = {};\n```"),
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    const entryTask = result.subTasks.find((task) => task.id === "task-entry");
    assert.equal(entryTask.status, "completed");
    assert.equal(result.blockedReason, "");
    assert.equal(result.qaFailures, null);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("coder execution brief resolves task-id dependencies into file targets", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let capturedBrief = [];
  const state = createBaseState({
    subTasks: [
      {
        id: "task-package",
        description: "package file",
        fileTarget: "package.json",
        dependencies: [],
        contextRequirement: "none",
        status: "completed",
      },
      {
        id: "task-entry",
        description: "entry file",
        fileTarget: "src/index.ts",
        dependencies: ["task-package"],
        contextRequirement: "write entry",
        status: "pending",
      },
    ],
    code: JSON.stringify({
      "package.json": JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2),
    }),
  });

  try {
    await coderNode(
      state,
      {
        coder: {
          getPersona() {
            return { name: "测试Coder" };
          },
          async chat(_messages, _onEvent, options) {
            capturedBrief = options?.brief || [];
            return { content: "```typescript\nexport const app = {};\n```" };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    const brief = capturedBrief.join("\n");
    assert.match(brief, /directDependencies：package\.json/);
    assert.doesNotMatch(brief, /task-package/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
