const test = require("node:test");
const assert = require("node:assert/strict");

require("ts-node/register/transpile-only");

const {
  ProductSpecSchema,
  SprintPlanSchema,
  SprintContractSchema,
  EvaluationCheckSchema,
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

test("managed harness schemas accept semantic assertions and assertion evidence", () => {
  const check = EvaluationCheckSchema.parse({
    id: "CHK-LOW-STOCK",
    kind: "http",
    description: "低库存 API 只返回低库存商品",
    url: "/api/products?lowStock=true",
    method: "GET",
    expectedStatus: [200],
    assertions: [
      { id: "A-json-array", type: "jsonArray" },
      { id: "A-json-non-empty", type: "jsonNonEmpty" },
      { id: "A-name", type: "jsonFieldExists", field: "name", scope: "each" },
      { id: "A-stock", type: "jsonEvery", field: "stock", operator: "lt", value: 10 },
      { id: "A-page-title", type: "bodyContains", text: "Product Inventory" },
      { id: "A-no-normal-item", type: "bodyNotContains", text: "USB-C Hub" },
    ],
  });

  const evaluation = EvaluationResultSchema.parse({
    version: "v1",
    sprintId: "SP-1",
    status: "pass",
    checks: [{
      checkId: "CHK-LOW-STOCK",
      status: "pass",
      evidence: {
        httpStatus: 200,
        httpBodySnippet: "[]",
        assertions: [
          { id: "A-json-array", type: "jsonArray", status: "pass", message: "响应体是 JSON 数组" },
          { id: "A-json-non-empty", type: "jsonNonEmpty", status: "pass", message: "响应体 JSON 数组非空" },
          { id: "A-stock", type: "jsonEvery", status: "pass", message: "所有元素满足 stock lt 10" },
        ],
      },
      reproSteps: ["GET /api/products?lowStock=true"],
      suspectedFiles: [],
    }],
    summary: "低库存 API 已通过",
  });

  assert.equal(check.assertions.length, 6);
  assert.equal(evaluation.checks[0].evidence.assertions[0].status, "pass");
});
