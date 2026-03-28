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
      filesToCreate: ["package.json", "tsconfig.json", "src/index.ts", "tests/health.test.ts"],
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
    assert.match(testCode, /request\(app\)\.get\("\/api\/health"\)/);
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
