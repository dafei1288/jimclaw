const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function createClassList() {
  const set = new Set();
  return {
    add(...tokens) {
      tokens.forEach((token) => set.add(token));
    },
    remove(...tokens) {
      tokens.forEach((token) => set.delete(token));
    },
    contains(token) {
      return set.has(token);
    },
    toString() {
      return Array.from(set).join(" ");
    },
  };
}

function createElement(id = "") {
  return {
    id,
    innerHTML: "",
    textContent: "",
    className: "",
    style: {},
    value: "",
    children: [],
    classList: createClassList(),
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    remove() {},
    focus() {},
  };
}

function createDashboardHarness() {
  const elementIds = [
    "statusBadge",
    "nodeBadge",
    "retryCount",
    "approvalModal",
    "teamList",
    "pipelineStages",
    "briefContent",
    "monitorContent",
    "timelineContent",
    "tasksContent",
    "outputSummary",
    "issueBlock",
    "issueContent",
    "qaBlock",
    "qaContent",
    "fixPlanBlock",
    "fixPlanContent",
    "medBlock",
    "medContent",
    "protocolBlock",
    "protocolContent",
    "deployBlock",
    "deployInfo",
    "deployUrl",
    "logStream",
  ];
  const elements = Object.fromEntries(elementIds.map((id) => [id, createElement(id)]));
  elements.logStream.children = [];

  const document = {
    getElementById(id) {
      if (!elements[id]) elements[id] = createElement(id);
      return elements[id];
    },
    createElement() {
      return createElement();
    },
  };

  const context = {
    console,
    window: {},
    document,
    lucide: { createIcons() {} },
    io() {
      return { on() {}, emit() {} };
    },
    fetch: async () => ({ json: async () => ({}) }),
    setTimeout() {
      return 0;
    },
    clearTimeout() {},
    encodeURIComponent,
    URL,
  };

  vm.createContext(context);
  const html = fs.readFileSync(path.join(process.cwd(), "public", "index.html"), "utf-8");
  const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const appScript = matches[matches.length - 1][1];
  vm.runInContext(appScript, context);

  return { context, elements };
}

