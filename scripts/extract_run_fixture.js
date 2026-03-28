#!/usr/bin/env node
require("ts-node/register/transpile-only");

const path = require("path");
const { writeRunFixture } = require("../src/utils/run_fixture");

async function main() {
  const runDir = process.argv[2];
  const outputArg = process.argv[3];

  if (!runDir) {
    console.error("用法: node scripts/extract_run_fixture.js <runDir> [outputFile]");
    process.exit(1);
  }

  const resolvedRunDir = path.resolve(runDir);
  const outputFile = outputArg
    ? path.resolve(outputArg)
    : path.join(process.cwd(), "tests", "fixtures", "runs", `${path.basename(resolvedRunDir)}.json`);

  const fixture = await writeRunFixture(resolvedRunDir, outputFile);
  console.log(`已提取 run fixture: ${fixture.sourceRun}`);
  console.log(`输出文件: ${outputFile}`);
}

main().catch((error) => {
  console.error("提取 run fixture 失败:", error);
  process.exit(1);
});
