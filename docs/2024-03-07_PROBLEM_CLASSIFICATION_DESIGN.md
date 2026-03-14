# 问题分类与协商机制设计

## 设计背景

当前 JimClaw 系统存在以下问题：

1. **误判问题**：单元测试通过但 QA 判定失败，导致无意义重试
2. **缺乏协商**：coder 和 qa 判断不一致时无法交互讨论
3. **硬编码流程**：`retryCount >= 2` 触发仲裁是特殊逻辑，缺乏泛化
4. **知识流失**：仲裁结果只作为临时指令，没有挖掘长期模式

## 设计目标

### 核心目标

将单一的"重试"流程改为**问题分类 + 差异化处理**：

```
原流程：coder → qa → (fail) → 重试

改进后：coder → qa → (fail) → 【问题分类器】→ 路由到不同处理策略
```

### 问题分类

| 类型 | 特征 | 处理策略 |
|------|------|----------|
| **代码问题** | 明确的错误，需要修改代码 | 返回 failedFiles，coder 重试 |
| **判定问题** | 统计显示通过但判定逻辑认为失败 | QA 重新分析或修正判定逻辑 |
| **架构问题** | 跨文件契约冲突，多次重试无效 | architect_mediation |
| **环境问题** | 依赖缺失、端口占用等 | 直接修复 |

## 架构设计

### 1. 问题分类器

#### 位置
嵌入在 QA 节点内部，在单元测试失败判定之后

#### 输入
- `testResults`: 原始测试输出
- `qaFailures`: QA 提取的失败信息
- `coder 自检结果`: coder 节点的自检状态
- `retryCount`: 当前重试次数
- `mediationDirectives`: 是否已有仲裁指令

#### 输出
```typescript
type ProblemType = 'code_problem' | 'judgment_problem' | 'architecture_problem' | 'environment_problem';

interface ProblemAnalysis {
  type: ProblemType;
  confidence: number;  // 0-1，分类置信度
  reason: string;      // 分类原因
  suggestedAction: string;  // 建议的处理方式
}
```

#### 判定逻辑

```typescript
function analyzeProblem(state: JimClawState): ProblemAnalysis {
  const testOutput = state.testResults || "";

  // === 1. 检查判定问题 ===
  // 特征：统计显示通过（pass > 0, fail = 0），但没有明确的失败信号
  const hasPassStats = /pass(?:ed)?[:\s]+([1-9]\d*)/i.test(testOutput);
  const hasZeroFail = /fail(?:ed)?[:\s]+0\b/i.test(testOutput);
  const hasRealFailure =
    /command failed with exit code\s+[1-9]/i.test(testOutput) ||
    testOutput.includes('✖') ||
    /^not ok\s+/m.test(testOutput);

  if (hasPassStats && hasZeroFail && !hasRealFailure) {
    return {
      type: 'judgment_problem',
      confidence: 0.9,
      reason: '统计显示测试全部通过，但没有明确的失败信号',
      suggestedAction: 'QA 使用 LLM 重新分析测试结果'
    };
  }

  // === 2. 检查环境问题 ===
  // 特征：特定的环境错误模式
  if (/EADDRINUSE|EACCES|ENOENT|cannot find module/i.test(testOutput)) {
    return {
      type: 'environment_problem',
      confidence: 0.8,
      reason: '检测到环境相关的错误',
      suggestedAction: '检查端口占用、文件存在性、依赖安装'
    };
  }

  // === 3. 检查架构问题 ===
  // 特征：retryCount >= 2 且没有仲裁过
  if (state.retryCount >= 2 && !state.mediationDirectives) {
    return {
      type: 'architecture_problem',
      confidence: 0.7,
      reason: `经过 ${state.retryCount} 次重试仍未解决，可能是架构层面的问题`,
      suggestedAction: '触发架构师仲裁'
    };
  }

  // === 4. 默认：代码问题 ===
  return {
    type: 'code_problem',
    confidence: 0.6,
    reason: '检测到明确的测试失败',
    suggestedAction: '返回 failedFiles，让 coder 修复代码'
  };
}
```

---

### 2. 判定问题的处理流程

#### 2.1 重新分析机制

当检测到判定问题时，QA 使用 LLM 重新分析测试结果：

```typescript
async function reAnalyzeTestResults(testOutput: string): Promise<{ passed: boolean; reason: string }> {
  const prompt = `
你是一个测试结果分析专家。请仔细分析以下测试输出，判断测试是真正通过还是失败。

## 测试输出
${testOutput}

## 分析要点
1. 查找统计行（tests/pass/fail 的数量）
2. 检查是否有明确的失败标记（✖、not ok、Error 栈跟踪）
3. 检查 shell 命令的退出码
4. 区分测试名称中的关键词和实际错误信息

