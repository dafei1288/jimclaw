const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const {
  createTempWorkspace,
  removeTempWorkspace,
} = require("./test-helpers");
const { FileWriteSkill } = require("../../src/skills/file_write");

test("file_write accepts relative workspace root and relative file path", async () => {
  const workspace = await createTempWorkspace();
  const originalCwd = process.cwd();
  const originalWorkspaceEnv = process.env.JIMCLAW_WORKSPACE;

  try {
    process.chdir(path.dirname(workspace));
    process.env.JIMCLAW_WORKSPACE = path.relative(process.cwd(), workspace).replace(/\\/g, "/");
    const output = await FileWriteSkill.config.run({
      filePath: "src/config/env.ts",
      content: "export const ok = true;\n",
    });

    assert.match(output, /Successfully wrote to/);
    const written = await fs.readFile(path.join(workspace, "src", "config", "env.ts"), "utf-8");
    assert.equal(written, "export const ok = true;");
  } finally {
    process.chdir(originalCwd);
    if (originalWorkspaceEnv === undefined) {
      delete process.env.JIMCLAW_WORKSPACE;
    } else {
      process.env.JIMCLAW_WORKSPACE = originalWorkspaceEnv;
    }
    await removeTempWorkspace(workspace);
  }
});

test("file_write rejects traversal outside workspace", async () => {
  const workspace = await createTempWorkspace();
  const originalWorkspaceEnv = process.env.JIMCLAW_WORKSPACE;

  try {
    process.env.JIMCLAW_WORKSPACE = workspace;
    await assert.rejects(
      () =>
        FileWriteSkill.config.run({
          filePath: "../escape.txt",
          content: "nope",
        }),
      /安全限制/
    );
  } finally {
    if (originalWorkspaceEnv === undefined) {
      delete process.env.JIMCLAW_WORKSPACE;
    } else {
      process.env.JIMCLAW_WORKSPACE = originalWorkspaceEnv;
    }
    await removeTempWorkspace(workspace);
  }
});
