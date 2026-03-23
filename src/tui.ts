import chalk from "chalk";
import { Team } from "./agents/team";
import { createJimClawGraph } from "./core/graph";

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

function agentColor(sender: string) {
  const agentKey = Object.keys(Team).find(key => (Team as any)[key].getPersona().name === sender);
  const colorName = agentKey ? (Team as any)[agentKey].getPersona().color : null;
  
  if (colorName && (chalk as any)[colorName]) {
    return (chalk as any)[colorName];
  }

  // Fallback for hardcoded names if metadata is missing
  if (sender.includes("观止")) return chalk.cyan;
  if (sender.includes("独孤")) return chalk.yellow;
  if (sender.includes("星河")) return chalk.green;
  if (sender.includes("清扬")) return chalk.magenta;
  return chalk.gray;
}

function printSection(title: string) {
  console.log(chalk.bold.cyan(`\n┌─ ${title}`));
}

function printKV(key: string, value: string) {
  console.log(`  ${chalk.gray(key + ":")} ${chalk.white(value)}`);
}

function printList(items: string[], indent = "    ") {
  items.forEach((item) => console.log(chalk.gray(`${indent}•`) + " " + chalk.white(item)));
}

// ── onEvent 回调（处理图内 emit() 事件） ──────────────────────────────────────

function makeOnEvent() {
  return (event: { type: string; sender: string; content: string; metadata?: any }) => {
    const { type, sender, content, metadata } = event;
    const color = agentColor(sender);

    if (type === "thinking" && !content.startsWith("LLM")) {
      console.log(chalk.dim(`  ${color("▸")} ${color(sender)}: ${content}`));
    } else if (type === "artifact") {
      const m = metadata || {};
      if (m.contract) {
        const c = m.contract;
        if (c.title) printKV("  契约标题", c.title);
        if (c.requirements?.length) {
          console.log(chalk.gray("  需求:"));
          printList(c.requirements);
        }
        if (c.acceptanceCriteria?.length) {
          console.log(chalk.gray("  验收标准:"));
          printList(c.acceptanceCriteria);
        }
      }
      if (m.spec) {
        const s = m.spec;
        if (s.language) printKV("  语言", s.language);
        if (s.architecture) printKV("  架构", s.architecture);
        if (s.testCommand) printKV("  测试命令", s.testCommand);
        if (s.filesToCreate?.length) {
          console.log(chalk.gray("  计划文件:"));
          printList(s.filesToCreate);
        }
      }
    }
  };
}

// ── 每个节点的状态渲染 ────────────────────────────────────────────────────────

