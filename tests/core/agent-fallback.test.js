const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const {
  createTempWorkspace,
  removeTempWorkspace,
} = require("./test-helpers");
const { BaseAgent } = require("../../src/core/agent");

function createFakeModel(invokeImpl) {
  return {
    bindTools() {
      return this;
    },
    async invoke(messages) {
      return invokeImpl(messages);
    },
  };
}

function createRateLimitError(message = "429 balance exhausted") {
  const error = new Error(message);
  error.status = 429;
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
