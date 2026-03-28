const test = require("node:test");
const assert = require("node:assert/strict");

require("ts-node/register/transpile-only");

const {
  rewriteComposePortBindings,
  extractComposePrimaryServiceName,
  hasBuildScript,
} = require("../../src/core/nodes/infra_node");

test("docker-compose port rewrite keeps host and container ports aligned with runtime allocation", () => {
  const input = `version: '3.8'

services:
  app:
    ports:
      - "10000:10000"
`;

  const output = rewriteComposePortBindings(input, 4123, 10000);

  assert.match(output, /4123:10000/);
  assert.doesNotMatch(output, /10000:10000/);
});

test("docker-compose service parser resolves the primary service name", () => {
  const input = `version: '3.8'

services:
  health-check-service:
    build:
      context: .
    ports:
      - "10000:10000"
`;

  assert.equal(extractComposePrimaryServiceName(input), "health-check-service");
});

test("package manifest with build script requires infra build step", () => {
  const input = JSON.stringify({
    scripts: {
      build: "tsc",
      start: "node dist/index.js",
    },
  });

  assert.equal(hasBuildScript(input), true);
  assert.equal(hasBuildScript(JSON.stringify({ scripts: { start: "node index.js" } })), false);
});
