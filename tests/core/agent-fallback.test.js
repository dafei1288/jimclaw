const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const {
  createTempWorkspace,
  removeTempWorkspace,
} = require("./test-helpers");
const { BaseAgent, AgentResourceExhaustedError } = require("../../src/core/agent");

function createFakeModel(invokeImpl) {
  return {
    bindTools() {
      return this;
    },
    async invoke(messages, options) {
      return invokeImpl(messages, options);
    },
  };
}

function createRateLimitError(message = "429 balance exhausted") {
  const error = new Error(message);
  error.status = 429;
  return error;
}

function createQuotaError(message = "403 用户额度不足") {
  const error = new Error(message);
  error.status = 403;
  error.code = "insufficient_user_quota";
  error.type = "rix_api_error";
  return error;
}

test("base agent falls back to alternate model after retryable default model failure", async () => {
  const workspace = await createTempWorkspace();
  let defaultCalls = 0;
  let codingCalls = 0;

  const agent = new BaseAgent(
    {
      name: "回退测试Agent",
      role: "测试",
      specialty: "验证模型容灾",
      personality: "严谨",
    },
    [],
    new Map([
      ["default", createFakeModel(async () => {
        defaultCalls += 1;
        throw createRateLimitError();
      })],
      ["coding", createFakeModel(async () => {
        codingCalls += 1;
        return { content: "fallback ok", tool_calls: [] };
      })],
    ])
  );

  try {
    const response = await agent.chat(
      [{ role: "user", content: "请输出一条测试消息" }],
      undefined,
      { workspaceDir: workspace }
    );

    assert.equal(response.content, "fallback ok");
    assert.equal(defaultCalls, 3);
    assert.equal(codingCalls, 1);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("base agent records token usage metadata into workspace summary", async () => {
  const workspace = await createTempWorkspace();

  const agent = new BaseAgent(
    {
      name: "用量测试Agent",
      role: "测试",
      specialty: "验证 token 记账",
      personality: "严谨",
    },
    [],
    new Map([
      ["default", createFakeModel(async () => ({
        content: "usage ok",
        tool_calls: [],
        usage_metadata: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
        },
        response_metadata: {
          model_name: "glm-5",
        },
      }))],
    ])
  );

  try {
    await agent.chat(
      [{ role: "user", content: "统计这次调用的 token" }],
      undefined,
      { workspaceDir: workspace, mode: "coding" }
    );

    const usage = JSON.parse(await fs.readFile(`${workspace}/token-usage.json`, "utf-8"));
    assert.equal(usage.summary.calls, 1);
    assert.equal(usage.summary.inputTokens, 11);
    assert.equal(usage.summary.outputTokens, 7);
    assert.equal(usage.summary.totalTokens, 18);
    assert.equal(usage.summary.byAgent["用量测试Agent"].calls, 1);
    assert.equal(usage.summary.byAgent["用量测试Agent"].totalTokens, 18);
    assert.equal(usage.entries[0].mode, "default");
    assert.equal(usage.entries[0].model, "glm-5");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("base agent aborts a hanging model call when timeoutMs elapses", async () => {
  const workspace = await createTempWorkspace();
  let calls = 0;
  let aborted = false;

  const agent = new BaseAgent(
    {
      name: "超时测试Agent",
      role: "测试",
      specialty: "验证真超时",
      personality: "严谨",
    },
    [],
    new Map([
      ["default", createFakeModel(async (_messages, options) => {
        calls += 1;
        return await new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            aborted = true;
            reject(options.signal.reason || new Error("aborted"));
          }, { once: true });
        });
      })],
    ])
  );

  try {
    await assert.rejects(
      () => agent.chat(
        [{ role: "user", content: "请一直等待" }],
        undefined,
        { workspaceDir: workspace, timeoutMs: 30 }
      ),
      /超时/
    );
    assert.equal(calls, 1);
    assert.equal(aborted, true);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("base agent raises resumable service-unavailable error after exhausting retryable connection failures", async () => {
  const workspace = await createTempWorkspace();
  let defaultCalls = 0;
  let codingCalls = 0;

  const createConnectionError = () => {
    const error = new Error("Connection error.");
    error.code = "EACCES";
    error.cause = { code: "EACCES" };
    return error;
  };

  const agent = new BaseAgent(
    {
      name: "服务不可用测试Agent",
      role: "测试",
      specialty: "验证模型不可用挂起",
      personality: "严谨",
    },
    [],
    new Map([
      ["default", createFakeModel(async () => {
        defaultCalls += 1;
        throw createConnectionError();
      })],
      ["coding", createFakeModel(async () => {
        codingCalls += 1;
        throw createConnectionError();
      })],
    ])
  );

  try {
    await assert.rejects(
      () => agent.chat(
        [{ role: "user", content: "请继续执行" }],
        undefined,
        { workspaceDir: workspace, mode: "coding" }
      ),
      (error) => {
        assert.equal(error.name, "AgentServiceUnavailableError");
        assert.match(error.message, /模型服务暂不可用|Connection error/i);
        return true;
      }
    );
    assert.ok(defaultCalls + codingCalls >= 2);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("base agent can fail fast for deterministic-fallback callers", async () => {
  const workspace = await createTempWorkspace();
  let defaultCalls = 0;
  let codingCalls = 0;

  const createConnectionError = () => {
    const error = new Error("Connection error.");
    error.code = "EACCES";
    return error;
  };

  const agent = new BaseAgent(
    {
      name: "快速降级Agent",
      role: "测试",
      specialty: "验证确定性降级快速失败",
      personality: "严谨",
    },
    [],
    new Map([
      ["default", createFakeModel(async () => {
        defaultCalls += 1;
        throw createConnectionError();
      })],
      ["coding", createFakeModel(async () => {
        codingCalls += 1;
        throw createConnectionError();
      })],
    ])
  );

  try {
    await assert.rejects(
      () => agent.chat(
        [{ role: "user", content: "请快速失败，让节点使用确定性降级" }],
        undefined,
        { workspaceDir: workspace, retryAttempts: 1, fallbackModeLimit: 1 }
      ),
      (error) => {
        assert.equal(error.name, "AgentServiceUnavailableError");
        return true;
      }
    );
    assert.equal(defaultCalls, 1);
    assert.equal(codingCalls, 0);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("base agent falls back to alternate model after quota exhaustion", async () => {
  const workspace = await createTempWorkspace();
  let defaultCalls = 0;
  let codingCalls = 0;

  const agent = new BaseAgent(
    {
      name: "额度回退测试Agent",
      role: "测试",
      specialty: "验证 quota fallback",
      personality: "严谨",
    },
    [],
    new Map([
      ["default", createFakeModel(async () => {
        defaultCalls += 1;
        throw createQuotaError();
      })],
      ["coding", createFakeModel(async () => {
        codingCalls += 1;
        return { content: "quota fallback ok", tool_calls: [] };
      })],
    ])
  );

  try {
    const response = await agent.chat(
      [{ role: "user", content: "请在额度耗尽时切换备用模型" }],
      undefined,
      { workspaceDir: workspace, mode: "default" }
    );

    assert.equal(response.content, "quota fallback ok");
    assert.equal(defaultCalls, 1);
    assert.equal(codingCalls, 1);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("base agent raises resumable resource-exhausted error after all fallback models hit quota", async () => {
  const workspace = await createTempWorkspace();

  const agent = new BaseAgent(
    {
      name: "额度耗尽测试Agent",
      role: "测试",
      specialty: "验证 quota 挂起",
      personality: "严谨",
    },
    [],
    new Map([
      ["default", createFakeModel(async () => { throw createQuotaError(); })],
      ["coding", createFakeModel(async () => { throw createQuotaError("403 quota exhausted"); })],
    ])
  );

  try {
    await assert.rejects(
      () => agent.chat(
        [{ role: "user", content: "请继续执行" }],
        undefined,
        { workspaceDir: workspace, mode: "coding" }
      ),
      (error) => {
        assert.equal(error instanceof AgentResourceExhaustedError, true);
        assert.equal(error.name, "AgentResourceExhaustedError");
        assert.match(error.message, /额度|quota/i);
        return true;
      }
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("base agent treats aborted upstream requests as resumable service unavailability", async () => {
  const workspace = await createTempWorkspace();

  const agent = new BaseAgent(
    {
      name: "Abort测试Agent",
      role: "测试",
      specialty: "验证 aborted 收口",
      personality: "严谨",
    },
    [],
    new Map([
      ["default", createFakeModel(async () => {
        const error = new Error("Request was aborted.");
        error.code = "ABORT_ERR";
        throw error;
      })],
    ])
  );

  try {
    await assert.rejects(
      () => agent.chat(
        [{ role: "user", content: "请继续执行" }],
        undefined,
        { workspaceDir: workspace }
      ),
      (error) => {
        assert.equal(error.name, "AgentServiceUnavailableError");
        assert.match(error.message, /aborted|暂不可用/i);
        return true;
      }
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});
