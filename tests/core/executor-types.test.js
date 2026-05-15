require("ts-node/register/transpile-only");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const executorTypes = require("../../src/executor/types");
const fs = require("node:fs");
const path = require("node:path");
const { createBaseState } = require("./test-helpers");

test("executor types expose expected constants and graph state includes executorState", () => {
  assert.ok(Array.isArray(executorTypes.EXECUTION_INTENT_KINDS));
  assert.ok(executorTypes.EXECUTION_INTENT_KINDS.includes("install_deps"));
  assert.ok(Array.isArray(executorTypes.EXECUTOR_FAILURE_TYPES));
  assert.ok(executorTypes.EXECUTOR_FAILURE_TYPES.includes("executor_unavailable"));
  assert.ok(Array.isArray(executorTypes.APPROVAL_STAGES));
  assert.ok(executorTypes.APPROVAL_STAGES.includes("network_install"));
  const graphTypesSource = fs.readFileSync(path.resolve(__dirname, "../../src/core/graph_types.ts"), "utf-8");
  assert.match(graphTypesSource, /executorState: Annotation<ExecutorState \\| null>/);
  assert.equal(createBaseState().executorState, null);
});
