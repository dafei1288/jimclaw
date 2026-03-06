import chalk from "chalk";

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function typeWriter(sender: string, color: any, message: string) {
  process.stdout.write(color(`[${sender}] `));
  for (let char of message) {
    process.stdout.write(char);
    await (sleep(20) as any);
  }
  process.stdout.write("\n");
  await (sleep(1000) as any);
}

async function startDemo() {
  console.log(chalk.bold.cyan("\n🚀 JimClaw Multi-Agent System: Live Demo\n"));
  console.log(chalk.gray("Project: Simple Counter Implementation"));
  console.log(chalk.gray("--------------------------------------\n"));

  await typeWriter("Alex (PM)", chalk.blue, "Team, we need a Counter class with increment and decrement methods.");
  await typeWriter("Sofia (Arch)", chalk.magenta, "Acknowledged. Leo, follow the CounterState interface.");
  await typeWriter("Leo (Coder)", chalk.yellow, "Initial code is ready with increment function.");
  
  console.log(chalk.gray("\n--- Running Tests (Attempt 1) ---"));
  await sleep(1000);
  console.log(chalk.red("✖ Test Failed: 'decrement' is not a function"));
  console.log(chalk.gray("---------------------------------\n"));

  await typeWriter("Iris (QA)", chalk.green, "Leo, you forgot the decrement method! Fix it.");
  await typeWriter("Leo (Coder)", chalk.yellow, "My bad! Added decrement function now.");

  console.log(chalk.gray("\n--- Running Tests (Attempt 2) ---"));
  await sleep(1000);
  console.log(chalk.green("✔ All Tests Passed! 100% Coverage"));
  console.log(chalk.gray("---------------------------------\n"));

  await typeWriter("Iris (QA)", chalk.green, "Perfect. Alex, we're ready for review.");
  await typeWriter("Alex (PM)", chalk.blue, "Excellent work team!");

  console.log(chalk.bold.cyan("\n✅ Mission Accomplished: Counter implementation delivered.\n"));
}

startDemo().catch(console.error);
