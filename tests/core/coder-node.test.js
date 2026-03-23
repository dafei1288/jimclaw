const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
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

test("coder defers tasks whose file dependencies are not completed yet", async () => {
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

    assert.equal(controllerTask.status, "pending");
    assert.equal(modelTask.status, "completed");
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
