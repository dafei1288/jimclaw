require("ts-node/register/transpile-only");

const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeRunHealth } = require("../../src/utils/run_health");

test("run health summary captures pending/timeout/static-fallback counters", () => {
  const boulder = {
    node: "agent_pending",
    traceId: "trace_1",
    state: {
      retryCount: 5,
      lastFailedNode: "qa",
      lastFailureSummary: "阻塞：测试验证未通过（QA 模型兜底）",
      issueTracker: [
        { id: "BUG-COMPILE-1", status: "open" },
        { id: "BUG-123", status: "resolved" },
      ],
      deploymentStatus: { status: "none" },
      isDone: false,
    },
  };
  const traceIndex = {
    traceId: "trace_1",
    lastNode: "agent_pending",
    retryCount: 5,
    timeline: [{ node: "qa" }, { node: "agent_pending" }, { node: "agent_pending" }],
    meetingNotes: [
      { phase: "qa", summary: "qa 节点异常：AgentTimeoutError: 清扬 调用超时（>45000ms）" },
      { phase: "coder", summary: "coder ok" },
    ],
  };

  const summary = summarizeRunHealth("run_1", boulder, traceIndex);
  assert.equal(summary.runName, "run_1");
  assert.equal(summary.status, "failed");
  assert.equal(summary.agentPendingCount, 2);
  assert.equal(summary.qaTimeoutCount, 1);
  assert.equal(summary.staticFallbackIssueCount, 1);
  assert.equal(summary.openIssueCount, 1);
  assert.equal(summary.lastNode, "agent_pending");
});

test("run health summary marks success when run is done and no failure marker remains", () => {
  const boulder = {
    state: {
      isDone: true,
      deploymentStatus: { status: "running" },
      lastFailedNode: "",
      issueTracker: [],
    },
  };
  const traceIndex = {
    traceId: "trace_done",
    lastNode: "persistence",
    retryCount: 0,
    timeline: [{ node: "deploy" }, { node: "persistence" }],
    meetingNotes: [],
  };

  const summary = summarizeRunHealth("run_done", boulder, traceIndex);
  assert.equal(summary.status, "success");
  assert.equal(summary.qaTimeoutCount, 0);
  assert.equal(summary.agentPendingCount, 0);
  assert.equal(summary.staticFallbackIssueCount, 0);
});
