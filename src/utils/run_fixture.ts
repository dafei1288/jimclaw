import * as fs from "fs/promises";
import * as path from "path";

async function readJsonIfExists(filePath: string) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

function tailLines(content: string, maxLines = 40) {
  return content
    .split(/\r?\n/)
    .slice(-maxLines)
    .join("\n");
}

export async function buildRunFixture(runDir: string) {
  const boulder = await readJsonIfExists(path.join(runDir, "boulder.json"));
  const traceIndex = await readJsonIfExists(path.join(runDir, "trace-index.json"));
  const tokenUsage = await readJsonIfExists(path.join(runDir, "token-usage.json"));

  const auditDir = path.join(runDir, "audit");
  const nodesDir = path.join(runDir, "nodes");
  let auditFiles: string[] = [];
  let nodeFiles: string[] = [];

  try {
    auditFiles = (await fs.readdir(auditDir)).filter((file) => file.endsWith(".md") || file.endsWith(".jsonl"));
  } catch {}

  try {
    nodeFiles = (await fs.readdir(nodesDir)).filter((file) => file.endsWith(".md"));
  } catch {}

  const audits = Object.fromEntries(await Promise.all(auditFiles.map(async (file) => {
    const content = await readTextIfExists(path.join(auditDir, file));
    return [file, tailLines(content, file.endsWith(".jsonl") ? 80 : 40)];
  })));

  const notes = Object.fromEntries(await Promise.all(nodeFiles.map(async (file) => {
    const content = await readTextIfExists(path.join(nodesDir, file));
    return [file, tailLines(content, 60)];
  })));

  return {
    sourceRun: path.basename(runDir),
    generatedAt: new Date().toISOString(),
    boulder,
    traceIndex,
    tokenUsage,
    audits,
    notes,
  };
}

export async function writeRunFixture(runDir: string, outputFile: string) {
  const fixture = await buildRunFixture(runDir);
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, JSON.stringify(fixture, null, 2), "utf-8");
  return fixture;
}
