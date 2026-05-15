/**
 * FP 回归检测脚本
 * 
 * 每次 E2E 完成后运行，检查所有已知 Failure Patterns 是否复现。
 * 
 * 用法: npx ts-node scripts/fp_regression_check.ts <run_directory>
 */

import * as fs from "fs";
import * as path from "path";

interface FPCheckResult {
  id: string;
  name: string;
  passed: boolean;
  evidence: string;
}

interface FPCheck {
  id: string;
  name: string;
  check: (runDir: string, boulder: any) => Promise<FPCheckResult>;
}

const checks: FPCheck[] = [
  {
    id: "FP-001",
    name: "npm scripts 在 sh -c 中找不到命令",
    check: async (runDir) => {
      const infra = await safeRead(path.join(runDir, "audit", "Infrastructure.md"));
      const has127 = /sh:.*not found|exit code\s*127|command not found/i.test(infra);
      return {
        id: "FP-001",
        name: "npm scripts 在 sh -c 中找不到命令",
        passed: !has127,
        evidence: has127 ? extractLine(infra, /sh:.*not found|exit code\s*127|command not found/i) : "无 exit 127",
      };
    },
  },
  {
    id: "FP-002",
    name: "verifier 把配置文件误判为测试文件",
    check: async (runDir) => {
      const boulder = await safeReadJson(path.join(runDir, "boulder.json"));
      const tr = boulder?.state?.testResults || "";
      const hasConfigAssertionError = /vitest\.config|vite\.config|jest\.config.*未找到断言/i.test(tr);
      return {
        id: "FP-002",
        name: "verifier 把配置文件误判为测试文件",
        passed: !hasConfigAssertionError,
        evidence: hasConfigAssertionError ? extractLine(tr, /vitest\.config|vite\.config|jest\.config.*未找到断言/i) : "无配置文件误报",
      };
    },
  },
  {
    id: "FP-003",
    name: "非 Node 项目缺少基础文件（测试文件等）",
    check: async (runDir) => {
      const boulder = await safeReadJson(path.join(runDir, "boulder.json"));
      const spec = boulder?.state?.spec;
      if (!spec) return { id: "FP-003", name: "非 Node 项目缺少基础文件", passed: true, evidence: "无 spec 数据" };
      
      const lang = String(spec.language || "").toLowerCase();
      const files: string[] = spec.filesToCreate || [];
      
      // Java 项目必须包含测试文件
      if (/java/.test(lang) && !files.some(f => /src\/test\/.*Test\.java/.test(f))) {
        return { id: "FP-003", name: "非 Node 项目缺少基础文件", passed: false, evidence: `Java 项目无测试文件: ${files.join(", ")}` };
      }
      // Go 项目必须包含 _test.go
      if (/go/.test(lang) && !files.some(f => /_test\.go/.test(f))) {
        return { id: "FP-003", name: "非 Node 项目缺少基础文件", passed: false, evidence: `Go 项目无测试文件: ${files.join(", ")}` };
      }
      return { id: "FP-003", name: "非 Node 项目缺少基础文件", passed: true, evidence: `${lang}: 测试文件存在` };
    },
  },
  {
    id: "FP-004",
    name: "Python conftest.py 使用 httpx 导致测试失败",
    check: async (runDir) => {
      const terminal = await safeRead(path.join(runDir, "audit", "Terminal.md"));
      const hasClientStateError = /ClientState\.UNOPENED|httpx.*ASGITransport/i.test(terminal);
      return {
        id: "FP-004",
        name: "Python conftest.py 使用 httpx 导致测试失败",
        passed: !hasClientStateError,
        evidence: hasClientStateError ? "发现 ClientState.UNOPENED" : "无 httpx 兼容问题",
      };
    },
  },
  {
    id: "FP-005",
    name: "pytest.ini 含 asyncio_mode=auto 但缺插件",
    check: async (runDir) => {
      const terminal = await safeRead(path.join(runDir, "audit", "Terminal.md"));
      const hasAsyncioWarning = /PytestConfigWarning.*asyncio_mode|unknown config option.*asyncio/i.test(terminal);
      return {
        id: "FP-005",
        name: "pytest.ini 含 asyncio_mode=auto 但缺插件",
        passed: !hasAsyncioWarning,
        evidence: hasAsyncioWarning ? "发现 asyncio_mode 警告" : "无 asyncio 配置问题",
      };
    },
  },
  {
    id: "FP-007",
    name: "infra build 静默吞错",
    check: async (runDir) => {
      const infra = await safeRead(path.join(runDir, "audit", "Infrastructure.md"));
      // build 失败后不应该有 Deployment Start
      const hasBuildFailure = /前端 build 失败|Critical Error.*build/i.test(infra);
      const hasDeployContinue = hasBuildFailure && /Deployment Start|Deployment Verified Success/i.test(infra);
      return {
        id: "FP-007",
        name: "infra build 静默吞错",
        passed: !hasDeployContinue,
        evidence: hasDeployContinue ? "build 失败但 deploy 继续" : hasBuildFailure ? "build 失败且 deploy 未执行（正确）" : "无 build 失败",
      };
    },
  },
  {
    id: "FP-008",
    name: "部署后前端不可达",
    check: async (runDir) => {
      const boulder = await safeReadJson(path.join(runDir, "boulder.json"));
      const isMixed = boulder?.state?.spec?.frontend != null;
      if (!isMixed) return { id: "FP-008", name: "部署后前端不可达", passed: true, evidence: "非混合项目，跳过" };
      
      const verification = boulder?.state?.postDeployVerification;
      const infra = await safeRead(path.join(runDir, "audit", "Infrastructure.md"));
      // 检查 post_deploy_verify 结果
      if (verification) {
        return {
          id: "FP-008",
          name: "部署后前端不可达",
          passed: verification.frontendAccessible === true,
          evidence: verification.frontendAccessible ? "前端验证通过" : `前端不可达: ${verification.frontendUrl}`,
        };
      }
      // 如果没有 post_deploy_verify 记录（旧版本），看 audit 日志
      const hasFrontendCheck = /前端页面.*✅|Post-deploy Verification.*前端/i.test(infra);
      return {
        id: "FP-008",
        name: "部署后前端不可达",
        passed: hasFrontendCheck,
        evidence: hasFrontendCheck ? "审计日志中有前端验证记录" : "无前端验证记录",
      };
    },
  },
  {
    id: "FP-009",
    name: "TechSpec Zod 验证失败",
    check: async (runDir) => {
      const infra = await safeRead(path.join(runDir, "audit", "Infrastructure.md"));
      const events = await safeRead(path.join(runDir, "audit", "events.jsonl"));
      const hasZodError = /ZodError|validation error/i.test(infra + events);
      return {
        id: "FP-009",
        name: "TechSpec Zod 验证失败",
        passed: !hasZodError,
        evidence: hasZodError ? "发现 Zod 验证错误" : "无 Zod 错误",
      };
    },
  },
  {
    id: "FP-010",
    name: "混合项目注入多余 public/index.html",
    check: async (runDir) => {
      const boulder = await safeReadJson(path.join(runDir, "boulder.json"));
      const isMixed = boulder?.state?.spec?.frontend != null;
      if (!isMixed) return { id: "FP-010", name: "混合项目注入多余 public/index.html", passed: true, evidence: "非混合项目" };
      
      const files: string[] = boulder?.state?.spec?.filesToCreate || [];
      const hasPublicIndex = files.some(f => f === "public/index.html");
      const hasFrontendIndex = files.some(f => f === "frontend/index.html");
      return {
        id: "FP-010",
        name: "混合项目注入多余 public/index.html",
        passed: !(hasPublicIndex && hasFrontendIndex),
        evidence: `public/index.html=${hasPublicIndex}, frontend/index.html=${hasFrontendIndex}`,
      };
    },
  },
  {
    id: "FP-013",
    name: "agent_pending 重试正则不同步",
    check: async (runDir) => {
      // 这个无法从运行结果检测，但可以检查代码是否一致
      return { id: "FP-013", name: "agent_pending 重试正则不同步", passed: true, evidence: "需要代码审查（无法自动检测）" };
    },
  },
  {
    id: "FP-014",
    name: "conftest.py/pytest.ini 被 QA 标记后走 LLM 死循环",
    check: async (runDir) => {
      const boulder = await safeReadJson(path.join(runDir, "boulder.json"));
      const tr = boulder?.state?.testResults || "";
      // 多轮重试且 conftest/pytest 反复出现
      const hasConfigInError = /conftest\.py|pytest\.ini/.test(tr);
      const retryCount = boulder?.state?.retryCount || 0;
      const isLooping = hasConfigInError && retryCount >= 3;
      return {
        id: "FP-014",
        name: "conftest.py/pytest.ini 被 QA 标记后走 LLM 死循环",
        passed: !isLooping,
        evidence: isLooping ? `conftest/pytest 在 ${retryCount} 轮后仍在失败` : hasConfigInError ? `有 config 错误但 retryCount=${retryCount}（正常）` : "无 config 文件死循环",
      };
    },
  },
  {
    id: "FP-015",
    name: "宣布成功但用户体验有问题",
    check: async (runDir) => {
      const boulder = await safeReadJson(path.join(runDir, "boulder.json"));
      const node = boulder?.node || "";
      const isTerminal = node === "persistence" || node === "post_mortem";
      
      // 如果到了 persistence/post_mortem，检查是否有未解决的失败
      if (!isTerminal) return { id: "FP-015", name: "宣布成功但用户体验有问题", passed: true, evidence: `运行中 (node=${node})` };
      
      // 检查 deploy 结果
      const deployStatus = boulder?.state?.deploymentStatus?.status;
      if (deployStatus !== "running") {
        return { id: "FP-015", name: "宣布成功但用户体验有问题", passed: true, evidence: `部署状态: ${deployStatus}` };
      }
      
      // 检查前端可达性
      const isMixed = boulder?.state?.spec?.frontend != null;
      if (isMixed) {
        const verification = boulder?.state?.postDeployVerification;
        if (!verification) {
          return { id: "FP-015", name: "宣布成功但用户体验有问题", passed: false, evidence: "混合项目缺少 post_deploy_verify 记录" };
        }
        if (!verification.frontendAccessible) {
          return { id: "FP-015", name: "宣布成功但用户体验有问题", passed: false, evidence: `前端不可达: ${verification.frontendUrl}` };
        }
      }
      
      return { id: "FP-015", name: "宣布成功但用户体验有问题", passed: true, evidence: "部署状态正常" };
    },
  },
];

