require("ts-node/register/transpile-only");

const test = require("node:test");
const assert = require("node:assert/strict");

const { createExternalExecutorAdapter } = require("../../src/executor/external_executor");
const axios = require("axios");

test("external executor adapter sends requests with an abort signal for long-running commands", async () => {
  let capturedSignal = null;
  const adapter = createExternalExecutorAdapter({
    baseUrl: "http://127.0.0.1:4318",
    fetchImpl: async (_input, init) => {
      capturedSignal = init.signal;
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            backend: "external_executor",
            stdout: "done",
            stderr: "",
            blocked: false,
            retryable: false,
            requiresApproval: false,
          };
        },
      };
    },
  });

  const result = await adapter.execute(
    {
      kind: "install_deps",
      workspace: process.cwd(),
      command: "npm install --silent",
    },
    {
      capabilitySnapshot: {
        version: "v1",
        localShell: { available: false },
        docker: { cliAvailable: false, daemonReachable: false },
        externalExecutor: { available: true, baseUrl: "http://127.0.0.1:4318" },
        network: { outboundAllowed: true },
        backgroundProcess: { available: true },
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(typeof capturedSignal?.aborted, "boolean");
});

test("external executor adapter falls back to axios when fetch is unavailable", async () => {
  const originalPost = axios.post;
  const calls = [];
  axios.post = async (url, body, config) => {
    calls.push({ url, body, config });
    return {
      status: 200,
      data: {
        ok: true,
        backend: "external_executor",
        stdout: "axios-ok",
        stderr: "",
        blocked: false,
        retryable: false,
        requiresApproval: false,
      },
    };
  };

  try {
    const adapter = createExternalExecutorAdapter({
      baseUrl: "http://127.0.0.1:4318",
      timeoutMs: 12345,
    });

    const result = await adapter.execute(
      {
        kind: "install_deps",
        workspace: process.cwd(),
        command: "npm install --silent",
      },
      {
        capabilitySnapshot: {
          version: "v1",
          localShell: { available: false },
          docker: { cliAvailable: false, daemonReachable: false },
          externalExecutor: { available: true, baseUrl: "http://127.0.0.1:4318" },
          network: { outboundAllowed: true },
          backgroundProcess: { available: true },
        },
      }
    );

    assert.equal(result.ok, true);
    assert.equal(result.stdout, "axios-ok");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:4318/execute");
    assert.equal(calls[0].body.intent.command, "npm install --silent");
    assert.equal(calls[0].config.timeout, 12345);
  } finally {
    axios.post = originalPost;
  }
});
