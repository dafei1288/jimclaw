const test = require("node:test");
const assert = require("node:assert/strict");

require("ts-node/register/transpile-only");

const {
  buildDeploymentUrls,
  buildDeployLaunchCommand,
  getHealthCheckPath,
  getDeployPreconditionFailure,
} = require("../../src/core/nodes/deploy_node");

test("deploy health check uses localhost while preserving public url for display", () => {
  const result = buildDeploymentUrls("100.74.126.56", "4001");

  assert.equal(result.publicUrl, "http://100.74.126.56:4001");
  assert.equal(result.healthCheckUrl, "http://127.0.0.1:4001");
});

test("deploy launch command persists pid and startup log paths", () => {
  const command = buildDeployLaunchCommand("npm start");

  assert.match(command, /server\.pid/);
  assert.match(command, /server\.log/);
  assert.match(command, /nohup sh -c "npm start"/);
});

test("deploy health check path prefers protocol runtime then dedicated health endpoints", () => {
  const path = getHealthCheckPath({
    apiContract: {
      endpoints: [
        { method: "POST", path: "/api/login" },
        { method: "GET", path: "/api/health" },
      ],
    },
  });

  assert.equal(path, "/api/health");
  assert.equal(
    getHealthCheckPath({
      executionProtocol: { runtime: { healthCheckPath: "/api/health" } },
      apiContract: { endpoints: [{ method: "GET", path: "/api/books" }] },
    }),
    "/api/health"
  );
  assert.equal(
    getHealthCheckPath({
      apiContract: { endpoints: [{ method: "GET", path: "/health" }] },
    }),
    "/health"
  );
  assert.equal(getHealthCheckPath({ apiContract: { endpoints: [] } }), "/");
});

test("deploy precondition failure blocks deploy when current infra state already failed", () => {
  assert.match(
    getDeployPreconditionFailure({
      containerId: "jimclaw-test",
      lastFailedNode: "infra_setup",
      lastFailureSummary: "[基础设施构建失败] docker-compose 构建错误",
    }) || "",
    /基础设施构建/
  );

  assert.match(
    getDeployPreconditionFailure({
      containerId: "jimclaw-test",
      lastFailedNode: "infra_setup",
      lastFailureSummary: "failed to connect to the docker API at npipe",
    }) || "",
    /Docker 守护进程/
  );

  assert.equal(
    getDeployPreconditionFailure({
      containerId: "jimclaw-test",
      testResults: "[基础设施构建失败] 这是历史日志，不应继续阻塞当前 deploy",
      lastFailedNode: "",
      lastFailureSummary: "",
    }),
    null
  );

  assert.match(
    getDeployPreconditionFailure({
      containerId: "",
      lastFailedNode: "",
      lastFailureSummary: "",
    }) || "",
    /未获得可用容器/
  );

  assert.equal(
    getDeployPreconditionFailure({
      containerId: "jimclaw-test",
      lastFailedNode: "",
      lastFailureSummary: "",
    }),
    null
  );
});
