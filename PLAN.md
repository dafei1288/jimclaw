# JimClaw 修改路线（v3 — 实施进展版）

> 基于 149 次运行的完整归因分析，修正优先级。

---

## 一、现状数据

### 149 次 run 归因

| 类别 | 次数 | 占比 | 说明 |
|------|------|------|------|
| ✅ 真成功 (deploy=running) | 6 | 4.0% | 全部 Express+TypeScript |
| ⚠️ 伪成功 (isDone=true 但没部署) | 16 | 10.7% | 代码写完了但没部署成功 |
| 🔌 API 失败 (超时/连接/额度) | 24 | 16.1% | 模型服务不可用 |
| ⏹️ Coder 中途停止 | 35 | 23.5% | process 在 coder 处理中被杀/超时 |
| 🚫 Coder blocked | 23 | 15.4% | 首个写入超时/慢进度超时 |
| ❌ 测试失败循环耗尽 | 11 | 7.4% | 修不好 |
| 💥 部署失败 | 11 | 7.4% | deploy 节点出错 |
| 🔧 环境问题 | 3 | 2.0% | EPERM 等 |
| ❓ 其他 | 11 | 7.4% | approval_pending 等 |

### 关键发现

1. **伪成功有 16 次**：`persistence` 节点无条件设 `isDone: true`，即使代码没部署成功
2. **`extractFailureEvidence` 有盲区**：不认识 `[基础设施异常]` `[基础设施构建失败]` `spawn EPERM`，导致 QA 误判 `isDone=true`
3. **Coder 中途停止 35 次**：28 次无 lastError（process 被杀），7 次有明确错误
4. **Scaffold 是核心能力**：6 次真成功中，3 次是纯 scaffold（零 LLM 调用）。有 scaffold 的真成功率 7.1% vs 无 scaffold 0.0%
5. **API 失败 24 次**：Connection error 12 次、API 超时 8 次、额度不足 2 次

---

## 二、修改路线（按收益排序）

### Phase 0：修 bug ✅ 已完成

| 序号 | 改动 | 状态 |
|------|------|------|
| 0.1 | extractFailureEvidence 盲区 | ✅ 完成 |
| 0.2 | persistence isDone | ✅ 完成 |
| 0.3 | agent_pending 重试 | ✅ 完成 |

### Phase 1：提升 Coder 完成率 ✅ 已完成

| 序号 | 改动 | 状态 |
|------|------|------|
| 1.1 | Coder 模型升级 | ✅ 完成 |
| 1.2 | 文件数限制 ≤15 (was ≤20) | ✅ 完成 |
| 1.3 | Coder 全局超时 5min | ✅ 完成 |
| 1.4 | maxRetries 8 (was 20) | ✅ 完成 |
| 1.5 | PM prompt 奥卡姆剃刀 | ✅ 完成 |
| 1.6 | 确定性降级 minimal 3 requirements | ✅ 完成 |
| 1.7 | Architect 确定性降级 isSimpleApiGoal | ✅ 完成 |
| 1.8 | Architect 奥卡姆剃刀后处理 | ✅ 完成 |
| 1.9 | Orchestrator Occam Razor filter | ✅ 完成 |
| 1.10 | ensureRequirementDrivenFiles 门槛 | ✅ 完成 |
| 1.11 | shouldUseBoundedCrudPlan 门槛 ≤15 | ✅ 完成 |
| 1.12 | findExecutionPlanGaps 小计划豁免 | ✅ 完成 |
| 1.13 | Verifier route-check 修复 | ✅ 完成 |

**Phase 0-1 验收**: "健康检查 API" → 7 文件, 0 retries, deploy=running, curl 返回 {"status":"ok"} ✅

### Phase 2：端到端成功率 🔄 进行中

#### Phase 2.1: 依赖校验放宽 ✅ 完成
- `allowedRolesForProtocolFile`: model/service 可依赖 model/config/other
- `service` 可依赖其他 `service`
- `validateProtocolDependencyRoles`: ≤15 文件跳过
- `validateImportContracts`: ≤15 文件跳过

#### Phase 2.2: 否定语境检测 ✅ 完成
- `buildRequirementProtocol`: "不包含/不需要/排除" 等否定语境不触发 required
- `uncoveredAcceptanceCriteria`: 同上
- auth title 特殊处理: title 含"认证/登录" 仍视为 authRequired
- `ensureRequirementDrivenApiContract`: CRUD 注入需 requirements 明确提到 CRUD 操作
- `ensureRequirementDrivenApiContract`: auth 端点注入去重（已有则不注入）
- `crudEntities`: 从硬编码列表中移除 "user"（避免所有用户相关项目误判为 CRUD）

#### Phase 2.3: 确定性降级简化 ✅ 完成
- else 分支去掉 controllers 和 scripts/verify.ts
- MAX_FILES 降为 15

#### Phase 2.4: Architect 服务文件去重 ✅ 完成
- 同一资源前缀的多个 service 只保留主 service
- auth*Service → 只保留 authService.ts

#### Phase 2.5: validationReport 阻断修复 ✅ 完成
- 确定性降级时不因覆盖缺口阻断
- 仅 LLM 成功返回时检查 planning gaps

#### Phase 2.6: ensureRequirementDrivenFiles 门槛提升 ✅ 完成
- auth 分层注入门槛从 0 提到 3（已有文件列表时不注入）
- `shouldUseBoundedCrudPlan` 门槛从 10 提到 15

