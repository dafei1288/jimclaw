require("ts-node/register/transpile-only");

const test = require("node:test");
const assert = require("node:assert/strict");

const { ModelManager } = require("../../src/utils/models");

test("model manager adds implicit cross-provider fallback modes for single-model agents", () => {
  const models = ModelManager.createModelSetForAgent("pm");

  assert.equal(models.has("default"), true);
  assert.equal(models.has("reasoning"), true);
  assert.equal(models.has("coding"), true);
});