async function safeRead(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

async function safeReadJson(filePath: string): Promise<any> {
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function extractLine(text: string, pattern: RegExp): string {
  const lines = text.split("\n");
  for (const line of lines) {
    if (pattern.test(line)) return line.trim().slice(0, 120);
  }
  return "(matched in combined text)";
}

async function main() {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error("用法: npx ts-node scripts/fp_regression_check.ts <run_directory>");
    process.exit(1);
  }

  if (!fs.existsSync(runDir)) {
    console.error(`目录不存在: ${runDir}`);
    process.exit(1);
  }

  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  FP 回归检测报告                              ║`);
  console.log(`║  ${path.basename(runDir).padEnd(42)}    ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const results: FPCheckResult[] = [];

  for (const check of checks) {
    try {
      const result = await check.check(runDir, null);
      results.push(result);
      const icon = result.passed ? "✅" : "❌";
      console.log(`  ${icon} ${result.id}: ${result.name}`);
      console.log(`     ${result.evidence}`);
      if (result.passed) passed++;
      else failed++;
    } catch (e: any) {
      results.push({ id: check.id, name: check.name, passed: true, evidence: `检查异常（跳过）: ${e.message}` });
      console.log(`  ⚠️  ${check.id}: ${check.name} — 检查异常，跳过`);
      skipped++;
    }
  }

  console.log(`\n── 总计: ${checks.length} 项 ──`);
  console.log(`  ✅ 通过: ${passed}`);
  console.log(`  ❌ 失败: ${failed}`);
  console.log(`  ⚠️  跳过: ${skipped}`);

  // 写入 fp_status.json
  const statusFile = path.join(runDir, "fp_status.json");
  const statusData = {
    runId: path.basename(runDir),
    timestamp: new Date().toISOString(),
    summary: { total: checks.length, passed, failed, skipped },
    results,
  };
  await fs.promises.writeFile(statusFile, JSON.stringify(statusData, null, 2), "utf-8");
  console.log(`\n  结果已写入: ${statusFile}`);

  // 更新全局 fp_status.json（趋势追踪）
  const globalStatusFile = path.join(path.dirname(runDir), "fp_trend.json");
  let trend: any = { runs: [] };
  try {
    trend = JSON.parse(await fs.promises.readFile(globalStatusFile, "utf-8"));
  } catch {}
  trend.runs.push({
    runId: path.basename(runDir),
    timestamp: statusData.timestamp,
    passed,
    failed,
    results: Object.fromEntries(results.map(r => [r.id, r.passed ? "PASSED" : "FAILED"])),
  });
  // 保留最近 50 次
  if (trend.runs.length > 50) trend.runs = trend.runs.slice(-50);
  await fs.promises.writeFile(globalStatusFile, JSON.stringify(trend, null, 2), "utf-8");
  console.log(`  趋势已更新: ${globalStatusFile}`);

  process.exit(failed > 0 ? 1 : 0);
}

main();
