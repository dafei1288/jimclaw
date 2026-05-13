const test = require("node:test");
const assert = require("node:assert/strict");

require("ts-node/register/transpile-only");

const {
  ProductSpecSchema,
  SprintPlanSchema,
  SprintContractSchema,
  EvaluationResultSchema,
} = require("../../src/core/graph_types");

test("managed harness schemas accept the minimal sprint contract flow", () => {
  const product = ProductSpecSchema.parse({
    version: "v1",
    title: "图书管理系统",
    userGoal: "用户可以管理图书",
    userStories: [{ id: "US-1", story: "用户可以查看图书列表", priority: "must" }],
    acceptanceCriteria: [{
      id: "AC-1",
      description: "GET /api/books 返回 200",
      verificationKind: "api",
    }],
    nonGoals: [],
  });

  const sprint = SprintPlanSchema.parse({
    id: "SP-1",
    title: "图书列表闭环",
    goal: "用户可以查看图书列表",
    userStoryIds: ["US-1"],
    acceptanceCriteriaIds: ["AC-1"],
    deliverables: ["列表 API", "基础页面"],
    allowedScope: ["src/", "tests/", "frontend/"],
    dependencies: [],
    estimatedComplexity: "medium",
    doneWhen: ["GET /api/books 返回 200"],
  });

  const contract = SprintContractSchema.parse({
    version: "v1",
    sprintId: "SP-1",
    builderPlan: {
      intent: "实现图书列表 API",
      filesLikelyTouched: ["src/index.ts", "tests/books.test.ts"],
      implementationSteps: ["补 API", "补测试"],
      selfChecks: ["npm test"],
      assumptions: [],
    },
    evaluatorPlan: {
      checks: [{
        id: "CHK-1",
        kind: "http",
        description: "访问图书列表",
        url: "http://127.0.0.1:4000/api/books",
        method: "GET",
        expectedStatus: [200],
      }],
      requiredEvidence: ["HTTP 200"],
      passThreshold: "all",
      concerns: [],
    },
    agreedScope: {
      allowedFiles: ["src/index.ts", "tests/books.test.ts"],
      forbiddenFiles: [],
      maxNewFiles: 4,
    },
    status: "agreed",
  });

  const evaluation = EvaluationResultSchema.parse({
    version: "v1",
    sprintId: "SP-1",
    status: "pass",
    checks: [{
      checkId: "CHK-1",
      status: "pass",
      evidence: { httpStatus: 200, httpBodySnippet: "[]" },
      reproSteps: ["GET /api/books"],
      suspectedFiles: [],
    }],
    summary: "图书列表 API 已通过",
  });

  assert.equal(product.title, "图书管理系统");
  assert.equal(sprint.id, "SP-1");
  assert.equal(contract.status, "agreed");
  assert.equal(evaluation.status, "pass");
});
