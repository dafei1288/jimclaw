# 经验系统重新设计 — 从"文档"到"闭环"

## 之前方案的问题

```
FAILURE_PATTERNS.md (15 条记录)
     ↓
   没有任何代码消费它
     ↓
  = 一堆没人看的死文字
```

**入库只是第一步。没有执行、没有验证、没有度量，入库=没用。**

## 正确的闭环模型

```
发现问题 → 入库 → 代码层面预防 → 自动化回归检测 → 度量趋势
   ↑                                                    |
   └────────── 复现了？重新分析根因 ←─────────────────────┘
```

每一层必须回答一个具体问题：

| 层 | 回答的问题 | 形式 | 谁执行 |
|----|-----------|------|--------|
| 1. 入库 | 这个问题的根因是什么？ | FP-xxx 结构化记录 | 我（assistant） |
| 2. 代码预防 | 怎么让这个 bug **不可能再发生**？ | 代码改动（guard/assert/检查） | 我写，tsc 验证 |
| 3. 自动检测 | 如果这个 bug 又出现了，**谁能第一时间发现**？ | 回归检测脚本 | 每次 E2E 自动跑 |
| 4. 度量 | 我们的 FP 是在减少还是增多？ | `fp_status.json` 趋势图 | 自动生成 |

---

## 层 2: 代码预防 — 每条 FP 必须对应代码改动

原则：**不是"下次注意"，而是"代码让它不可能"。**

### FP-001 vite not found
```
之前: execInContainer(containerId, "cd frontend && npm run build")
之后: execInContainer(containerId, "cd frontend && npx vite build")
验证: tsc --noEmit 通过 + E2E 混合项目 build 成功
```

### FP-007 build 静默吞错
```
之前: isCommandFailureOutput 只匹配 /^Command failed with exit code/
之后: 还要匹配 exit code 127 / "not found" / "command not found"
验证: 模拟 exit 127 输出 → 函数返回 true
```

### FP-008 没有部署后验证
```
之前: deploy 只 health check /api/health
之后: post_deploy_verify 节点检查所有端点
验证: 混合项目前端 404 → 检测到并报错
```

**判断标准：如果删掉这条 FP 的代码改动，对应 bug 就会复现。**
如果不会，说明预防没到位。

---

## 层 3: 自动回归检测 — `scripts/fp_regression_check.ts`

一个脚本，在每次 E2E 完成后自动运行。检查所有已入库 FP 是否复现：

```typescript
// 每个 FP 对应一个检查函数
const checks: FPCheck[] = [
  {
    id: "FP-001",
    name: "npm scripts 在 sh -c 中找不到命令",
    check: async (runDir: string) => {
      // 读 audit/Infrastructure.md，搜索 "not found" + exit 127
      const infra = await readFile(`${runDir}/audit/Infrastructure.md`);
      const has127 = /sh:.*not found|exit code 127/.test(infra);
      return { passed: !has127, evidence: has127 ? "发现 exit 127" : "无" };
    }
  },
  {
    id: "FP-007",
    name: "infra build 静默吞错",
    check: async (runDir: string) => {
      // 读 audit/Infrastructure.md，如果 build 失败但流程继续 → 失败
      const infra = await readFile(`${runDir}/audit/Infrastructure.md`);
      const hasBuildFailure = /前端 build 失败|vite.*not found/.test(infra);
      const hasDeployContinue = hasBuildFailure && /Deployment Start/.test(infra);
      return { 
        passed: !hasDeployContinue, 
        evidence: hasDeployContinue ? "build 失败但 deploy 继续" : "无" 
      };
    }
  },
  {
    id: "FP-008",
    name: "部署后前端不可达",
    check: async (runDir: string) => {
      // 如果是混合项目，检查 boulder.json 中是否有前端验证结果
      const boulder = JSON.parse(await readFile(`${runDir}/boulder.json`));
      const isMixed = boulder.state.spec?.frontend != null;
      if (!isMixed) return { passed: true, evidence: "非混合项目，跳过" };
      
      const verification = boulder.state.postDeployVerification;
      return { 
        passed: verification?.frontendAccessible === true,
        evidence: verification?.frontendUrl || "无验证记录" 
      };
    }
  },
  // ... 更多 FP checks
];
```

**这个脚本不依赖 LLM，纯代码检查。秒级完成。**

**集成方式：** persistence_node 在保存 boulder.json 之前自动调用 fp_regression_check。
结果写入 boulder.json 的 `fpRegressionCheck` 字段。

---

## 层 4: 度量 — `fp_status.json`

每次运行后更新：

```json
{
  "lastUpdated": "2026-04-10T08:00:00Z",
  "summary": {
    "totalFPs": 15,
    "codePrevented": 5,
    "autoDetected": 8,
    "open": 2,
    "neverRecurring": 5
  },
  "runs": [
    {
      "runId": "run_1775806547907",
      "date": "2026-04-10",
      "fpResults": {
        "FP-001": "FAILED",
        "FP-007": "FAILED", 
        "FP-008": "FAILED"
      }
    },
    {
      "runId": "run_1775810000000",
      "date": "2026-04-10",
      "fpResults": {
        "FP-001": "PASSED",
        "FP-007": "PASSED",
        "FP-008": "PASSED"
      }
    }
  ]
}
```

**一眼看出：**
- 哪些 FP 真的被代码预防了（连续 N 次 PASSED）
- 哪些 FP 还在反复出现（标记为 open）
- 整体趋势是好转还是恶化

---

## 实施顺序（按价值排序）

| 步骤 | 做什么 | 为什么先做 |
|------|--------|-----------|
| **1** | 修 FP-001/007 的代码 | 当前混合项目根本跑不通，不修什么都没用 |
| **2** | 实现 post_deploy_verify 节点 | 最关键的质量守门人 |
| **3** | 写 fp_regression_check 脚本 | 有了它，每次运行自动验证所有 FP |
| **4** | 集成到 persistence_node | 自动度量，不再依赖人工 |
| **5** | agent prompt 注入（L3） | 锦上添花，前 4 步是刚需 |

**判断成功的标准：**
- [ ] FP-001: 混合项目 E2E，`audit/Infrastructure.md` 无 "not found"
- [ ] FP-007: 前端 build 失败时流程终止，不静默继续
- [ ] FP-008: 混合项目 deploy 后 `GET /` 返回 HTML
- [ ] fp_regression_check: 所有 FP 状态 PASSED
- [ ] 我宣布成功前执行了验证清单（而非只看 API 200）
