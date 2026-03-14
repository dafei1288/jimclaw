# 2024-03-07 系统改进记录

## 概述

本次改进基于对 JimClaw Agent 系统的深入反思，解决了三个核心问题：
1. **信息提取能力不足**：LLM 输出格式多样，解析能力跟不上
2. **团队共识机制固化**：共识太少且格式固定
3. **缺少人工干预机制**：无法在执行过程中提供反馈

---

## 问题 1：信息提取能力增强

### 问题描述

**现象**：
- Orchestrator 节点经常无法解析出有效的 subTasks
- Coder 节点生成的代码需要多次重试（maxRetries 设为 20）
- 需要频繁使用 fallback 策略

**根本原因**：
> "输出内容并不重要，关键是我们能否从里面正确地提取信息"

之前的做法是强迫 LLM 按特定格式输出（纯 JSON），但解析能力太弱：
```typescript
// 旧方法：强迫 LLM 输出纯 JSON
"请仅输出 JSON 数组，严禁任何解释文字"
```

这违反了 LLM 的自然工作模式，导致：
1. LLM 经常不遵守格式要求
2. 正则表达式解析太简单
3. 无法处理混合输出（自然语言 + 代码块）

### 解决方案

#### 1.1 增强 extractCodeFromResponse 函数

**位置**: `src/core/graph.ts`

**新增函数**: `extractCodeFromResponseEnhanced`

```typescript
async function extractCodeFromResponseEnhanced(
  raw: string,
  expectedFileType?: string,
  agent?: any
): Promise<{ code: string; isValid: boolean; error?: string }> {
  // 首先尝试传统的正则提取
  const basicResult = extractCodeFromResponse(raw, expectedFileType);

  // 如果基础方法成功，直接返回
  if (basicResult.isValid && basicResult.code.length > 50) {
    return basicResult;
  }

  // 如果基础方法失败，使用 LLM 辅助提取
  const extractPrompt = `
你是一个代码提取专家。请从以下 LLM 输出中提取出正确的代码。

【期望的文件类型】${expectedFileType || '任意'}

【LLM 原始输出】
${raw.slice(0, 8000)}

【提取要求】
1. 如果输出中有多个代码块，选择最完整、最相关的那一个
2. 如果输出没有标准代码块标记，识别哪些内容是代码
3. 清理掉所有解释性文字、注释前缀等
4. 只输出纯代码，不要任何其他内容
`;

  const extractionResult = await agent.chat([{ role: 'user', content: extractPrompt }]);
  const extractedCode = extractText(extractionResult.content).trim();

  // 验证提取的代码
  if (extractedCode.length < 10) {
    throw new Error('提取的代码太短');
  }

  console.log('[extractCode] LLM 辅助提取成功，代码长度:', extractedCode.length);
  return { code: extractedCode, isValid: true };
}
```

**关键改进**：
- 使用 LLM 自己来理解并提取代码（meta-cognition）
- 让 LLM 做 LLM 擅长的事（理解输出）
- 不再强迫 LLM 遵守特定格式

#### 1.2 改进 parseJsonFromResponse 预检查

**位置**: `src/core/graph.ts`

```typescript
// 添加对特定领域特征的检测
const hasTaskIndicators = /"id"\s*:\s*"task_\d+"|"fileTarget"\s*:/i.test(text);
const hasApiIndicators = /"method"\s*:\s*"(GET|POST|PUT|DELETE)"|"path"\s*:/i.test(text);
const hasSpecificFeatures = hasTaskIndicators || hasApiIndicators;

// 放宽长度限制：如果有特定领域特征，即使较长也要尝试解析
if (!likelyJson && text.length > 0 && text.length < 500 && !hasSpecificFeatures) {
  // 短文本且无 JSON 标记，可能是 LLM 返回的评论而非 JSON
  console.warn("[parseJson] 检测到非 JSON 内容...");
  return defaultValue;
}

// 如果检测到特定领域特征，记录日志并继续尝试解析
if (hasSpecificFeatures && !likelyJson) {
  console.log("[parseJson] 检测到特定领域特征，尝试解析...");
}
```

### 使用方法

