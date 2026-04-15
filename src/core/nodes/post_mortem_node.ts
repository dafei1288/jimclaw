import * as fs from "fs/promises";
import * as path from "path";
import { JimClawState } from "../graph_types";
import { BaseAgent } from "../agent";
import { AuditLogger } from "../../utils/audit";

/**
 * PostMortem 节点：分析运行数据，写入 KNOWLEDGE.md（经验教训）
 *
 * 两种场景：
 * 1. 成功（deploy=running）→ 记录成功因素 + 关键决策
 * 2. 失败（retryCount >= maxRetries）→ 记录失败模式 + 根因分析
 */
export async function postMortemNode(
  state: JimClawState,
  agents: { pm: BaseAgent },
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("post_mortem");
  emit("phase-change", "System", "review");

  const round = state.retryCount || 0;
  const isSuccessful = state.deploymentStatus?.status === "running";
  const spec = state.spec;
  const lang = spec?.language || "unknown";
  const taskTitle = state.contract?.title || "未命名任务";

  // ── 1. 收集运行统计 ──
  const issueCount = (state.issueTracker || []).length;
  const openIssues = (state.issueTracker || []).filter((i: any) => i.status === "open");
  const closedIssues = (state.issueTracker || []).filter((i: any) => i.status === "resolved" || i.status === "closed");
  const filesCreated = state.subTasks?.filter((t: any) => t.status === "completed").length || 0;
  const filesTotal = state.subTasks?.length || 0;

  // ── 2. 分析失败原因 ──
  let failureAnalysis = "";
  if (!isSuccessful) {
    const failureReasons: string[] = [];

    // 检查 testResults
    const testResults = state.testResults || "";
    if (/FAIL|Tests run:.*Failures: [1-9]/i.test(testResults)) {
      failureReasons.push("单元测试未通过");
    }
    if (/BUILD FAILURE/i.test(testResults)) {
      failureReasons.push("构建失败（Maven/npm/Go）");
    }

    // 检查部署
    if (state.deploymentStatus?.status === "failed") {
      failureReasons.push("部署健康检查失败");
    }

    // 检查 lastFailedNode
    if (state.lastFailedNode) {
      failureReasons.push(`最后失败节点: ${state.lastFailedNode}`);
    }

    // 检查 infra 错误
    if (/基础设施异常|Critical Error/i.test(testResults)) {
      failureReasons.push("基础设施异常");
    }

    // 检查超时
    if (/超时|timeout|timed out/i.test(testResults)) {
      failureReasons.push("操作超时");
    }

    // 检查 API 错误
    if (/429|余额不足|rate limit|quota/i.test(testResults)) {
      failureReasons.push("API 额度/限流");
    }

    if (failureReasons.length === 0) {
      failureReasons.push("retryCount 耗尽，具体原因不明");
    }

    failureAnalysis = failureReasons.join("；");
  }

  // ── 3. 生成经验条目 ──
  const timestamp = new Date().toISOString();
  let entry = `\n---\n\n`;
  entry += `## 经验教训\n`;
  entry += `**时间**: ${timestamp}\n`;
  entry += `**任务**: ${taskTitle}\n`;
  entry += `**语言/框架**: ${lang}\n`;
  entry += `**结果**: ${isSuccessful ? "✅ 成功" : "❌ 失败"} | **重试次数**: ${round}\n`;

  if (isSuccessful) {
    entry += `\n- **成功因素**: `;
    if (round === 0) {
      entry += `零重试成功，脚手架 + 确定性降级路径工作正常。`;
    } else {
      entry += `经过 ${round} 轮修复后成功。`;
    }
    entry += `文件完成 ${filesCreated}/${filesTotal}，关闭问题 ${closedIssues.length} 个。`;

    // 记录关键决策
    const decisions = state.consensusCore?.criticalDecisions || [];
    if (decisions.length > 0) {
      entry += `\n- **关键决策**: ${decisions.join("；")}`;
    }
  } else {
    entry += `\n- **失败因素**: ${failureAnalysis}`;
    entry += `\n- **未解决工单**: ${openIssues.map((i: any) => i.title).join("；") || "无"}`;
    entry += `\n- **文件完成**: ${filesCreated}/${filesTotal}`;

    // 根因推测
    const rootCauseGuess = guessRootCause(state);
    if (rootCauseGuess) {
      entry += `\n- **推测根因**: ${rootCauseGuess}`;
    }
  }

  entry += `\n- **改进建议**: ${generateSuggestions(state, isSuccessful)}\n`;

  // ── 4. 追加到 KNOWLEDGE.md ──
  try {
    const knowledgePath = path.resolve(process.cwd(), "KNOWLEDGE.md");
    let existing = "";
    try {
      existing = await fs.readFile(knowledgePath, "utf-8");
    } catch {
      // 文件不存在，创建
    }

    // 如果是新文件，加标题
    if (!existing) {
      existing = `# 知识库（KNOWLEDGE.md）\n\n> JimClaw 自动维护的经验教训。post_mortem 节点每次运行后追加。\n`;
    }

    // 保留最多 20 条经验（防止无限增长）
    const sections = existing.split("\n---\n");
    const header = sections[0];
    let entries = sections.slice(1);

    // 去重：与本次同语言+同结果+同重试次数的旧条目只保留最新一条
    const thisFingerprint = `${lang}|${isSuccessful ? "ok" : "fail"}|round=${round}`;
    entries = entries.filter(e => {
      const fp = [
        (e.match(/语言\/框架\*?: (.+)/)?.[1] || ""),
        e.includes("✅ 成功") ? "ok" : "fail",
        e.match(/重试次数\*?: (\d+)/)?.[0] || "",
      ].join("|");
      return fp !== thisFingerprint;
    });

    // 失败优先：失败条目排前面，成功条目排后面
    const failEntries = entries.filter(e => e.includes("❌ 失败"));
    const okEntries = entries.filter(e => e.includes("✅ 成功"));

    // 保留：失败全部保留（最多10条），成功保留最近10条
    const keptFails = failEntries.slice(-10);
    const keptOks = okEntries.slice(-9); // +本次1条=10
    const trimmedEntries = [...keptFails, ...keptOks];

    const newContent = header + "\n---\n" + trimmedEntries.join("\n---\n") + entry;
    await fs.writeFile(knowledgePath, newContent, "utf-8");

    await AuditLogger.log(WORKSPACE, "Post Mortem", `**复盘完成:** ${isSuccessful ? "成功" : "失败"}，retryCount=${round}，经验已写入 KNOWLEDGE.md`);
  } catch (e: any) {
    // 写入失败不应阻塞流程
    await AuditLogger.log(WORKSPACE, "Post Mortem", `**Warning:** 写入 KNOWLEDGE.md 失败: ${e.message}`);
  }

  // ── 5. 更新会议纪要 ──
  const meetingSummary = isSuccessful
    ? `复盘：成功，retryCount=${round}，${filesCreated}文件`
    : `复盘：失败，retryCount=${round}，${failureAnalysis.slice(0, 50)}`;

  const result = {
    teamChatLog: [{ sender: agents.pm.getPersona().name, content: "复盘完成。" }],
  };
  await saveBoulder({ ...state, ...result }, "post_mortem");
  return result;
}

