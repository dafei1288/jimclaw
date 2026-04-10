# 经验系统设计方案

## 问题

### 现状
1. **`post_mortem_node` 是空壳** — 只输出"复盘完成"，不分析、不记录、不写入 KNOWLEDGE.md
2. **KNOWLEDGE.md 内容无用** — 只有一条来自 2026-03-08 的泛泛之谈（"团队协作高效"），没有可操作的教训
3. **注入方式无效** — 只取最后 2000 字符注入 system prompt，LLM 对大段自由文本的吸收率极低
4. **没有任何验证闭环** — deploy 只 health check 一个 API 端点，没人检查前端页面、没人检查 build 产物是否真实存在
5. **同样的问题反复出现** — `vite not found`、配置文件被误报、路径问题……每次都是"新发现"

### 后果
- QA 不检查前端 → 前端 404 无人发现
- 我宣布"成功"但用户看到 404 → 信任崩塌
- 同一类 bug 在不同语言/框架上反复踩坑

---

## 设计目标

1. **每个失败模式只犯一次** — 出过的问题必须被记录，下次自动避免
2. **验证必须覆盖用户视角** — 不能只看 API 200，要看完整的服务可用性
3. **经验必须可被 agent 程序化消费** — 不是自由文本，是结构化的检查规则
4. **分层** — JimClaw 内部 agents 的经验 + 我（外部 coding assistant）的经验

---

## 层次 1：部署后自动验证（post_deploy_verify）

### 当前问题
`deploy_node` 的 health check 只探一个路径（如 `/api/health`），返回 200 就过。
混合项目的前端页面、API 文档页、静态资源完全没人检查。

### 设计
在 deploy 成功后、persistence 之前，增加一个 `post_deploy_verify` 节点：

```
deploy → post_deploy_verify → post_mortem → persistence
                      ↓ (失败)
                      qa
```

**验证清单（从 spec + contract 自动生成）：**

| 检查项 | 数据来源 | 预期 |
|--------|----------|------|
| 所有 API 端点可达 | `apiContract.endpoints[]` | 每个 GET 端点返回 2xx |
| 前端页面可达 | `spec.frontend` 是否存在 | `GET /` 返回 2xx + HTML |
| 前端静态资源加载 | `frontend/dist/` 或 `src/main/resources/static/` | 至少一个 JS bundle 可达 |
| Docker 容器健康 | `containerId` | `.State.Running === true` |

**实现方式：** 纯 HTTP 请求 + docker inspect，不需要 LLM。毫秒级完成。

**输出：** `VerificationResult { passed: boolean, checks: CheckResult[], summary: string }`

**这个节点不做诊断，只做验证。** 失败了直接把证据交给 QA。

---

## 层次 2：结构化经验库（FAILURE_PATTERNS.md）

### 当前问题
KNOWLEDGE.md 是自由文本，LLM 吸收率低，无法程序化查询。

### 设计
新建 `FAILURE_PATTERNS.md`，使用 YAML + Markdown 的混合格式：

```markdown
## FP-001: npm scripts 在 Docker sh 中找不到命令

- **症状**: `sh: xxx: not found` (exit code 127)
- **根因**: `npm run <script>` 在 `sh -c` 环境中执行时，`node_modules/.bin` 不在 PATH
- **影响范围**: 所有混合项目（后端非 Node + 前端 Vue/React）
- **修复**: 用 `npx <cmd>` 代替裸命令，或用 `./node_modules/.bin/<cmd>`
- **预防**: infra_node 的 frontend build 命令始终用 `npx` 前缀
- **首次发现**: 2026-04-10, run_1775806547907
- **标签**: `docker`, `npm`, `frontend`, `exit-127`

## FP-002: verifier 把配置文件当成测试文件

- **症状**: `vitest.config.ts 未找到断言语句`
- **根因**: 文件名含 `test` 被 `testFilePatterns` 匹配
- **修复**: nonTestFiles 排除列表扩展
- **标签**: `verifier`, `config-file`, `false-positive`
```

**与 KNOWLEDGE.md 的关系：** KNOWLEDGE.md 保留给 post_mortem 写入的自由文本（向后兼容）。FAILURE_PATTERNS.md 是新的结构化经验库，由 post_mortem 节点和我共同维护。

---

## 层次 3：Agent 预检清单注入（Pre-flight Checklist）

### 当前问题
Agent 的 system prompt 是静态的，不包含"上次犯过的错"。

### 设计
`buildSystemContext()` 在构建 system prompt 时，注入与当前任务相关的 failure patterns。