在 Coder 节点中使用增强版提取：
```typescript
const extractResult = await extractCodeFromResponseEnhanced(
  rawResponse,
  task.fileTarget.split('.').pop(),
  agents.coder
);

if (extractResult.isValid) {
  code = extractResult.code;
} else {
  console.error('[Coder] 代码提取失败:', extractResult.error);
}
```

---

## 问题 2：团队共识机制重构

### 问题描述

**现象**：
- 团队共识（projectBrief）只有几条固定的记录
- 各个环节的讨论和决策没有被记录
- 原始需求没有被纳入共识

**根本原因**：
> "团队共识太少，而且分类固定化"

之前的共识只是简单的字符串数组：
```typescript
projectBrief: Annotation<string[]>({
  reducer: (x, y) => [...(x || []), ...(y || [])],
})
```

### 解决方案

#### 2.1 定义结构化共识类型

**位置**: `src/core/graph.ts`

```typescript
type ConsensusType = 'requirement' | 'technical' | 'problem' | 'solution' | 'decision' | 'discussion';

interface ConsensusEntry {
  type: ConsensusType;      // 共识类型
  content: string;           // 内容
  agent?: string;            // 哪个 agent 提出的
  timestamp?: number;        // 时间戳
  relatedFile?: string;      // 相关文件
}
```

#### 2.2 共识辅助函数

```typescript
function createConsensus(
  type: ConsensusType,
  content: string,
  agent?: string,
  relatedFile?: string
): ConsensusEntry {
  return {
    type,
    content,
    agent,
    timestamp: Date.now(),
    relatedFile
  };
}

function formatConsensusForLLM(consensus: ConsensusEntry[]): string {
  // 按类型分组并格式化，供 LLM 理解
  const byType: Record<ConsensusType, ConsensusEntry[]> = {
    requirement: [], technical: [], problem: [],
    solution: [], decision: [], discussion: []
  };

  consensus.forEach(entry => {
    byType[entry.type].push(entry);
  });

  // 生成结构化文本
  return [
    '## 原始需求',
    ...byType.requirement.map(e => `- ${e.content}`),
    '## 技术共识',
    ...byType.technical.map(e => `- [${e.agent}] ${e.content}`),
    '## 已识别的问题',
    ...byType.problem.map(e => `- [${e.agent}] ${e.content}`),
    '## 解决方案',
    ...byType.solution.map(e => `- [${e.agent}] ${e.content}`),
    '## 重要决策',
    ...byType.decision.map(e => `- [${e.agent}] ${e.content}`),
    '## 团队讨论',
    ...byType.discussion.map(e => `- [${e.agent}] ${e.content}`)
  ].join('\n');
}
```

#### 2.3 初始化包含原始需求

**位置**: `src/server.ts`

```typescript
// 任务开始时初始化共识
currentSession = {
  userGoal,
  status: "Running",
  // ...
  // 团队共识：从原始需求开始
  projectBrief: [
    { type: 'requirement', content: userGoal, timestamp: Date.now() },
    { type: 'discussion', content: `任务启动于 ${new Date().toLocaleString('zh-CN')}`, timestamp: Date.now() }
  ],
  // ...
};
```

#### 2.4 各节点使用新共识格式

**Architect 节点**:
```typescript
const archBrief: ConsensusEntry[] = [
  createConsensus('technical', `语言: ${spec.language}，测试命令: ${spec.testCommand}`, architectName),
  createConsensus('decision', `单元测试文件只能测导出的纯函数`, architectName),
  createConsensus('technical', `API 端点: ${endpointSummary}`, architectName),
];
```

**Orchestrator 节点**:
```typescript
const orchestratorBrief: ConsensusEntry[] = [
  createConsensus('decision', `任务拆解完成：共拆解为 ${subTasks.length} 个子任务`, pmName),
  ...subTasks.map(t =>
    createConsensus('requirement', `📋 ${t.fileTarget}: ${t.description}`, pmName, t.fileTarget)
  )
];
```

**Coder 节点**:
```typescript
const coderBrief: ConsensusEntry[] = [
  createConsensus('solution', `第 ${currentRetry + 1} 轮完成: ${completedTasks.length}/${subTasks.length} 个任务`, coderName)
];
if (currentRetry > 0) {
  coderBrief.push(createConsensus('solution', `第 ${currentRetry} 次重试，针对测试失败问题进行修复`, coderName));
}
```