#### Phase 2.7: Architect prompt 强化 ✅ 完成
- 明确每资源最多 1 个 service 文件
- 文件总数上限 12
- 禁止 scripts/verify.ts, .env.example, README.md

#### Phase 2.8: 已完成
- [x] **Architect model 自动补充** — service 文件缺失对应 model 时自动补充
- [x] **自包含 Scaffold** — model 不在 filesToCreate 时生成自包含 scaffold
- [x] **auth 排除** — auth service 不误补充 model 文件

#### Phase 2.9: 多语言 Scaffold ✅ 完成
- [x] **ScaffoldProvider 抽象层** — `src/scaffolds/` 模块化架构
- [x] **Python/FastAPI Provider** — 完整 CRUD + Auth + Test scaffold
- [x] **Architect 多语言降级** — `detectTargetStack()` 检测语言偏好
- [x] **Infra Python 支持** — pip install + python:3.11-slim Docker 镜像

#### Phase 2.10: QA Fallback ✅ 完成
- [x] **QA 超时缩短** — 90s → 45s（更快触发 fallback）
- [x] **QA fallback 模型** — 配置 minmax 作为第二选择（不同供应商）
- [x] **buildFallbackChain 增强** — fallback 模式优先于 default/coding/reasoning

#### Phase 2.11: ✅ 已完成
- [x] **端到端验证** — TS/Express CRUD API retryCount=0，健康检查 API retryCount=0，Todo CRUD API retryCount=2
- [x] **健康检查 API 测试** — 基础功能验证通过
- [x] **契约漂移路由文件修复** — `inferMountPrefixes()` 支持路由文件相对路径匹配
- [x] **Architect README 超时降噪** — Promise.race 替代 agent timeout，不再打印 [Critical Error]
- [x] **Coder 测试文件 import 约束** — 测试文件铁律新增「只能 import 已存在的文件」规则
- [x] **Orchestrator 超时增加** — 45s → 90s，减少间歇性超时

### Phase 3：代码质量与可维护性

> 不是直接提升成功率，但降低后续维护成本和引入 bug 的风险

#### 3.1 拆分 logic_utils.ts（5380 行 → 5-6 个模块）
#### 3.2 精简 graph_types.ts（834 行 → ~400 行）
#### 3.3 添加核心路由的单元测试
#### 3.4 结构化运行报告

---

## 三、实施顺序与验收

### Phase 0（第 1-3 天）

| 序号 | 改动 | 文件 | 验收标准 |
|------|------|------|---------|
| 0.1 | extractFailureEvidence 盲区 | logic_utils.ts | 伪成功归零 |
| 0.2 | persistence isDone | persistence_node.ts | isDone 仅在 deploy=running 时为 true |
| 0.3 | agent_pending 重试 | graph.ts + graph_types.ts | API 临时故障自动重试 |

**验收**: 跑 5 次，确认无伪成功。isDone=true 必须对应 deploy=running。

### Phase 1（第 4-7 天）

| 序号 | 改动 | 文件 | 验收标准 |
|------|------|------|---------|
| 1.1 | Coder 模型升级 | jimclaw.config.json | Coder 有 LLM 调用 |
| 1.2 | 文件数限制 ≤ 20 | architect_node.ts | 无 20+ 文件的 run |
| 1.3 | Coder 全局超时 | coder_node.ts | Coder 中途停止时保留已完成工作 |
| 1.4 | maxRetries 20→8 | jimclaw.config.json | 无 10+ retry 的 run |

**验收**: 连续 10 次 run，真成功率 ≥ 30%。

### Phase 2（第 8-14 天）

| 序号 | 改动 | 验收标准 |
|------|------|---------|
| 2.1 | PM/Architect prompt 优化 | 非 TS 项目也能生成正确代码 |
| 2.2 | 增量测试 | retry 时测试时间减少 50% |
| 2.3 | QA 编译错误优先 | TS 编译错误不经过 LLM 分析 |

**验收**: 连续 10 次 run，真成功率 ≥ 50%。

---

## 四、风险与回退

| 风险 | 缓解措施 |
|------|---------|
| 0.2 改后 isDone 永远 false | 保留 QA 设的 isDone=true，persistence 只在上游未设时才用 false |
| 0.3 agent_pending 重试死循环 | 加 retryCount 上限 3 次 |
| 1.1 模型 API 不稳定 | 保留 glm 作为 fallback 配置 |
| 1.2 文件限制过严 | 提供 CLI 参数 `--no-file-limit` 跳过 |
| 1.3 全局超时截断工作 | 已完成的 subTask 已写磁盘，下次重试跳过 |

---

## 五、Scaffold 的定位（不删、只优化）

**结论**: Scaffold 是当前系统的核心能力，不能删除。

| 文件类型 | 生成方式 | 理由 |
|---------|---------|------|
| package.json, tsconfig.json, jest.config | scaffold | 结构化配置，模型容易出错 |
| Dockerfile, docker-compose.yml | scaffold | 模板化，变化少 |
| src/index.ts (入口) | scaffold | 结构固定 |
| model, service, controller, route | **模型** | 业务逻辑，模板无法覆盖 |
| tests/*.test.ts | **模型** | 测试逻辑需要理解业务 |

优化方向：让 scaffold 只处理「配置类」文件，业务代码走模型。这样既利用 scaffold 的可靠性，又利用模型生成业务逻辑的能力。