/**
 * 推测失败根因
 */
function guessRootCause(state: JimClawState): string {
  const testResults = state.testResults || "";
  const lastNode = state.lastFailedNode || "";
  const lang = state.spec?.language?.toLowerCase() || "";

  // 按优先级检查
  if (/429|余额不足|rate limit|quota/i.test(testResults)) {
    return "API 服务限流或额度不足，非代码问题";
  }
  if (/基础设施异常|Critical Error/i.test(testResults)) {
    return "基础设施层异常（Docker/网络/端口）";
  }
  if (lastNode === "deploy" && state.deploymentStatus?.status === "failed") {
    if (lang.includes("java")) {
      return "Spring Boot 在 host 模式下启动慢，health check 超时";
    }
    return "服务启动后 health check 未通过（时序/端口/路由）";
  }
  if (/BUILD FAILURE/i.test(testResults)) {
    return "构建失败（依赖缺失/编译错误）";
  }
  if (/FAIL.*test|Tests run:.*Failures: [1-9]/i.test(testResults)) {
    return "单元测试断言失败，Coder 修复未能解决问题";
  }
  if ((state.issueTracker || []).some((i: any) => /协议.*未通过|protocol/i.test(i.title || ""))) {
    return "QA 协议验证阻塞，可能是过度严格的验收标准";
  }

  return "";
}

/**
 * 生成改进建议
 */
function generateSuggestions(state: JimClawState, isSuccessful: boolean): string {
  if (isSuccessful) {
    const round = state.retryCount || 0;
    if (round === 0) {
      return "零重试路径稳定，可作为基线参考。";
    }
    return `分析 ${round} 轮重试的原因，考虑在脚手架/架构师阶段预防。`;
  }

  const suggestions: string[] = [];
  const testResults = state.testResults || "";
  const lang = state.spec?.language?.toLowerCase() || "";
  const lastNode = state.lastFailedNode || "";

  if (/BUILD FAILURE/i.test(testResults) && lang.includes("java")) {
    suggestions.push("检查 Maven 依赖是否完整，考虑增加 pom.xml 脚手架覆盖");
  }
  if (lastNode === "deploy") {
    suggestions.push("增加 health check 超时时间或改善服务启动速度");
  }
  if ((state.issueTracker || []).length > 5) {
    suggestions.push("问题过多，考虑简化需求或改善初始代码生成质量");
  }
  if (lang !== "javascript" && lang !== "typescript") {
    suggestions.push("非 TS 语言路径可能需要额外的脚手架支持");
  }

  if (suggestions.length === 0) {
    suggestions.push("需要人工分析 audit 日志确定根因");
  }

  return suggestions.join("；");
}