#### 2.5 前端分类显示

**位置**: `public/index.html`

```javascript
function renderBrief(brief) {
  // 按类型分组
  const byType = { requirement: [], technical: [], problem: [], solution: [], decision: [], discussion: [] };

  brief.forEach(b => {
    if (typeof b === 'string') {
      byType.discussion.push(b);  // 兼容旧格式
    } else if (b && b.type) {
      byType[b.type].push(b);
    }
  });

  // 分类显示
  const typeConfig = {
    requirement: { label: '需求', color: 'border-blue-500 bg-blue-500/10', icon: 'file-text' },
    technical:  { label: '技术', color: 'border-purple-500 bg-purple-500/10', icon: 'code-2' },
    problem:    { label: '问题', color: 'border-rose-500 bg-rose-500/10', icon: 'alert-triangle' },
    solution:   { label: '方案', color: 'border-emerald-500 bg-emerald-500/10', icon: 'check-circle' },
    decision:   { label: '决策', color: 'border-amber-500 bg-amber-500/10', icon: 'gavel' },
    discussion: { label: '讨论', color: 'border-slate-500 bg-slate-500/10', icon: 'message-square' }
  };

  // 渲染每个分类
  for (const [type, entries] of Object.entries(byType)) {
    if (entries.length === 0) continue;
    const config = typeConfig[type];
    html += `<div class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
      <i data-lucide="${config.icon}" class="w-3 h-3"></i> ${config.label}
    </div>`;
    entries.forEach(entry => {
      html += `<div class="p-2 mb-2 border-l-2 ${config.color}">
        [${entry.agent}] ${entry.content}
      </div>`;
    });
  }
}
```

---

## 问题 3：Human-in-the-loop 机制

### 问题描述

**缺少人工干预能力**：
- 无法在执行过程中提出质疑
- 无法提供协助或建议
- agent 的错误只能靠重试解决

### 解决方案

#### 3.1 后端接收人工反馈

**位置**: `src/server.ts`

```typescript
socket.on("human-feedback", async (data: {
  type: 'challenge' | 'assist' | 'approve' | 'reject';
  content: string;
  relatedNode?: string
}) => {
  console.log(`[Human-in-the-loop] 收到人工反馈: ${data.type} - ${data.content}`);

  // 将人工反馈纳入团队共识
  const feedbackEntry = {
    type: data.type === 'challenge' ? 'problem' : 'solution',
    content: `[人工反馈] ${data.content}`,
    agent: 'Human',
    timestamp: Date.now(),
    relatedFile: data.relatedNode
  };

  if (currentSession.projectBrief) {
    currentSession.projectBrief.push(feedbackEntry);
  }

  // 广播人工反馈事件
  io.emit("human-feedback-received", {
    type: data.type,
    content: data.content,
    timestamp: new Date().toISOString()
  });

  // 如果是质疑，可能需要暂停当前流程
  if (data.type === 'challenge') {
    io.emit("agent-intervention", {
      reason: data.content,
      from: 'human',
      action: 'pause_and_review'
    });
  }

  // 确认收到反馈
  socket.emit("human-feedback-ack", { success: true });
});
```

#### 3.2 前端反馈界面

**位置**: `public/index.html`

**Header 按钮**:
```html
<div class="flex items-center gap-2 sm:gap-4 text-xs sm:text-sm text-slate-400">
  <button onclick="openFeedbackBanner()" class="flex items-center gap-1 px-2 py-1 text-[10px] sm:text-xs border border-slate-600 rounded-md text-slate-400 hover:text-amber-400 hover:border-amber-500 transition-colors">
    <i data-lucide="message-square" class="w-3 h-3"></i>
    <span class="hidden sm:inline">人工反馈</span>
  </button>
  <span id="nodeBadge">Node: -</span>
  <span>重试: <span id="retryCount">0 / 5</span></span>
</div>
```

