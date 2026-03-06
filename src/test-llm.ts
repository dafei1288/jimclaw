import { ModelManager } from "./utils/models";
import { HumanMessage } from "@langchain/core/messages";

async function testLLM() {
  console.log("🚀 Testing LLM configuration...");

  try {
    ModelManager.loadConfig();
    console.log("✅ Configuration loaded successfully.");

    const agentsToTest = ["pm", "architect", "coder", "qa"];

    for (const agent of agentsToTest) {
      console.log(`
--- Testing Agent: ${agent} ---`);
      try {
        const model = ModelManager.createModelForAgent(agent);
        const response = await model.invoke([
          new HumanMessage("Hello, who are you? Please respond in one sentence.")
        ]);
        const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
        console.log(`✅ ${agent} responded: ${content}`);
      } catch (error: any) {
        console.error(`❌ Error testing agent ${agent}:`, error);
      }
    }

  } catch (error: any) {
    console.error("❌ Critical error:", error.message);
  }
}

testLLM().catch(console.error);
