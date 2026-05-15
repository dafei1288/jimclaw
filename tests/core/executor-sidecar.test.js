require("ts-node/register/transpile-only");

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { createExecutorSidecarApp } = require("../../src/executor/sidecar_server");

async function startTestServer(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test("executor sidecar exposes capabilities endpoint", async () => {
  const app = createExecutorSidecarApp({
    runCommand: async () => {
      throw new Error("should not execute");
    },
  });
  const instance = await startTestServer(app);

  try {
    const response = await fetch(`${instance.baseUrl}/capabilities`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.available, true);
    assert.equal(body.backgroundProcess.available, true);
  } finally {
    await instance.close();
  }
});

test("executor sidecar executes foreground intents and returns structured output", async () => {
  const calls = [];
  const app = createExecutorSidecarApp({
    runCommand: async (intent) => {
      calls.push(intent);
      return {
        ok: true,
        stdout: "installed",
        stderr: "",
        exitCode: 0,
      };
    },
  });
  const instance = await startTestServer(app);

  try {
    const response = await fetch(`${instance.baseUrl}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: {
          kind: "install_deps",
          workspace: "D:/workspace/demo",
          command: "npm install --silent",
        },
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.backend, "external_executor");
    assert.equal(body.stdout, "installed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "npm install --silent");
  } finally {
    await instance.close();
  }
});

test("executor sidecar executes background runtime intents and returns pid artifacts", async () => {
  const app = createExecutorSidecarApp({
    runCommand: async (_intent) => ({
      ok: true,
      stdout: "started",
      stderr: "",
      exitCode: 0,
      artifacts: {
        pidPath: "D:/workspace/demo/.jimclaw/server.pid",
        stdoutLogPath: "D:/workspace/demo/.jimclaw/server.stdout.log",
        stderrLogPath: "D:/workspace/demo/.jimclaw/server.stderr.log",
      },
    }),
  });
  const instance = await startTestServer(app);

  try {
    const response = await fetch(`${instance.baseUrl}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: {
          kind: "start_runtime",
          workspace: "D:/workspace/demo",
          command: "npm run dev",
          background: true,
        },
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.backend, "external_executor");
    assert.equal(body.artifacts.pidPath, "D:/workspace/demo/.jimclaw/server.pid");
    assert.equal(body.artifacts.stdoutLogPath, "D:/workspace/demo/.jimclaw/server.stdout.log");
  } finally {
    await instance.close();
  }
});
