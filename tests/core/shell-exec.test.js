require("ts-node/register/transpile-only");

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("child_process");

test("shell exec converts synchronous spawn EPERM into command failure output", async () => {
  const originalSpawn = childProcess.spawn;
  delete require.cache[require.resolve("../../src/skills/shell_exec")];

  childProcess.spawn = () => {
    const error = new Error("spawn EPERM");
    error.code = "EPERM";
    throw error;
  };

  try {
    const { ShellExecuteSkill } = require("../../src/skills/shell_exec");
    const result = await ShellExecuteSkill.config.run({
      command: "docker run hello-world",
      workDir: process.cwd(),
    });
    assert.match(result, /Command failed with error: spawn EPERM/);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[require.resolve("../../src/skills/shell_exec")];
  }
});