**反馈横幅**:
```html
<div id="feedbackBanner" class="hidden bg-amber-900/80 border-b border-amber-500 px-4 md:px-6 py-2 md:py-3 flex items-center justify-between">
  <div class="flex items-center gap-2 md:gap-3 text-amber-100">
    <i data-lucide="message-circle-warning" class="w-4 h-4 md:w-5 md:h-5 text-amber-300"></i>
    <input type="text" id="feedbackInput" placeholder="输入您的质疑、建议或协助..."
           class="bg-amber-950/50 border border-amber-700 rounded px-3 py-1 text-sm text-amber-100 focus:outline-none focus:border-amber-500 flex-1 max-w-md">
  </div>
  <div class="flex items-center gap-2">
    <button onclick="sendFeedback('challenge')" class="bg-rose-600 hover:bg-rose-500 text-white px-3 py-1.5 rounded text-xs font-semibold">质疑</button>
    <button onclick="sendFeedback('assist')" class="bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded text-xs font-semibold">协助</button>
    <button onclick="closeFeedbackBanner()" class="text-amber-400 hover:text-amber-300 px-2 py-1 text-xs">关闭</button>
  </div>
</div>
```

**JavaScript 处理函数**:
```javascript
function openFeedbackBanner() {
  document.getElementById('feedbackBanner').classList.remove('hidden');
  document.getElementById('feedbackInput').focus();
}

function closeFeedbackBanner() {
  document.getElementById('feedbackBanner').classList.add('hidden');
  document.getElementById('feedbackInput').value = '';
}

function sendFeedback(type) {
  const content = document.getElementById('feedbackInput').value.trim();
  if (!content) {
    showToast("请输入反馈内容", 'err');
    return;
  }

  socket.emit('human-feedback', {
    type,
    content,
    relatedNode: session?.currentNode
  });

  showToast("正在发送反馈...", 'info');
}

// 监听反馈确认
socket.on('human-feedback-ack', (ack) => {
  if (ack.success) {
    showToast("反馈已发送", 'ok');
    closeFeedbackBanner();
  }
});

// 监听反馈广播
socket.on('human-feedback-received', (feedback) => {
  showToast(`人工反馈已记录: ${feedback.content}`, 'ok');
  updateUI();  // 刷新看板显示更新的共识
});
```

### 使用流程

1. **发现问题**：在实时终端中看到 agent 执行有问题
2. **点击反馈**：点击 Header 右侧的"人工反馈"按钮
3. **输入反馈**：在输入框中描述问题或建议
4. **选择类型**：
   - **质疑**：暂停当前流程，要求 agent 重新考虑
   - **协助**：提供额外的信息或建议帮助 agent
5. **发送反馈**：反馈自动纳入团队共识，所有 agent 都能看到

---

## 其他改进

### 4.1 智能体颜色系统更新

**位置**: `public/index.html`

```javascript
const AGENT_META = {
  '观止': {
    icon: 'user-cog',
    role: 'Project Manager',
    borderColor: 'border-rose-500',      // 从 indigo 改为 rose
    textColor: 'text-rose-400',
    iconColor: 'text-rose-500',
    bgPing: 'bg-rose-500'
  },
  '独孤': {
    icon: 'pen-tool',
    role: 'Chief Architect',
    borderColor: 'border-purple-500',
    textColor: 'text-purple-400',
    iconColor: 'text-purple-500',
    bgPing: 'bg-purple-500'
  },
  '星河': {
    icon: 'terminal',
    role: 'Senior Coder',
    borderColor: 'border-amber-500',
    textColor: 'text-amber-400',
    iconColor: 'text-amber-500',
    bgPing: 'bg-amber-500'
  },
  '清扬': {
    icon: 'search-check',
    role: 'QA Engineer',
    borderColor: 'border-emerald-500',
    textColor: 'text-emerald-400',
    iconColor: 'text-emerald-500',
    bgPing: 'bg-emerald-500'
  },
  'System': {
    icon: 'settings',
    role: 'Kernel',
    borderColor: 'border-slate-500',
    textColor: 'text-slate-400',
    iconColor: 'text-slate-500',
    bgPing: 'bg-slate-500'
  }
};
```

**改进**：
- 观止的颜色从 indigo 改为 rose（更醒目）
- 智能体矩阵使用对应的高亮背景色
- 所有智能体名字使用对应颜色显示

### 4.2 智能体工作状态提示增强

**位置**: `public/index.html`