## 输出格式
请以 JSON 格式输出：
{
  "passed": true/false,
  "reason": "详细说明判断依据"
}
`;

  const response = await agents.qa.chat([{ role: 'user', content: prompt }]);
  return parseJsonFromResponse(extractText(response.content), {
    passed: false,
    reason: '无法判断'
  });
}
```

#### 2.2 判定模式记录

当确认是判定问题时，记录到 projectBrief：

```typescript
const judgmentFixBrief: ConsensusEntry[] = [
  createConsensus('problem', `QA 判定问题：测试实际通过（pass=${passCount}, fail=${failCount}），但初次判定逻辑误报失败`, agents.qa.getPersona().name),
  createConsensus('solution', `重新分析后确认测试通过，继续到集成测试阶段`, agents.qa.getPersona().name),
  createConsensus('decision', `改进判定逻辑：使用明确的失败信号（exit code、非零 fail count、✖ 标记）`, 'System')
];
```

---

### 3. 协商机制（可选，第二阶段）

当 coder 自检通过但 QA 判定失败时，触发协商：

#### 3.1 协商触发条件

```typescript
const coderSelfCheckPassed = state.subTasks?.every(t => t.status === 'completed');
const qaJudgedFailed = unitTestFail;

if (coderSelfCheckPassed && qaJudgedFailed) {
  // 触发协商
  return { nextNode: 'negotiate' };
}
```

#### 3.2 协商节点设计

```typescript
.addNode("negotiate", async (state: JimClawState) => {
  const coder = agents.coder.getPersona().name;
  const qa = agents.qa.getPersona().name;

  // 收集双方论据
  const coderArgument = `
[${coder} 的自检结果]
- 所有文件 LSP 诊断通过
- 增量测试运行正常
- 文件内容符合 spec 要求

具体文件：
${state.subTasks?.map(t => `- ${t.fileTarget}: ${t.status}`).join('\n')}
`;

  const qaArgument = `
[${qa} 的失败判定]
- 失败文件: ${state.qaFailures?.failedFiles.join(', ')}
- 错误信息: ${state.qaFailures?.testErrors.join('\n')}

原始测试输出：
${state.testResults?.slice(0, 500)}
`;

  // 使用强模型进行裁决
  const verdictPrompt = `
以下是 ${coder} 和 ${qa} 的判断结果，请你作为第三方裁决者，分析真相。

${coderArgument}

${qaArgument}

请分析：
1. 谁的判断更可靠？
2. 如果 QA 判定有误，问题出在哪里？
3. 如果是代码问题，QA 指出的问题具体是什么？

请以 JSON 格式输出：
{
  "verdict": "coder_correct | qa_correct | both_partial",
  "reason": "详细分析",
  "action": "continue_to_integration | retry_code | trigger_mediation"
}
`;

  const verdict = await agents.pm.chat([{ role: 'user', content: verdictPrompt }]);
  const result = parseJsonFromResponse(extractText(verdict.content), {
    verdict: 'both_partial',
    reason: '无法判断',
    action: 'retry_code'
  });

  // 根据裁决结果路由
  return {
    isDone: false,
    testResults: state.testResults,
    projectBrief: [
      createConsensus('decision', `协商结果: ${result.verdict} - ${result.reason}`, 'PM')
    ],
    nextNode: result.action === 'continue_to_integration' ? 'qa_integration' : 'coder'
  };
})
```

---

### 4. 架构问题的仲裁优化

#### 4.1 仲裁触发条件

```typescript
if (analysis.type === 'architecture_problem') {
  return { nextNode: 'architect_mediation' };
}
```

#### 4.2 仲裁结果记录

仲裁指令仍然通过 `mediationDirectives` 传递，但新增**模式记录**：

```typescript
// 在 architect_mediation 节点内
const mediationBrief: ConsensusEntry[] = [
  createConsensus('problem', `仲裁问题: ${diagnosis}`, architectName),
  // ... 其他指令
];

// 额外记录仲裁模式（用于 post_mortem 挖掘）
const mediationPattern = {
  trigger: `retryCount=${state.retryCount}`,
  diagnosis,
  directiveTypes: parsedDirectives.map(d => d.action),
  affectedFiles: parsedDirectives.map(d => d.file)
};
```

---

### 5. post_mortem 的模式挖掘

在任务结束后，如果有过仲裁，挖掘长期模式：

```typescript
// 在 post_mortem 节点内
if (state.mediationDirectives && state.mediationDirectives.length > 0) {
  const patternMiningPrompt = `
本次任务经过了架构师仲裁。请分析并提取可复用的知识。

## 仲裁背景
- 重试次数: ${state.retryCount}
- 最终状态: ${state.isDone ? '成功' : '失败'}

