import { Team } from "./agents/team";
import { createJimClowGraph } from "./core/graph";

async function simulate() {
  console.log(`🚀 [JimClaw] Starting Simulation Flow...\n`);

  const app = await createJimClowGraph(Team);
  // 模拟流程中的各节点
  let state: any = {
    userGoal: "a simple Counter app with increment and decrement",
    messages: [],
    teamChatLog: [],
    retryCount: 0,
    isDone: false,
    contract: null,
    spec: null,
    manifest: null,
    subTasks: [],
    code: "",
    testResults: "",
  };

  // 注意：在 LangGraph.js 中，编译后的 app 并没有直接暴露 nodes 供手动调用进行逐步测试，
  // 这里的 simulate 脚本如果想要逐个调用节点逻辑，通常需要直接访问节点函数或者使用 app.invoke 并通过断点观察。
  // 为了让此脚本能编译通过并体现流程，我们将其修改为调用 app.invoke 的完整流程测试。
  
  console.log("--- Starting Agentic Workflow (Invoke) ---");
  const finalState = await app.invoke(state, { recursionLimit: 100 });

  console.log(`\n--- Session Completed ---`);
  console.log(`Final Status: ${finalState.isDone ? "SUCCESS" : "FAILED"}`);
  console.log(`Contract: ${finalState.contract?.title}`);
  console.log(`Spec Architecture: ${finalState.spec?.architecture}`);
  
  console.log("\nTeam Conversation History:");
  finalState.teamChatLog.forEach((log: any) => {
    console.log(`[${log.sender}]: ${log.content}`);
  });

  console.log("\nMission accomplished!");
}

simulate().catch(console.error);
