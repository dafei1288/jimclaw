const test = require("node:test");
const assert = require("node:assert/strict");

require("ts-node/register/transpile-only");

const { buildSprintPlans } = require("../../src/core/logic_utils");

test("buildSprintPlans creates vertical slices from product spec", () => {
  const plans = buildSprintPlans({
    productSpec: {
      version: "v1",
      title: "图书管理系统",
      userGoal: "图书管理",
      userStories: [
        { id: "US-1", story: "用户可以查看图书列表", priority: "must" },
        { id: "US-2", story: "用户可以新增图书", priority: "must" },
      ],
      acceptanceCriteria: [
        { id: "AC-1", description: "GET /api/books 返回 200", verificationKind: "api" },
        { id: "AC-2", description: "页面显示图书列表", verificationKind: "ui" },
      ],
      nonGoals: [],
    },
    apiContract: { endpoints: [{ path: "/api/books", method: "GET", description: "列表" }] },
    spec: { language: "TypeScript", framework: "Express", filesToCreate: [] },
  });

  assert.ok(plans.length >= 1);
  assert.ok(plans[0].goal.includes("启动") || plans[0].goal.includes("列表"));
  assert.ok(plans.some((plan) => plan.acceptanceCriteriaIds.includes("AC-1")));
});