```typescript
// logic_utils.ts 新函数
function buildRelevantFailurePatterns(state: JimClawState): string {
  const patterns = loadFailurePatterns();  // 解析 FAILURE_PATTERNS.md
  const tags = inferRelevantTags(state);   // 从 spec.language, spec.frontend 等推断
  
  // 只注入相关的 patterns（按标签匹配）
  const relevant = patterns.filter(p => 
    p.tags.some(t => tags.includes(t))
  );
  
  if (relevant.length === 0) return "";
  
  return `## ⚠️ 历史踩坑记录（必须避免）\n` +
    relevant.map(p => `- ${p.id}: ${p.症状} → 必须用 ${p.预防}`).join("\n");
}
```

**注入到 agent system prompt 的位置：** 在"编码约束"之后、"当前任务"之前。
只注入最多 5 条最相关的，避免 prompt 膨胀。

---

## 层次 4：post_mortem 节点功能补全

### 当前问题
空壳，不做事。

### 设计
post_mortem 节点变成真正的复盘：

**输入（从 state 收集）：**
- `retryCount` — 重试了几次
- `testResults` — 最终测试结果
- `issueTracker` — QA 发现的所有问题
- `postDeployVerification` — 层次 1 的验证结果
- `meetingNotes` — 所有会议纪要

**输出：**
1. **KNOWLEDGE.md 追加** — 自由文本总结（保留现有格式）
2. **FAILURE_PATTERNS.md 追加** — 结构化 pattern（如果发现了新的失败模式）
3. **运行统计** — 成功/失败、耗时、重试次数

**LLM 调用：** 让 PM agent 分析整个运行过程，识别 failure patterns。
**超时：** 30s（不阻塞 persistence）。

---

## 层次 5：外部 Assistant 的经验文件（LESSONS.md）

### 当前问题
我（外部 coding assistant）没有持久化的经验。每次 session 都从零开始。
同一个 session 内靠 summary 传递上下文，但跨 session 就全忘了。

### 设计
新建 `LESSONS.md`，记录我的操作经验教训：

```markdown
## L-001: 永远不要只验证 API 端点就宣布成功

- **日期**: 2026-04-10
- **教训**: 混合项目必须验证前端页面可访问性（`GET /` 返回 HTML），不能只看 API 200
- **验证清单**:
  1. API 端点返回预期数据
  2. 前端页面返回 HTML（不是 404）
  3. 审计日志中无 `exit code 127` / `not found`
  4. build 产物目录存在（dist/、static/）
  5. `docker exec` 确认文件在容器内存在

## L-002: 修改 infra/terminal/verifier 后必须检查 audit 日志

- **教训**: 基础设施修改的效果只体现在 audit/Infrastructure.md 和 Terminal.md 中
- **必须做**: E2E 跑完后，先读 audit 日志确认无错误，再宣布成功
```

**这个文件由我维护，不进入 JimClaw 的运行时。**
在 session 开始时我会读这个文件（通过 AGENTS.md 引用）。

---

## 实施优先级

| 优先级 | 层次 | 估时 | 理由 |
|--------|------|------|------|
| **P0** | 层次 5: LESSONS.md | 10 分钟 | 立即可用，防我犯蠢 |
| **P0** | 层次 1: post_deploy_verify | 1-2 小时 | 最关键的缺失环节——没有它，所有"成功"都不可信 |
| **P1** | 层次 2: FAILURE_PATTERNS.md | 1 小时 | 用已知 bug 初始化，开始积累 |
| **P1** | 层次 4: post_mortem 补全 | 1 小时 | 自动化经验积累 |
| **P2** | 层次 3: Pre-flight Checklist | 1 小时 | 让 agent 自动吸收经验 |
| **P3** | KNOWLEDGE.md → 层次 2 迁移 | 远期 | 现有 KNOWLEDGE.md 内容价值低，不急 |

---

## 验证标准

**层次 1 完成的标准：**
- 混合项目：`GET /` 返回 200 + HTML → 通过
- 纯后端项目：至少一个 API 端点返回 200 → 通过
- 前端 build 失败（exit code ≠ 0）→ 立即报告失败，不静默继续

**层次 2 完成的标准：**
- 至少 10 条历史 failure pattern 被收录
- 新 bug 被修复时同步写入 pattern

**层次 5 完成的标准：**
- 我在宣布"成功"前，必须执行 LESSONS.md 中的验证清单
- 违反清单的"成功"声明不做出
