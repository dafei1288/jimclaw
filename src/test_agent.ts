import { BaseAgent, AgentPersona } from "./core/agent";
import { FileReadSkill } from "./skills/file_read";

async function test() {
  const seekerPersona: AgentPersona = {
    name: "Seeker",
    role: "Researcher",
    specialty: "File analysis and exploration",
    personality: "Extremely curious, methodical, and loves to detail findings.",
  };

  const seeker = new BaseAgent(seekerPersona, [FileReadSkill]);

  console.log("Agent Persona:", seeker.getPersona());
  console.log("Mounted Tools:", seeker.getTools().map(t => t.name));

  console.log("\n--- Validation Successful ---");
  console.log("BaseAgent successfully initialized with persona and skills.");
}

test().catch(console.error);