function renderNodeState(nodeName: string, stateUpdate: any) {
  // 显示新增的团队消息（每个节点只推入自己的新消息，是增量不是全量）
  if (stateUpdate.teamChatLog?.length > 0) {
    stateUpdate.teamChatLog.forEach((log: any) => {
      const color = agentColor(log.sender);
      console.log(`  ${color(`[${log.sender}]`)} ${chalk.bold(log.content)}`);
    });
  }

  switch (nodeName) {
    case "pm":
      if (stateUpdate.contract) {
        const c = stateUpdate.contract;
        if (c.title) printKV("  契约标题", c.title);
        if (c.requirements?.length) {
          console.log(chalk.gray("  需求:"));
          printList(c.requirements);
        }
        if (c.acceptanceCriteria?.length) {
          console.log(chalk.gray("  验收标准:"));
          printList(c.acceptanceCriteria);
        }
      }
      break;

    case "architect":
      if (stateUpdate.spec) {
        const s = stateUpdate.spec;
        if (s.language) printKV("  语言", s.language);
        if (s.architecture) printKV("  架构", s.architecture);
        if (s.testCommand) printKV("  测试命令", s.testCommand);
        if (s.runCommand) printKV("  运行命令", s.runCommand);
        if (s.filesToCreate?.length) {
          console.log(chalk.gray("  计划创建文件:"));
          printList(s.filesToCreate);
        }
      }
      if (stateUpdate.apiContract?.endpoints?.length) {
        console.log(chalk.gray("  API 端点:"));
        stateUpdate.apiContract.endpoints.forEach((ep: any) => {
          console.log(
            "    " + chalk.cyan(`${ep.method} ${ep.path}`) + chalk.gray(` — ${ep.description}`)
          );
        });
      }
      break;

    case "contract_sync":
      if (stateUpdate.apiContract) {
        console.log(chalk.gray(`  契约端点数: ${stateUpdate.apiContract.endpoints?.length ?? 0}`));
      }
      break;

    case "orchestrator":
      if (stateUpdate.subTasks?.length) {
        console.log(chalk.gray(`  拆解为 ${stateUpdate.subTasks.length} 个子任务:`));
        stateUpdate.subTasks.forEach((t: any, i: number) => {
          console.log(
            chalk.gray(`    ${i + 1}.`) +
              " " +
              chalk.white(`[${t.fileTarget}]`) +
              " " +
              chalk.gray(t.description)
          );
        });
      }
      break;

    case "coder": {
      const retry = (stateUpdate.retryCount ?? 1) - 1;
      if (retry > 0) console.log(chalk.yellow(`  重试轮次: ${retry}`));
      if (stateUpdate.subTasks?.length) {
        const done = stateUpdate.subTasks.filter((t: any) => t.status === "completed");
        const failed = stateUpdate.subTasks.filter((t: any) => t.status === "failed");
        console.log(
          chalk.gray("  文件完成情况: ") +
            chalk.green(`${done.length} 完成`) +
            (failed.length ? chalk.red(` | ${failed.length} 失败`) : "")
        );
        done.forEach((t: any) => console.log(chalk.green(`    ✓ ${t.fileTarget}`)));
        failed.forEach((t: any) => {
          console.log(chalk.red(`    ✗ ${t.fileTarget}`));
          if (t.lastError) {
            console.log(chalk.red(`      └ ${t.lastError.slice(0, 150)}`));
          }
        });
      }
      break;
    }

    case "terminal":
      if (stateUpdate.testResults) {
        const raw: string = stateUpdate.testResults;
        const isSuccess =
          !raw.toLowerCase().includes("failed") && !raw.toLowerCase().includes("error");
        console.log(
          chalk.bold[isSuccess ? "green" : "red"](`  测试结果: ${isSuccess ? "通过 ✓" : "失败 ✗"}`)
        );
        const lines = raw
          .split("\n")
          .filter((l) => l.trim())
          .slice(0, 25);
        lines.forEach((line) => {
          const isErr =
            line.toLowerCase().includes("error") || line.toLowerCase().includes("fail");
          console.log(chalk[isErr ? "red" : "gray"](`    ${line}`));
        });
        if (raw.split("\n").length > 25) {
          console.log(chalk.gray("    ... (输出已截断)"));
        }
      }
      break;

    case "qa":
      if (stateUpdate.isDone !== undefined) {
        console.log(
          stateUpdate.isDone
            ? chalk.bold.green("  QA 评估: 达标 ✓")
            : chalk.bold.red("  QA 评估: 不达标 ✗")
        );
      }
      if (stateUpdate.testResults) {
        console.log(chalk.gray("  反馈: ") + chalk.white(stateUpdate.testResults.slice(0, 400)));
      }
      if (stateUpdate.qaFailures) {
        const f = stateUpdate.qaFailures;
        if (f.failedFiles?.length) {
          console.log(chalk.red("  失败文件:"));
          f.failedFiles.forEach((file: string) => console.log(chalk.red(`    • ${file}`)));
        }
        if (f.testErrors?.length) {
          console.log(chalk.red("  错误信息:"));
          f.testErrors
            .slice(0, 5)
            .forEach((err: string) => console.log(chalk.red(`    └ ${err.slice(0, 180)}`)));
        }
        if (f.failedTestNames?.length) {
          console.log(chalk.red("  失败测试: ") + chalk.red(f.failedTestNames.join(", ")));
        }
      }
      break;

    case "deploy":
      if (stateUpdate.deploymentStatus) {
        const d = stateUpdate.deploymentStatus;
        const statusColor = d.status === "running" ? chalk.green : chalk.red;
        console.log(statusColor(`  部署状态: ${d.status}`));
        if (d.url) printKV("  访问地址", d.url);
      }
      break;

    case "post_mortem":
      console.log(chalk.gray("  复盘摘要已生成，追加至 KNOWLEDGE.md。"));
      break;

    case "architect_mediation":
      if (stateUpdate.mediationDirectives?.length) {
        console.log(chalk.magenta(`  仲裁发现 ${stateUpdate.mediationDirectives.length} 个冲突点，修复指令：`));
        stateUpdate.mediationDirectives.forEach((d: any) => {
          console.log(chalk.magenta(`    [${d.file}]`) + chalk.white(` ${d.action}: ${d.detail.slice(0, 100)}`));
        });
      }
      break;

    case "persistence":
      console.log(chalk.gray("  会话已归档至 workspace/。"));
      break;
  }
}