test("dashboard snapshot keeps node file token and consensus lanes separated", () => {
  const { context, elements } = createDashboardHarness();
  const session = {
    status: "Running",
    currentNode: "verifier",
    retryCount: 2,
    maxRetries: 20,
    requiresApproval: false,
    team: [
      { name: "观止", role: "PM", color: "cyan", models: {} },
      { name: "独孤", role: "Architect", color: "yellow", models: {} },
      { name: "星河", role: "Coder", color: "green", models: {} },
      { name: "清扬", role: "QA", color: "magenta", models: {} },
    ],
    consensusCore: {
      projectTitle: "图书管理系统",
      techStack: "TypeScript + Express",
      architectureSummary: "REST API + Jest 测试",
      requirements: ["支持图书增删改查", "支持用户权限管理"],
      criticalDecisions: ["统一走 10000 端口"],
      port: 10000,
    },
    consensusProgress: {
      completedFiles: ["package.json", "tsconfig.json", "src/index.ts"],
      pendingFiles: ["tests/setup.test.ts"],
      currentRound: 2,
      openIssues: ["BUG-VERIFIER-1 tests/setup.test.ts 预检未通过"],
    },
    meetingNotes: [
      { id: "note-orchestrator-r0", phase: "orchestrator", round: 0, summary: "任务拆解完成，共 5 个文件", contentFile: "nodes/note-orchestrator-r0.md" },
      { id: "note-verifier-r2", phase: "verifier", round: 2, summary: "Verifier 第2轮：发现 1 个预检问题", contentFile: "nodes/note-verifier-r2.md" },
    ],
    executionProtocol: {
      version: "v1",
      project: {
        language: "typescript",
        framework: "express",
        runtime: "node",
        workspaceLayout: {
          sourceRoots: ["src"],
          testRoots: ["tests"],
          entryFiles: ["src/index.ts"],
          configFiles: ["package.json", "tsconfig.json", "jest.config.cjs"],
          infraFiles: ["Dockerfile"],
        },
      },
      contracts: { api: { endpoints: [] }, files: {} },
      runtime: { healthCheckPath: "/api/health" },
      workflow: { blockingRules: [], recoveryRules: [] },
      validation: { layoutRules: [], dependencyRules: [], runtimeRules: [], acceptanceRules: [] },
    },
    protocolFailures: [
      {
        type: "test_discovery_gap",
        node: "verifier",
        file: "tests/setup.test.ts",
        summary: "声明的测试文件未被 Jest roots 覆盖",
        evidence: ["jest roots=tests", "声明文件=tests/setup.test.ts"],
        blocking: true,
      },
    ],
    protocolPatches: [
      {
        target: "contracts",
        action: "replace",
        path: "files.tests/setup.test.ts.role",
        value: "test",
        reason: "统一测试文件角色",
      },
    ],
    customerApprovalState: {
      version: "v1",
      autoApprove: { requirements: true, solution: false, deploy: false },
      checkpoints: [
        {
          stage: "requirements",
          required: true,
          approved: true,
          approvedBy: "default-authorization",
          summary: "需求默认同意",
        },
        {
          stage: "solution",
          required: true,
          approved: false,
          summary: "方案待确认",
        },
        {
          stage: "deploy",
          required: true,
          approved: false,
          summary: "部署待确认",
        },
      ],
    },
    approvalNextNode: "contract_sync",
    subTasks: [
      { id: "t1", fileTarget: "package.json", description: "依赖定义", status: "completed" },
      { id: "t2", fileTarget: "tsconfig.json", description: "TS 配置", status: "completed" },
      { id: "t3", fileTarget: "src/index.ts", description: "服务入口", status: "completed" },
      { id: "t4", fileTarget: "tests/setup.test.ts", description: "测试初始化", status: "failed", lastError: "未找到断言语句" },
      { id: "t5", fileTarget: "tests/user.test.ts", description: "用户测试", status: "pending" },
    ],
    qaFailures: {
      failedFiles: ["tests/setup.test.ts"],
      testErrors: ["测试文件 tests/setup.test.ts 未找到断言语句（如 expect()、assert.）"],
      failedTestNames: [],
    },
    issueTracker: [
      {
        id: "BUG-VERIFIER-1",
        title: "tests/setup.test.ts 预检未通过",
        description: "测试初始化文件缺少断言语句。",
        severity: "major",
        status: "open",
        relatedFiles: ["tests/setup.test.ts"],
      },
    ],
    mediationDirectives: null,
    fixPlan: null,
    deployment: { status: "none", url: null },
    lastFailedNode: "verifier",
    lastFailureSummary: "测试文件 tests/setup.test.ts 未找到断言语句（如 expect()、assert.）",
    metrics: {
      progress: { total: 5, completed: 3, failed: 1, pending: 1, percent: 60 },
      tokenUsage: {
        calls: 12,
        inputTokens: 1000,
        outputTokens: 320,
        totalTokens: 1320,
        byAgent: {
          星河: { calls: 8, inputTokens: 700, outputTokens: 240, totalTokens: 940 },
          清扬: { calls: 4, inputTokens: 300, outputTokens: 80, totalTokens: 380 },
        },
      },
    },
    events: [],
  };

  vm.runInContext(`session = ${JSON.stringify(session)};`, context);
  context.updateUI();

  assert.match(elements.monitorContent.innerHTML, /代码预检/);
  assert.match(elements.monitorContent.innerHTML, /tests\/setup\.test\.ts/);
  assert.match(elements.monitorContent.innerHTML, /1320|1,320/);
  assert.match(elements.monitorContent.innerHTML, /执行进度/);
  assert.match(elements.protocolContent.innerHTML, /协议摘要/);
  assert.match(elements.protocolContent.innerHTML, /客户确认/);
  assert.match(elements.protocolContent.innerHTML, /requirements/);
  assert.match(elements.protocolContent.innerHTML, /solution/);
  assert.match(elements.protocolContent.innerHTML, /当前待确认：solution/);
  assert.match(elements.protocolContent.innerHTML, /test_discovery_gap/);
  assert.match(elements.protocolContent.innerHTML, /files\.tests\/setup\.test\.ts\.role/);
  assert.match(elements.issueContent.innerHTML, /PROTOCOL-1/);
  assert.match(elements.issueContent.innerHTML, /test_discovery_gap/);
  assert.match(elements.issueContent.innerHTML, /声明的测试文件未被 Jest roots 覆盖/);

  assert.match(elements.outputSummary.textContent, /共 5 个文件任务/);
  assert.match(elements.tasksContent.innerHTML, /当前失败/);
  assert.match(elements.tasksContent.innerHTML, /最近完成/);
  assert.match(elements.tasksContent.innerHTML, /tests\/setup\.test\.ts/);
  assert.doesNotMatch(elements.briefContent.innerHTML, /当前进度/);
  assert.match(elements.briefContent.innerHTML, /项目核心/);
  assert.match(elements.briefContent.innerHTML, /沟通纪要/);
  assert.equal(elements.protocolBlock.classList.contains("hidden"), false);
});