```javascript
// 在智能体卡片中显示"工作中"状态
${isActive ? `<div class="shrink-0 flex items-center gap-1">
  <span class="animate-pulse w-2 h-2 rounded-full ${meta.bgPing}"></span>
  <span class="text-[9px] md:text-[10px] font-bold ${meta.textColor}">工作中</span>
</div>` : ''}

// 使用智能体对应的高亮背景色
if (isActive) {
  if (m.name === '观止') bgClass = 'bg-rose-900/20 border-rose-500/50 shadow-[0_0_12px_rgba(244,63,94,0.3)]';
  else if (m.name === '独孤') bgClass = 'bg-purple-900/20 border-purple-500/50 shadow-[0_0_12px_rgba(168,85,247,0.3)]';
  else if (m.name === '星河') bgClass = 'bg-amber-900/20 border-amber-500/50 shadow-[0_0_12px_rgba(245,158,11,0.3)]';
  else if (m.name === '清扬') bgClass = 'bg-emerald-900/20 border-emerald-500/50 shadow-[0_0_12px_rgba(16,185,129,0.3)]';
}
```

### 4.3 日志内容智能体名字着色

**位置**: `public/index.html`

```javascript
// 为日志内容中的智能体名字着色
function colorizeAgentNames(content) {
  if (!content) return '';
  let result = escapeHtml(content);

  // 为每个智能体的名字添加颜色
  Object.entries(AGENT_META).forEach(([name, meta]) => {
    if (name === 'System') return;
    const regex = new RegExp(`(${name})`, 'g');
    result = result.replace(regex, `<span class="${meta.textColor} font-bold">$1</span>`);
  });

  return result;
}

// 在日志渲染中使用
<div class="text-slate-300 whitespace-pre-wrap bg-slate-800/60 p-2 md:p-4">
  ${colorizeAgentNames(ev.content)}
</div>
```

**效果**: 日志内容中提到的智能体名字（如"观止正在分析..."）会自动使用对应颜色显示。

### 4.4 页面刷新修复

**位置**: `public/index.html`

```javascript
socket.on('state-update', s => {
  session = s;
  updateUI();
  // 确保日志流在状态更新后重新渲染（处理刷新页面后的情况）
  if (session && session.events && document.getElementById('logStream').children.length === 0) {
    filterLogs();
  }
});
```

**修复的问题**：
- 刷新页面后智能体团队不显示
- 刷新页面后决策质量看板内容为空
- 刷新页面后实时日志流为空

---

## 文件修改清单

### 修改的文件

| 文件 | 修改内容 | 行数变化 |
|------|----------|----------|
| `src/core/graph.ts` | 增强代码提取、重构共识类型、更新各节点 | +150 |
| `src/server.ts` | 初始化包含原始需求的共识、添加人工反馈处理 | +30 |
| `public/index.html` | 更新共识显示、添加反馈 UI、增强智能体提示 | +200 |

### 新增的文件

| 文件 | 说明 |
|------|------|
| `AGENT_REFLECTION.md` | 反思分析文档 |
| `ISSUES_ANALYSIS.md` | 问题分析文档 |
| `docs/2024-03-07_IMPROVEMENTS.md` | 本文档 |

---

## 核心设计原则

### 原则 1：让系统适应 LLM，而不是强迫 LLM 适应系统

**错误做法**：
```typescript
// 强制 LLM 输出纯 JSON
"请仅输出 JSON 数组，严禁任何解释文字"
```

**正确做法**：
```typescript
// 允许自然语言 + 代码块
"请先说明你的思路，然后用 ```json 代码块输出任务列表"