// ── 节点标题映射 ──────────────────────────────────────────────────────────────

const NODE_LABELS: Record<string, string> = {
  pm: "产品经理 观止 · 定义任务契约",
  architect: "架构师 独孤 · 技术设计",
  contract_sync: "测试工程师 清扬 · 契约校验",
  approval: "人工审批",
  orchestrator: "产品经理 观止 · 任务拆解",
  coder: "开发 星河 · 编码与自检",
  architect_mediation: "架构师 独孤 · 冲突仲裁",
  infra_setup: "测试工程师 清扬 · 基础设施",
  terminal: "系统 · 运行测试",
  qa: "测试工程师 清扬 · 质量评估",
  deploy: "系统 · 部署",
  post_mortem: "产品经理 观止 · 复盘",
  persistence: "系统 · 持久化",
};

// ── 主程序 ───────────────────────────────────────────────────────────────────

async function runTUI() {
  const userGoal = process.argv[2] || "a simple Counter app with increment and decrement";

  console.log(chalk.bold.cyan("\n🚀 JimClaw 多智能体协作会话\n"));
  console.log(chalk.gray(`目标: "${userGoal}"`));
  console.log(chalk.gray("─".repeat(60) + "\n"));

  const onEvent = makeOnEvent();
  const app = await createJimClawGraph(Team, onEvent);

  let trackedContainerId: string | null = null;

  try {
    const stream = await app.stream(
      {
        userGoal,
        messages: [],
        teamChatLog: [],
        retryCount: 0,
        isDone: false,
        manifest: null,
        subTasks: [],
        code: "",
        testResults: "",
        qaFailures: null,
        mediationDirectives: null,
        packageJsonHash: "",
        lastFailedNode: "",
        lastFailureSummary: "",
      },
      { recursionLimit: 500 }
    );

    for await (const chunk of stream) {
      const nodeName = Object.keys(chunk)[0];
      const stateUpdate = (chunk as any)[nodeName];
      // 追踪 containerId，用于异常时兜底清理
      if (stateUpdate.containerId) trackedContainerId = stateUpdate.containerId;
      const label = NODE_LABELS[nodeName] || nodeName.toUpperCase();

      printSection(label);
      renderNodeState(nodeName, stateUpdate);
    }

    console.log(chalk.bold.green("\n✅ 会话完成。"));
  } catch (error: any) {
    const msg = error?.message || JSON.stringify(error, null, 2);
    console.error(chalk.bold.red(`\n❌ 会话失败: ${msg}`));
    if (error?.jimclawFailure) {
      console.error(chalk.yellow(`失败节点: ${error.jimclawFailure.node}`));
      console.error(chalk.yellow(`失败摘要: ${error.jimclawFailure.summary}`));
    }
    if (!error?.message) console.error(chalk.red("完整错误:"), error);
    // 兜底清理：图执行异常时 persistence 节点不会运行，需在此处清理孤立容器
    if (trackedContainerId) {
      console.error(chalk.yellow(`\n[兜底清理] 正在移除孤立容器 ${trackedContainerId}...`));
      try {
        const { exec } = await import("child_process");
        const { promisify } = await import("util");
        await promisify(exec)(`docker rm -f ${trackedContainerId} 2>/dev/null || true`);
        console.error(chalk.green(`[兜底清理] 容器已清理`));
      } catch {
        console.error(chalk.red(`[兜底清理] 容器清理失败，请手动执行: docker rm -f ${trackedContainerId}`));
      }
    }
  }
}

runTUI().catch(console.error);
