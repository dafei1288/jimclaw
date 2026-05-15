# Semantic Evidence Design

## 背景

`run_1778813451610` 已证明 managed harness 可以跑通 `sprint_planner -> sprint_contract -> evaluator -> release_gate` 闭环。当前短板是 evaluator 主要验证 HTTP 状态、Content-Type 和响应片段，不能稳定证明用户验收语义。例如“低库存筛选只返回低库存商品”这种要求，当前只要端点返回 200 就容易被认为满足。

## 目标

把 evaluator evidence 从“端点可达”增强为“端点可达 + 响应语义可验证”。ReleaseGate 必须能区分普通 HTTP evidence 和 semantic evidence，避免只凭健康检查或 200 响应放行。

## 非目标

- 不引入 Playwright。
- 不实现完整 JSONPath 引擎。
- 不让 LLM 在 release gate 中做语义判断。
- 不重写 sprint planner；本轮只支持 planner/contract 可显式生成的 assertions，后续再做自动派生。

## 数据结构

`EvaluationCheck` 增加 `assertions?: EvaluationAssertion[]`。

第一批 assertion 类型：

- `jsonArray`: 响应体必须是 JSON 数组。
- `jsonFieldExists`: JSON 数组每个元素或对象必须包含指定字段。
- `jsonEvery`: JSON 数组每个元素的字段必须满足简单比较条件。
- `bodyContains`: 响应文本必须包含指定文本。
- `bodyNotContains`: 响应文本不得包含指定文本。

`EvaluationResult.checks[].evidence` 增加 `assertions?: AssertionEvidence[]`，每条 evidence 记录 assertion id/type/status/message。

## 执行流

1. `runHttpCheck()` 保持现有 status 检查。
2. 如果 status 不通过，直接 fail，不执行 semantic assertions。
3. 如果有 `check.assertions`，对 HTTP body 执行断言。
4. 任一 assertion fail，则整个 check fail。
5. 失败 check 写入 repro steps、suspected files，并进入 `validationReport` / `qaFailures`。

## ReleaseGate

ReleaseGate 继续要求公开 GET 端点都有 passing HTTP evidence。

新增规则：如果 acceptance criteria 或 sprint doneWhen 包含明显语义词（如“筛选”、“仅包含”、“字段”、“包含商品名称”、“不包含”），至少需要一个 passing check 带 passing semantic assertion evidence。该规则先做保守启发，避免误伤普通健康检查。

## 测试策略

- evaluator red/green:
  - `/api/products?lowStock=true` 返回数组但包含非低库存项时 fail。
  - `/api/products?lowStock=true` 返回全部低库存项时 pass，并记录 assertion evidence。
  - `/products?lowStock=true` HTML 包含非低库存商品名时 fail。
- release gate red/green:
  - 存在“低库存筛选”验收，但 evaluation 只有 HTTP 200 evidence 时 fail。
  - 存在 passing semantic assertion evidence 时 pass。

## 风险

语义断言表达能力先保持小而确定。复杂条件先通过 `jsonEvery` 的简单比较表达，不支持任意 JS 表达式，避免 evaluator 变成不安全脚本执行器。