## 仲裁指令
${JSON.stringify(state.mediationDirectives, null, 2)}

## 原始错误
${JSON.stringify(state.qaFailures?.testErrors)}

## 相关文件
${state.subTasks?.map(t => t.fileTarget).join(', ')}

请提取：

### 1. 问题模式
这类问题的特征是什么？如何提前识别？

### 2. 根本原因
为什么会发生这类问题？是设计缺陷还是实现错误？

### 3. 预防措施
以后如何避免类似问题？在设计/实现/测试阶段可以做什么？

### 4. 检测规则
是否可以添加自动化检测规则？（如 Lint 规则、Verifier 检查）
`;

  const pattern = await agents.pm.chat([{ role: 'user', content: patternMiningPrompt }]);

  // 追加到 KNOWLEDGE.md
  const patternEntry = `
## 模式：${state.retryCount} 轮迭代后的仲裁发现

${extractText(pattern.content)}

*来源: ${new Date().toISOString()}*
`;

  await fs.appendFile('KNOWLEDGE.md', patternEntry + '\n\n');
}
```

---

## 实施状态

### ✅ 第一阶段：问题分类器（已完成）

| 任务 | 文件 | 状态 | 说明 |
|------|------|------|------|
| 添加类型定义 | `src/core/graph.ts:192-207` | ✅ | `ProblemType`, `ProblemAnalysis`, `EnvFixResult` |
| 添加 `analyzeTestProblem()` | `src/core/graph.ts:213-273` | ✅ | 问题分类逻辑 |
| 添加 `tryFixEnvironmentProblem()` | `src/core/graph.ts:278-350` | ✅ | 环境问题自动修复 |
| 集成到 QA 节点 | `src/core/graph.ts:2098-2360` | ✅ | 单元测试失败后分类处理 |
| 判定问题处理 | `src/core/graph.ts:2188-2249` | ✅ | LLM 重新分析 |
| 环境问题处理 | `src/core/graph.ts:2262-2284` | ✅ | 自动修复并重试 |
| 架构问题路由 | `src/core/graph.ts:2287-2310` | ✅ | 直接触发仲裁 |
| 代码问题默认处理 | `src/core/graph.ts:2313-2360` | ✅ | 返回 failedFiles |

### ✅ 第三阶段：知识挖掘（已完成）

| 任务 | 文件 | 状态 | 说明 |
|------|------|------|------|
| 仲裁模式挖掘 | `src/core/graph.ts:2522-2592` | ✅ | post_mortem 中提取模式 |
| 写入 KNOWLEDGE.md | `src/core/graph.ts:2579-2587` | ✅ | 保存长期知识 |

### ⏳ 第二阶段：协商机制（未实施）

| 任务 | 文件 | 状态 | 说明 |
|------|------|------|------|
| 添加 `negotiate` 节点 | `src/core/graph.ts` | ⏳ | 待评估必要性 |
| 修改路由条件 | `src/core/graph.ts` | ⏳ | 待评估必要性 |

**注**：第一阶段的问题分类器已经能够处理判定问题、环境问题和架构问题。协商机制可能在后续需要时再添加。

---

## 代码结构优化

### 修复的问题
- **重复的 `if (unitTestFail)` 块**：合并到问题分类流程中
- **控制流混乱**：每种问题类型处理后都有明确的 return 或 continue
- **WORKSPACE 作用域**：作为参数传递给 `tryFixEnvironmentProblem()`

---

## 测试验证

### 测试用例 1：判定问题

**场景**：单元测试全部通过（pass=34, fail=0），但 QA 判定失败

**预期行为**：
1. 问题分类器识别为 `judgment_problem`
2. QA 使用 LLM 重新分析
3. 确认测试通过，继续到集成测试

### 测试用例 2：代码问题

**场景**：单元测试有明确失败（fail=3, 错误栈跟踪）

**预期行为**：
1. 问题分类器识别为 `code_problem`
2. 返回 failedFiles
3. coder 重试修复代码

### 测试用例 3：架构问题

**场景**：retryCount >= 2，跨文件契约冲突

**预期行为**：
1. 问题分类器识别为 `architecture_problem`
2. 触发 architect_mediation
3. 仲裁指令下发

---

## 设计原则

1. **渐进式增强**：先实现核心分类器，再添加协商等高级功能
2. **可观测性**：每个分类决策都有日志记录，便于调试
3. **降级兼容**：如果分类失败，降级到原有流程
4. **知识积累**：将仲裁过程转化为长期知识，而非临时指令

---

## 参考资料

- [AGENT_REFLECTION.md](../AGENT_REFLECTION.md) - Agent 系统反思与优化建议
- [2024-03-07_IMPROVEMENTS.md](./2024-03-07_IMPROVEMENTS.md) - 前期改进记录
