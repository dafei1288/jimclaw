# Managed Agent Harness TODO

日期：2026-05-13

## P0: 先让协作契约进入主流程

- [ ] 新增 `ProductSpec`、`SprintPlan`、`SprintContract`、`EvaluationResult` 类型和 Zod schema。
- [ ] 在 `pm_node` 中从 `TaskContract` 派生 `ProductSpec`。
- [ ] 新增 deterministic `buildSprintPlans()`，先覆盖 API/UI/部署三类验收。
- [ ] 新增 `sprint_planner_node`，输出 `sprintPlans` 和 `activeSprintId`。
- [ ] 新增 `sprint_contract_node`，在 Coder 动手前生成 `SprintContract`。
- [ ] 将 `SprintContract` 注入 `coder_node` prompt。
- [ ] 在 `coder_node` 中做轻量 scope guard，防止明显越界写文件。
- [ ] 新增 `managedHarness.enabled` 配置开关。

## P0: Evaluator 取代“只读日志”的 QA 放行

- [ ] 新增 `evaluator_node`。
- [ ] 支持 `command` check，第一版可复用 `terminal` 输出。
- [ ] 支持 `http` check，使用 `host.httpGet()`，不依赖 curl。
- [ ] 支持 `file` check，用于确认构建产物、关键文件和静态页面。
- [ ] `EvaluationResult` 必须包含 evidence；没有 evidence 的 pass 无效。
- [ ] `verifier -> qa` 调整为 `verifier -> evaluator -> qa`。
- [ ] QA 继续负责 issue 分类，但不再单独决定最终 release。

## P0: Release Gate 防伪成功

- [ ] 新增 `release_gate_node`。
- [ ] 每个 must user story 必须有 passing sprint 覆盖。
- [ ] 每个 acceptance criterion 必须有 evidence。
- [ ] 前端需求存在时，根路径或 `/index.html` 必须返回 HTML。
- [ ] API contract 中公开 GET 端点必须被实际访问。
- [ ] `audit/Infrastructure.md` 和 `audit/Terminal.md` 中不得存在未解释 critical failure。
- [ ] `deploy -> post_mortem` 改为 `deploy -> release_gate -> post_mortem`。

## P1: Repair Contract 替换失败后盲修

- [ ] 新增 `RepairContract` 类型。
- [ ] `fix_plan_node` 兼容输出 `repairContracts`。
- [ ] 失败修复必须绑定 `EvaluationResult.failedChecks`。
- [ ] 修复 scope 只覆盖当前 sprint。
- [ ] 修复后必须回到 evaluator 复测，不得直接进入下一个 sprint。
- [ ] 连续相同 failed check 达到阈值时，转 `architect_mediation`。

## P1: Session Event 事实源

- [ ] 新增 `src/utils/session_events.ts`。
- [ ] 写入 `workspace/run_xxx/session/events.jsonl`。
- [ ] `sprint_planner_node` 写 `sprint_plan` event。
- [ ] `sprint_contract_node` 写 `sprint_contract` event。
- [ ] `evaluator_node` 写 `evaluation_result` event。
- [ ] `release_gate_node` 写 `release_decision` event。
- [ ] `trace-index.json` 聚合 session event summary。
- [ ] Dashboard/TUI 展示 active sprint、current contract、latest evaluation。

## P1: Plan Review 关口

- [ ] 新增 `PlanReview` 类型。
- [ ] 新增 `plan_review_node`。
- [ ] 检查 ProductSpec 是否有可验证 acceptance criteria。
- [ ] 检查 ArchitectureBrief/API contract 是否覆盖需求。
- [ ] 检查 scope 是否过大，超过阈值时要求拆 sprint。
- [ ] 检查前端/后端/部署需求是否被对应 sprint 覆盖。
- [ ] `architect -> orchestrator` 调整为 `architect -> plan_review -> sprint_planner`。

## P2: 更完整的主动验证

- [ ] `EvaluationCheck.kind="playwright"` 支持真实浏览器检查。
- [ ] 前端任务自动生成 Playwright 检查：打开页面、点击核心按钮、验证 DOM 文本。
- [ ] API POST/PUT/DELETE 检查支持请求体 fixture。
- [ ] 支持数据库或内存状态验证。
- [ ] 保存 screenshot 和 trace 到 `workspace/run_xxx/evidence/`。
- [ ] Release gate 引用 evidence artifact path。

## P2: Builder 从文件任务转向 sprint 执行

- [ ] `SubTask[]` 保留但不再作为主协作对象。
- [ ] Builder 根据 `SprintContract.builderPlan` 生成内部任务。
- [ ] `filesToCreate` 改为 `suggestedFiles`，不再是唯一真相源。
- [ ] 如果 Builder 需要新增文件，生成 `scopeChangeRequest`。
- [ ] `scopeChangeRequest` 回到 `sprint_contract_node` 审查。

## P2: Managed Agents 式 hands/session 解耦

- [ ] 将 session event 查询封装为 `SessionContext`。
- [ ] 节点不再直接拼接大块 `state`，改为查询相关事件。
- [ ] 执行动作统一走 `CommandExecutor` intent。
- [ ] Browser/Playwright、Shell、Docker 都作为 hands 能力注册。
- [ ] Dashboard 可以按 session event 回放每个 sprint。

## 测试 TODO

- [ ] `tests/core/managed-harness-types.test.js`
- [ ] `tests/core/sprint-planner.test.js`
- [ ] `tests/core/sprint-planner-node.test.js`
- [ ] `tests/core/sprint-contract-node.test.js`
- [ ] `tests/core/evaluator-node.test.js`
- [ ] `tests/core/release-gate-node.test.js`
- [ ] `tests/core/session-events.test.js`
- [ ] `tests/core/workflow-replay.test.js` 覆盖 legacy 和 managed harness 两条路由。
- [ ] 增加真实 run fixture：前端 404 时 release gate 必须 fail。
- [ ] 增加真实 run fixture：API health pass 但业务 endpoint fail 时 release gate 必须 fail。

## 验证命令

```bash
npx tsc --noEmit
node --test tests/core/managed-harness-types.test.js tests/core/sprint-planner.test.js tests/core/sprint-planner-node.test.js tests/core/sprint-contract-node.test.js tests/core/evaluator-node.test.js tests/core/release-gate-node.test.js
node --test tests/core/workflow-replay.test.js tests/core/qa-node.test.js tests/core/deploy-node.test.js
npx ts-node scripts/run_health_report.ts workspace --limit 5
```

## 真实 E2E 验收

- [ ] 运行：`npx ts-node src/index.ts --auto-approve all "简单图书管理系统，包含图书列表 API 和页面"`。
- [ ] 检查最新 run 的 `session/events.jsonl`。
- [ ] 检查 `audit/Infrastructure.md` 无未解释 build/deploy 错误。
- [ ] 检查 `audit/Terminal.md` 无未解释测试失败。
- [ ] 检查 `boulder.json` 中至少包含一个 passing `EvaluationResult`。
- [ ] 检查 release gate pass 之前，所有 must acceptance criteria 都有 evidence。

## 参考链接

- Anthropic Harness Design: https://www.anthropic.com/engineering/harness-design-long-running-apps
- Anthropic Managed Agents: https://www.anthropic.com/engineering/managed-agents
- gstack: https://github.com/garrytan/gstack
