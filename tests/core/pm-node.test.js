const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createTempWorkspace,
  removeTempWorkspace,
  createBaseState,
  createNoopEmit,
  createNoopStartSpan,
  createSnapshotRecorder,
} = require("./test-helpers");
const { pmNode } = require("../../src/core/nodes/pm_node");
const { AgentTimeoutError } = require("../../src/core/agent");
const { buildProductSpec } = require("../../src/core/logic_utils");

test("pm derives product spec from task contract", () => {
  const spec = buildProductSpec("图书管理系统", {
    title: "图书管理系统",
    requirements: ["提供图书列表 API", "提供前端页面"],
    acceptanceCriteria: ["GET /api/books 返回 200", "页面可以显示图书列表"],
  });

  assert.equal(spec.version, "v1");
  assert.equal(spec.title, "图书管理系统");
  assert.ok(spec.userStories.length >= 1);
  assert.ok(spec.acceptanceCriteria.some((item) => item.verificationKind === "api"));
  assert.ok(spec.acceptanceCriteria.some((item) => item.verificationKind === "ui"));
});

test("pm node compresses generic oversized product contracts into an MVP-scoped execution contract", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    userGoal: "图书管理系统",
  });

  const oversizedContract = {
    title: "图书管理系统任务契约",
    requirements: [
      "实现用户认证与权限管理模块，支持游客、普通读者、图书管理员、系统管理员四类角色，提供注册、登录、退出、重置密码、角色分配与权限校验能力。",
      "实现图书基础信息管理模块，支持图书的新增、编辑、删除、详情查询、列表查询、分页、排序、按书名/作者/ISBN/分类进行组合检索。",
      "实现图书副本与库存管理模块，支持同一图书多副本管理，并能够实时汇总可借库存、总库存、借出库存与异常库存。",
      "实现借阅管理模块，支持读者发起借书、还书、续借、取消借阅请求。",
      "实现预约管理模块，支持无库存时发起预约、查看预约队列、取消预约与超时释放。",
      "实现逾期与罚金管理模块，支持借阅期限、宽限期、罚金规则与封禁策略。",
      "实现用户个人中心模块，支持查看当前借阅、借阅历史、预约记录、罚金记录与通知消息。",
      "实现通知模块，支持借阅成功、即将到期、逾期、预约到书等站内通知。",
      "实现日志审计模块，对登录、权限变更、图书信息变更、库存调整、借还操作等关键动作记录审计日志。",
      "实现系统配置与业务规则模块，支持借阅上限、借阅期限、预约保留时长、罚金单价等参数配置。",
      "实现统一错误处理与输入校验机制，对非法参数、越权访问、库存不足、重复操作、系统异常等情况返回明确且一致的错误信息。",
      "实现数据导入导出与对账支持模块，支持图书批量导入、借阅记录导出、审计日志导出。",
      "实现统计与报表模块，支持馆藏总量、借阅次数、热门图书、逾期数量、罚金总额等指标统计。",
      "提供可测试的验证脚本，脚本需覆盖认证登录、权限校验、图书新增、图书检索、借书、还书、预约、逾期检查、审计日志查询与异常输入处理等关键流程。",
    ],
    acceptanceCriteria: [
      "未登录访问受保护接口返回 401，越权访问返回 403。",
      "图书创建、详情查询、修改、删除、分页检索可用。",
      "库存汇总正确，损坏或下架副本不会被分配。",
      "借书、还书、续借、取消借阅流程正常。",
      "预约排队与超时释放逻辑正常。",
      "逾期罚金计算与封禁策略正确。",
      "个人中心可查看借阅、预约、罚金与通知。",
      "通知查询与已读更新可用。",
      "审计日志可按时间范围、操作人、操作类型筛选。",
      "业务参数修改即时生效并保留历史。",
      "错误响应结构统一，失败操作不产生脏数据。",
      "导入导出结果可追踪。",
      "统计报表结果稳定且可校验。",
      "验证脚本可输出每个用例的通过或失败结果。",
    ],
  };

  try {
    const result = await pmNode(
      state,
      {
        pm: {
          getPersona() {
            return { name: "测试PM" };
          },
          async chat() {
            return { content: JSON.stringify(oversizedContract) };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(result.contract.requirements.length <= 6, true);
    assert.equal(result.contract.acceptanceCriteria.length <= 8, true);
    assert.equal(result.contract.requirements.some((item) => /认证|权限/.test(item)), true);
    assert.equal(result.contract.requirements.some((item) => /图书基础信息管理/.test(item)), true);
    assert.equal(result.contract.requirements.some((item) => /库存/.test(item)), true);
    assert.equal(result.contract.requirements.some((item) => /日志审计|错误处理|输入校验/.test(item)), true);
    assert.equal(result.contract.requirements.some((item) => /验证脚本/.test(item)), true);
    assert.equal(
      result.contract.requirements
        .filter((item) => !/验证脚本/.test(item))
        .some((item) => /预约|罚金|报表|导入导出|通知/.test(item)),
      false
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("pm node passes a bounded timeout to model calls", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  let observedTimeoutMs = 0;
  const state = createBaseState({
    userGoal: "图书管理系统",
  });

  try {
    await pmNode(
      state,
      {
        pm: {
          getPersona() {
            return { name: "测试PM" };
          },
          async chat(_messages, _onEvent, options) {
            observedTimeoutMs = Number(options?.timeoutMs || 0);
            return {
              content: JSON.stringify({
                title: "图书管理系统",
                requirements: ["提供图书列表查询"],
                acceptanceCriteria: ["用户可以查询图书列表"],
              }),
            };
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(observedTimeoutMs > 0, true);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("pm node falls back to a deterministic contract when model is unavailable", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const state = createBaseState({
    userGoal: "图书管理系统",
  });

  try {
    const result = await pmNode(
      state,
      {
        pm: {
          getPersona() {
            return { name: "测试PM" };
          },
          async chat() {
            throw new AgentTimeoutError("测试PM", 10);
          },
        },
      },
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.equal(Boolean(result.contract), true);
    assert.equal(result.contract.title.includes("图书"), true);
    assert.equal(result.contract.requirements.length >= 3, true);
    assert.equal(result.contract.acceptanceCriteria.some((item) => /图书列表|验证脚本|认证|权限/.test(item)), true);
    assert.equal(result.productSpec.acceptanceCriteria.some((item) => item.verificationKind === "api"), true);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
