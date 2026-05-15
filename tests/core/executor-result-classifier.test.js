require("ts-node/register/transpile-only");

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyExecutorFailure,
  mapExecutorFailureToValidationFailure,
} = require("../../src/executor/result_classifier");

test("classifies spawn EPERM as process spawn denied", () => {
  const result = classifyExecutorFailure({
    raw: "Command failed with error: spawn EPERM",
    stdout: "",
    stderr: "",
  });

  assert.equal(result, "process_spawn_denied");
});

test("classifies docker daemon unreachable separately", () => {
  const result = classifyExecutorFailure({
    raw: "failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine",
    stdout: "",
    stderr: "",
  });

  assert.equal(result, "docker_daemon_unreachable");
});

test("classifies command not found / ENOENT separately", () => {
  assert.equal(
    classifyExecutorFailure({
      raw: "Command failed with error: spawn ENOENT",
      stdout: "",
      stderr: "",
    }),
    "command_not_found"
  );

  assert.equal(
    classifyExecutorFailure({
      raw: "'docker' is not recognized as an internal or external command",
      stdout: "",
      stderr: "",
    }),
    "command_not_found"
  );
});

test("classifies timeout and port conflict", () => {
  assert.equal(
    classifyExecutorFailure({
      raw: "Command timed out after 30000ms",
      stdout: "",
      stderr: "",
    }),
    "timeout"
  );

  assert.equal(
    classifyExecutorFailure({
      raw: "listen EADDRINUSE: address already in use :::4000",
      stdout: "",
      stderr: "",
    }),
    "port_conflict"
  );
});

test("maps executor failures into validation failure families", () => {
  assert.equal(mapExecutorFailureToValidationFailure("process_spawn_denied"), "environment_gap");
  assert.equal(mapExecutorFailureToValidationFailure("docker_daemon_unreachable"), "environment_gap");
  assert.equal(mapExecutorFailureToValidationFailure("port_conflict"), "runtime_gap");
  assert.equal(mapExecutorFailureToValidationFailure("runtime_start_failed"), "runtime_gap");
});