// 使用 LLM 自己来解析输出
const extracted = await agent.chat([{
  role: 'user',
  content: `从以下输出中提取代码：\n${rawOutput}`
}]);
```

### 原则 2：人类是系统的一部分，不是外部的监督者

**设计理念**：
- 人工反馈纳入团队共识，与 agent 讨论同等重要
- 人工可以随时介入，不需要等待特定时机
- 反馈类型多样化：质疑、协助、确认、拒绝

### 原则 3：信息传递要尽可能无损

**问题**：多环节信息损失（电话游戏效应）

**解决方案**：
- 原始需求作为共识起点
- 各节点讨论记录到共识
- 结构化共识便于追溯和理解

---

## 待办事项

### 短期（1-2周）

- [ ] 在 Coder 节点中使用 `extractCodeFromResponseEnhanced`
- [ ] 测试人工反馈机制的实际效果
- [ ] 优化共识显示的移动端体验

### 中期（1个月）

- [ ] 人工反馈触发 agent 重新思考
- [ ] 共识内容用于改进 prompt
- [ ] 添加人工反馈的优先级处理

### 长期（2-3个月）

- [ ] 多人协作场景
- [ ] 反馈历史和效果追踪
- [ ] 自动学习和优化

---

## 测试建议

### 测试信息提取

1. 运行一个简单任务
2. 观察 console 是否有 `[extractCode] LLM 辅助提取成功` 日志
3. 确认代码能正确提取和保存

### 测试团队共识

1. 运行一个任务
2. 切换到"决策与质量看板"
3. 确认看到分类的共识（需求、技术、问题、方案等）
4. 确认原始需求被记录

### 测试人工反馈

1. 在任务运行过程中点击"人工反馈"
2. 输入反馈内容
3. 点击"质疑"或"协助"
4. 确认反馈出现在团队共识中

---

## 总结

本次改进基于三个核心洞察：

1. **信息提取是关键**：不是强迫 LLM 按格式输出，而是增强我们的理解能力
2. **共识是核心**：原始需求和讨论记录都是宝贵的项目资产
3. **人机协作**：人类不是外部监督者，而是团队的一部分

**核心原则**：
> 让系统适应 LLM，而不是强迫 LLM 适应系统

---

*文档生成时间: 2024-03-07*
*改进负责人: Claude Code*

---

## 2024-03-07: 网络能力增强

### 新增技能

#### WebSearchSkill (`src/skills/web_search.ts`)

**功能**：使用 DuckDuckGo API 搜索网络信息

**特性**：
- 免费使用，无需 API key
- 支持中英文搜索
- 返回摘要、相关主题、搜索结果
- 自动降级处理网络错误

**使用示例**：
```
[Architect] 需要了解 Express 5.x 的新特性
→ 调用 web_search("Express 5.x new features")
→ 获取最新文档摘要和链接
```

#### WebFetchSkill (`src/skills/web_fetch.ts`)

**功能**：获取网页内容并提取主要文本

**特性**：
- 支持多种格式（HTML、JSON、纯文本）
- 自动移除广告、导航等噪音
- HTML 实体解码
- 10 秒超时保护

**使用示例**：
```
[Coder] 遇到错误 "Cannot find module 'xxx'"
→ 调用 web_search("npm Cannot find module solution")
→ 调用 web_fetch("https://stackoverflow.com/...") 获取详细解答
```

### 技能分配

| Agent | 新增技能 | 应用场景 |
|-------|----------|----------|
| **Architect (独孤)** | WebSearchSkill, WebFetchSkill | 查找最新技术文档、框架版本信息、最佳实践 |
| **Coder (星河)** | WebSearchSkill, WebFetchSkill | 搜索错误解决方案、获取代码示例、查找 API 用法 |

### 技术实现

**DuckDuckGo Instant Answer API**：
```
https://api.duckduckgo.com/?q={query}&format=json&no_html=1
```

**返回数据结构**：
- `Abstract`: 摘要内容
- `AbstractSource`: 摘要来源
- `RelatedTopics`: 相关主题数组
- `Results`: 搜索结果
- `Answer`: 类型答案（如计算结果）

**HTML 内容提取**：
- 移除 `<script>`, `<style>`, `<nav>`, `<header>`, `<footer>` 等标签
- 提取 `<body>` 或 `<main>` 内容
- 解码 HTML 实体（`&nbsp;`, `&lt;` 等）
- 清理多余空白

### 局限性和后续优化

**当前方案（免费）**：
- DuckDuckGo API 主要用于即时答案，复杂搜索结果有限
- 无高级搜索过滤（时间范围、网站限定等）
- 返回结果数量受限

**未来可升级**（付费）：
- **Tavily Search API**：专为 LLM 设计，支持深度搜索
- **SerpAPI**: Google Search 结果解析
- **Bing Search API**: 微软搜索服务

