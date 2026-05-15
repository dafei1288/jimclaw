const test = require("node:test");
const assert = require("node:assert/strict");

require("ts-node/register/transpile-only");

const { buildDockerExecArgs } = require("../../src/core/logic_utils");

test("container exec preserves shell command as one argv item", () => {
  const args = buildDockerExecArgs("abc123", "npm install --loglevel=error");

  assert.deepEqual(args, [
    "exec",
    "-w",
    "/app",
    "abc123",
    "sh",
    "-c",
    "npm install --loglevel=error",
  ]);
  assert.equal(args.some((item) => item.includes('"npm install')), false);
});

test("background container exec uses detached docker exec argv form", () => {
  const args = buildDockerExecArgs("abc123", "npm start", { background: true });

  assert.deepEqual(args, [
    "exec",
    "-d",
    "-w",
    "/app",
    "abc123",
    "sh",
    "-c",
    "npm start",
  ]);
});
