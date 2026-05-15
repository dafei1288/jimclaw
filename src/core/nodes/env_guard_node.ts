import * as fs from "fs/promises";
import * as path from "path";
import { builtinModules } from "module";
import { JimClawState, RepairLedgerEntry, ConsensusProgress } from "../graph_types";
import { createLocalShellAdapter } from "../../skills/shell_exec";
import { host } from "../../infra";
import { createCommandExecutor, ResolvedExecutionIntent } from "../../executor/command_executor";
import { CapabilitySnapshot, ExecutorBackend, ExecutorResult } from "../../executor/types";
import { AuditLogger } from "../../utils/audit";
import { buildRepairPlan, buildValidationReport, getDeterministicTemplateScaffold } from "../logic_utils";

function isNodeLikeProject(language?: string): boolean {
  const lang = String(language || "").toLowerCase();
  return /typescript|javascript|node/.test(lang);
}

function truncateForLog(s: string, max = 1200): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}\n...(truncated)` : s;
}

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((item) => `node:${item}`)]);
const KNOWN_DEP_VERSIONS: Record<string, string> = {
  express: "^4.18.2",
  cors: "^2.8.5",
  jsonwebtoken: "^9.0.2",
  uuid: "^9.0.1",
  bcryptjs: "^2.4.3",
  morgan: "^1.10.0",
  helmet: "^7.1.0",
  "rate-limiter-flexible": "^5.0.5",
  supertest: "^7.1.1",
  jest: "^29.7.0",
  "ts-jest": "^29.1.1",
  typescript: "^5.3.3",
  "ts-node": "^10.9.2",
};
const KNOWN_TYPE_DEPENDENCIES: Record<string, string> = {
  express: "^5.0.0",
  cors: "^2.8.17",
  jsonwebtoken: "^9.0.10",
  supertest: "^6.0.3",
  jest: "^29.5.14",
  node: "^22.10.2",
};

function isTrackedSourceFile(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath);
}

function isDevOnlyFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return normalized.startsWith("tests/")
    || normalized.includes("/__tests__/")
    || /\.test\.[tj]sx?$/.test(normalized)
    || /\.spec\.[tj]sx?$/.test(normalized)
    || /jest\.config\./.test(normalized)
    || normalized.startsWith("scripts/");
}

function normalizePackageName(raw: string): string {
  if (!raw || raw.startsWith(".") || raw.startsWith("/") || NODE_BUILTINS.has(raw)) return "";
  if (raw.startsWith("@")) {
    const parts = raw.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : raw;
  }
  return raw.split("/")[0];
}

function collectImportedPackages(filePath: string, content: string): Array<{ packageName: string; devOnly: boolean }> {
  const found = new Map<string, boolean>();
  const devOnly = isDevOnlyFile(filePath);
  const patterns = [
    /import\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /export\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const packageName = normalizePackageName(match[1]);
      if (!packageName) continue;
      const current = found.get(packageName);
      found.set(packageName, current === undefined ? devOnly : current && devOnly);
    }
  }
  return Array.from(found.entries()).map(([packageName, fileDevOnly]) => ({ packageName, devOnly: fileDevOnly }));
}

async function listTrackedFiles(workspace: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (relativeDir: string) => {
    const absoluteDir = path.join(workspace, relativeDir);
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true }) as Array<{ name: string; isDirectory: () => boolean }>;
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const relativePath = relativeDir ? path.posix.join(relativeDir.replace(/\\/g, "/"), entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(relativePath);
      } else if (isTrackedSourceFile(relativePath)) {
        results.push(relativePath.replace(/\\/g, "/"));
      }
    }
  };
  await walk("");
  return results;
}

function resolveDependencyVersion(
  packageName: string,
  state: JimClawState,
  kind: "dependencies" | "devDependencies"
): string {
  return state.spec?.[kind]?.[packageName]
    || state.spec?.dependencies?.[packageName]
    || state.spec?.devDependencies?.[packageName]
    || KNOWN_DEP_VERSIONS[packageName]
    || "latest";
}

async function closePackageDependencyGaps(
  workspace: string,
  state: JimClawState
): Promise<{ changed: boolean; actions: string[]; code?: string }> {
  const pkgPath = path.join(workspace, "package.json");
  const raw = await fs.readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(raw || "{}");
  const actions: string[] = [];
  const filesContent: Record<string, string> = JSON.parse(state.code || "{}");
  const trackedFiles = new Set<string>([
    ...Object.keys(filesContent).filter(isTrackedSourceFile),
    ...(await listTrackedFiles(workspace)),
  ]);

  const runtimeDeps = { ...(pkg.dependencies || {}) } as Record<string, string>;
  const devDeps = { ...(pkg.devDependencies || {}) } as Record<string, string>;
  let changed = false;

  for (const filePath of trackedFiles) {
    const absolutePath = path.join(workspace, filePath);
    const content = filesContent[filePath] ?? await fs.readFile(absolutePath, "utf-8").catch(() => "");
    if (!content) continue;
    for (const imported of collectImportedPackages(filePath, content)) {
      if (imported.devOnly) {
        if (!runtimeDeps[imported.packageName] && !devDeps[imported.packageName]) {
          devDeps[imported.packageName] = resolveDependencyVersion(imported.packageName, state, "devDependencies");
          actions.push(`补齐测试依赖 ${imported.packageName} -> devDependencies`);
          changed = true;
        }
        continue;
      }

      if (devDeps[imported.packageName] && !runtimeDeps[imported.packageName]) {
        runtimeDeps[imported.packageName] = devDeps[imported.packageName];
        delete devDeps[imported.packageName];
        actions.push(`移动运行时依赖 ${imported.packageName} 到 dependencies`);
        changed = true;
        continue;
      }

      if (!runtimeDeps[imported.packageName]) {
        runtimeDeps[imported.packageName] = resolveDependencyVersion(imported.packageName, state, "dependencies");
        actions.push(`补齐运行时依赖 ${imported.packageName} -> dependencies`);
        changed = true;
      }
    }
  }

  if (!changed) {
    return { changed: false, actions };
  }

  pkg.dependencies = runtimeDeps;
  pkg.devDependencies = devDeps;
  const nextContent = `${JSON.stringify(pkg, null, 2)}\n`;
  await fs.writeFile(pkgPath, nextContent, "utf-8");
  filesContent["package.json"] = nextContent;
  return {
    changed: true,
    actions,
    code: JSON.stringify(filesContent, null, 2),
  };
}

async function normalizePackageJson(workspace: string): Promise<{ changed: boolean; actions: string[] }> {
  const pkgPath = path.join(workspace, "package.json");
  const raw = await fs.readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(raw || "{}");
  const actions: string[] = [];

  const dependencies = { ...(pkg.dependencies || {}) } as Record<string, string>;
  const devDependencies = { ...(pkg.devDependencies || {}) } as Record<string, string>;
  let changed = false;

  for (const dep of Object.keys(dependencies)) {
    if (dep.startsWith("@types/")) {
      devDependencies[dep] = dependencies[dep];
      delete dependencies[dep];
      changed = true;
      actions.push(`移动 ${dep} 到 devDependencies`);
    }
  }

  if ("@types/mongoose" in devDependencies) {
    delete devDependencies["@types/mongoose"];
    changed = true;
    actions.push("移除无效依赖 @types/mongoose");
  }

  if (changed) {
    pkg.dependencies = dependencies;
    pkg.devDependencies = devDependencies;
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  }

  return { changed, actions };
}

function collectEnvironmentEvidence(state: JimClawState): string {
  const fragments = [
    state.testResults || "",
    state.blockedReason || "",
    state.lastFailureSummary || "",
    ...(state.repairPlan?.expectedEvidence || []),
    ...(state.validationReport?.findings || []).flatMap((finding: any) => [
      finding?.summary || "",
      ...(finding?.evidence || []),
    ]),
  ];
  return fragments.filter(Boolean).join("\n");
}

function mapExecutorBackendToLegacy(backend: ExecutorBackend | null | undefined): "docker" | "host" {
  return backend === "docker" ? "docker" : "host";
}

function buildExecutorStatePatch(
  state: JimClawState,
  resolved: ResolvedExecutionIntent,
  result: ExecutorResult
): NonNullable<JimClawState["executorState"]> {
  return {
    version: "v1",
    capabilitySnapshot: resolved.capabilitySnapshot,
    selectedBackend: resolved.resolution.selected,
    approvalTickets: resolved.approvalTicket
      ? [
          ...(state.executorState?.approvalTickets || []),
          resolved.approvalTicket,
        ]
      : (state.executorState?.approvalTickets || []),
    runtimeHandles: state.executorState?.runtimeHandles || [],
    lastExecutorResult: result,
  };
}

function collectCapabilityEvidence(snapshot: CapabilitySnapshot): string[] {
  const evidence: string[] = [];
  if (snapshot.docker.reason) evidence.push(`docker: ${snapshot.docker.reason}`);
  if (snapshot.localShell.reason) evidence.push(`local_shell: ${snapshot.localShell.reason}`);
  if (snapshot.network.reason) evidence.push(`network: ${snapshot.network.reason}`);
  if (snapshot.backgroundProcess.reason) evidence.push(`background: ${snapshot.backgroundProcess.reason}`);
  return evidence;
}

function buildExecutorStateFromResult(
  state: JimClawState,
  snapshot: CapabilitySnapshot,
  result: ExecutorResult
): NonNullable<JimClawState["executorState"]> {
  const approvalTickets = [...(state.executorState?.approvalTickets || [])];
  if (result.requiresApproval && result.approvalTicketId && !approvalTickets.some((ticket) => ticket.id === result.approvalTicketId)) {
    approvalTickets.push({
      id: result.approvalTicketId,
      stage: "network_install",
      required: true,
      status: "pending",
      reason: result.blockedReason || "approval required for install_deps",
      requestedAt: new Date().toISOString(),
    });
  }
  return {
    version: "v1",
    capabilitySnapshot: snapshot,
    selectedBackend: result.backend,
    approvalTickets,
    runtimeHandles: state.executorState?.runtimeHandles || [],
    lastExecutorResult: result,
  };
}

async function hasNodeModules(workspace: string): Promise<boolean> {
  try {
    await fs.access(path.join(workspace, "node_modules"));
    return true;
  } catch {
    return false;
  }
}

function buildExecutorBlockedReason(resolved: ResolvedExecutionIntent): string {
  const reasons = collectCapabilityEvidence(resolved.capabilitySnapshot);
  return [
    resolved.resolution.blockedReason || "no backend available",
    ...reasons,
  ].filter(Boolean).join(" | ");
}

function parseMissingTypePackages(evidence: string): string[] {
  const packages = new Set<string>();
  const patterns = [
    /Could not find a declaration file for module ['"]([^'"]+)['"]/gi,
    /TS7016:.*module ['"]([^'"]+)['"]/gi,
    /TS2307: Cannot find module ['"]([^'"]+)['"] or its corresponding type declarations/gi,
  ];
  for (const pattern of patterns) {
    for (const match of evidence.matchAll(pattern)) {
      const packageName = normalizePackageName(match[1]);
      if (!packageName) continue;
      packages.add(packageName);
    }
  }
  return Array.from(packages);
}

async function closeTypeDependencyGaps(
  workspace: string,
  state: JimClawState,
  evidence: string
): Promise<{ changed: boolean; actions: string[]; code?: string }> {
  const language = String(state.spec?.language || "").toLowerCase();
  if (!language.includes("typescript")) {
    return { changed: false, actions: [] };
  }

  const pkgPath = path.join(workspace, "package.json");
  const raw = await fs.readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(raw || "{}");
  const runtimeDeps = { ...(pkg.dependencies || {}) } as Record<string, string>;
  const devDeps = { ...(pkg.devDependencies || {}) } as Record<string, string>;
  const filesContent: Record<string, string> = JSON.parse(state.code || "{}");
  const actions: string[] = [];

  const candidates = new Set<string>(parseMissingTypePackages(evidence));
  if (runtimeDeps.express) candidates.add("express");
  if (runtimeDeps.cors) candidates.add("cors");
  if (runtimeDeps.jsonwebtoken) candidates.add("jsonwebtoken");
  if (devDeps.supertest || runtimeDeps.supertest) candidates.add("supertest");
  if (devDeps.jest || runtimeDeps.jest) candidates.add("jest");
  candidates.add("node");

  let changed = false;
  for (const packageName of candidates) {
    const typesPackage = packageName === "node" ? "@types/node" : `@types/${packageName}`;
    if (devDeps[typesPackage] || runtimeDeps[typesPackage]) continue;
    const version = KNOWN_TYPE_DEPENDENCIES[packageName];
    if (!version) continue;
    devDeps[typesPackage] = version;
    actions.push(`补齐类型依赖 ${typesPackage} -> devDependencies`);
    changed = true;
  }

  if (!changed) {
    return { changed: false, actions };
  }

  pkg.devDependencies = devDeps;
  const nextContent = `${JSON.stringify(pkg, null, 2)}\n`;
  await fs.writeFile(pkgPath, nextContent, "utf-8");
  filesContent["package.json"] = nextContent;
  return {
    changed: true,
    actions,
    code: JSON.stringify(filesContent, null, 2),
  };
}

function extractOccupiedPort(evidence: string): string {
  const portMatch = evidence.match(/EADDRINUSE[^\n]*?(\d{2,5})/i)
    || evidence.match(/address already in use[^\n:]*[: ](\d{2,5})/i)
    || evidence.match(/port\s+(\d{2,5})/i);
  return portMatch?.[1] || "";
}

function buildHostPortReleaseCommand(port: string): string {
  if (process.platform === "win32") {
    return [
      `$port=${port}`,
      `$conns=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue`,
      `if(-not $conns){ $lines=netstat -ano | Select-String ":$port\\s" }`,
      `if($conns){ $conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }`,
      `elseif($lines){ $lines | ForEach-Object { $parts=($_.ToString() -split "\\s+") | Where-Object { $_ }; if($parts.Length -gt 0){ Stop-Process -Id $parts[-1] -Force -ErrorAction SilentlyContinue } } }`,
    ].join("; ");
  }
  return `fuser -k ${port}/tcp 2>/dev/null || lsof -ti:${port} | xargs kill -9 2>/dev/null || true`;
}

async function ensureBootstrapScaffold(
  workspace: string,
  state: JimClawState
): Promise<{
  changed: boolean;
  code?: string;
  subTasks?: JimClawState["subTasks"];
  consensusProgress?: ConsensusProgress;
  actions: string[];
}> {
  const bootstrapTargets = ["package.json", "tsconfig.json", "jest.config.cjs", "tests/setup.test.ts"];
  const filesContent: Record<string, string> = JSON.parse(state.code || "{}");
  const subTasks = [...(state.subTasks || [])];
  const actions: string[] = [];
  let changed = false;

  for (const fileTarget of bootstrapTargets) {
    const deterministicContent = getDeterministicTemplateScaffold(state, fileTarget);
    if (!deterministicContent) continue;

    const absolutePath = path.join(workspace, fileTarget);
    let fileExists = true;
    try {
      await fs.access(absolutePath);
    } catch {
      fileExists = false;
    }

    if (!fileExists) {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, deterministicContent, "utf-8");
      filesContent[fileTarget] = deterministicContent;
      const relatedTask = subTasks.find((task) => task.fileTarget === fileTarget);
      if (relatedTask) {
        relatedTask.status = "completed";
        delete relatedTask.lastError;
      }
      actions.push(`写入模板骨架 ${fileTarget}`);
      changed = true;
    } else if (filesContent[fileTarget] === undefined) {
      const existing = await fs.readFile(absolutePath, "utf-8");
      filesContent[fileTarget] = existing;
      changed = true;
    }
  }

  if (!changed) {
    return { changed: false, actions };
  }

  const completedFiles = subTasks.filter((task) => task.status === "completed").map((task) => task.fileTarget);
  const pendingFiles = subTasks.filter((task) => task.status !== "completed").map((task) => task.fileTarget);
  return {
    changed: true,
    code: JSON.stringify(filesContent, null, 2),
    subTasks,
    consensusProgress: {
      completedFiles,
      pendingFiles,
      currentRound: state.retryCount || 0,
      openIssues: state.consensusProgress?.openIssues || [],
    },
    actions,
  };
}

/**
 * Env Guard 节点：在 infra 前做环境预检与确定性修复，避免环境问题进入 coder 自旋
 */
export async function envGuardNode(
  state: JimClawState,
  agents: any,
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any,
  deps?: {
    commandExecutor?: Pick<ReturnType<typeof createCommandExecutor>, "probeCapabilities" | "resolveIntent" | "executeIntent">;
  }
) {
  const buildEnvironmentFailurePatch = (
    summary: string,
    evidence: string[],
    extra: Partial<JimClawState> = {}
  ): Partial<JimClawState> => {
    const validationReport = buildValidationReport(
      [{ summary, evidence }],
      { failureType: "environment_gap", blocking: true }
    );
    return {
      validationReport,
      repairPlan: buildRepairPlan(validationReport),
      lastFailedNode: "env_guard",
      lastFailureSummary: summary,
      ...extra,
    };
  };

  startSpan("env_guard");
  emit("phase-change", "System", "environment");

  const round = state.retryCount || 0;
  const ledger: RepairLedgerEntry[] = [];
  const commandExecutor = deps?.commandExecutor || createCommandExecutor({
    adapters: {
      local_shell: createLocalShellAdapter(),
    },
  });
  let selectedBackend: "docker" | "host" = state.executionBackend || "docker";

  if (!isNodeLikeProject(state.spec?.language)) {
    return { envReady: true, blockedReason: "", recoveredEnvironment: false, executionBackend: selectedBackend };
  }

  const pkgPath = path.join(WORKSPACE, "package.json");
  let bootstrapPatch: Partial<JimClawState> = {};
  try {
    await fs.access(pkgPath);
  } catch {
    const bootstrap = await ensureBootstrapScaffold(WORKSPACE, state);
    if (bootstrap.changed) {
      bootstrapPatch = {
        code: bootstrap.code,
        subTasks: bootstrap.subTasks,
        consensusProgress: bootstrap.consensusProgress,
      };
      ledger.push({ round, phase: "env_guard", action: bootstrap.actions.join("；"), result: "success" });
      await AuditLogger.log(WORKSPACE, "Environment", `### [Env Guard Bootstrap]\n\n**Action:** ${bootstrap.actions.join("；")}`);
    }
  }

  try {
    await fs.access(pkgPath);
  } catch {
    const reason = "[EnvGuard] 缺少 package.json，无法安装依赖。";
    ledger.push({ round, phase: "env_guard", action: "检查 package.json", result: "failed" });
    const failurePatch = buildEnvironmentFailurePatch(reason, [reason]);
    await saveBoulder({ ...state, ...bootstrapPatch, ...failurePatch, envReady: false, blockedReason: reason, repairLedger: ledger }, "env_guard_missing_pkg");
    return { ...bootstrapPatch, ...failurePatch, envReady: false, blockedReason: reason, repairLedger: ledger, testResults: `${state.testResults || ""}\n${reason}`.trim() };
  }

  try {
    const environmentEvidence = collectEnvironmentEvidence({ ...state, ...bootstrapPatch } as JimClawState);
    const resolvedIntent = await commandExecutor.resolveIntent(
      {
        kind: "install_deps",
        workspace: WORKSPACE,
        requiresNetwork: true,
      },
      await commandExecutor.probeCapabilities(WORKSPACE)
    );

    if (resolvedIntent.resolution.selected) {
      selectedBackend = mapExecutorBackendToLegacy(resolvedIntent.resolution.selected);
      ledger.push({
        round,
        phase: "env_guard",
        action: `执行控制面选择 backend: ${resolvedIntent.resolution.selected}`,
        result: "success",
      });
      await AuditLogger.log(
        WORKSPACE,
        "Environment",
        `**Action:** 执行控制面选择 backend: ${resolvedIntent.resolution.selected}`
      );
    }

    if (resolvedIntent.resolution.blocked || !resolvedIntent.resolution.selected) {
      const executorBlockedReason = buildExecutorBlockedReason(resolvedIntent);
      const reason = "[EnvGuard] 宿主环境阻塞：当前环境没有可用执行 backend，无法执行 npm install / npm test / npm start。";
      const executorResult: ExecutorResult = {
        ok: false,
        backend: resolvedIntent.resolution.selected,
        stdout: "",
        stderr: executorBlockedReason,
        retryable: false,
        requiresApproval: false,
        blocked: true,
        blockedReason: executorBlockedReason,
      };
      const executorState = buildExecutorStatePatch(state, resolvedIntent, executorResult);
      ledger.push({ round, phase: "env_guard", action: "执行控制面解析 install_deps intent", result: "failed" });
      await AuditLogger.log(
        WORKSPACE,
        "Environment",
        `**Blocked:** ${reason}\n${truncateForLog(executorBlockedReason)}`
      );
      const failurePatch = buildEnvironmentFailurePatch(reason, [
        reason,
        truncateForLog(executorBlockedReason),
      ]);
      await saveBoulder(
        {
          ...state,
          ...bootstrapPatch,
          ...failurePatch,
          envReady: false,
          blockedReason: reason,
          requiresApproval: false,
          repairLedger: ledger,
          executionBackend: selectedBackend,
          executorState,
          agentRecoveryPending: true,
          agentRecoveryNode: "env_guard",
          agentRecoveryReason: executorBlockedReason,
          resumeFromNode: "env_guard",
        },
        "env_guard_host_blocked"
      );
      return {
        ...bootstrapPatch,
        ...failurePatch,
        envReady: false,
        blockedReason: reason,
        requiresApproval: false,
        repairLedger: ledger,
        executionBackend: selectedBackend,
        executorState,
        agentRecoveryPending: true,
        agentRecoveryNode: "env_guard",
        agentRecoveryReason: executorBlockedReason,
        resumeFromNode: "env_guard",
        testResults: `${state.testResults || ""}\n${reason}\n${truncateForLog(executorBlockedReason)}`.trim(),
      };
    }

    if (resolvedIntent.resolution.requiresApproval) {
      const approvalReason = `[EnvGuard] 安装依赖需要授权：${resolvedIntent.resolution.approvalScope || "network_install"}`;
      const executorResult: ExecutorResult = {
        ok: false,
        backend: resolvedIntent.resolution.selected,
        stdout: "",
        stderr: approvalReason,
        retryable: false,
        requiresApproval: true,
        approvalTicketId: resolvedIntent.approvalTicket?.id,
        blocked: true,
        blockedReason: approvalReason,
      };
      const executorState = buildExecutorStatePatch(state, resolvedIntent, executorResult);
      const failurePatch = buildEnvironmentFailurePatch(approvalReason, [
        approvalReason,
        ...collectCapabilityEvidence(resolvedIntent.capabilitySnapshot).map((item) => truncateForLog(item)),
      ]);
      ledger.push({ round, phase: "env_guard", action: "等待依赖安装授权", result: "failed" });
      await AuditLogger.log(
        WORKSPACE,
        "Environment",
        `**Pending Approval:** ${approvalReason}\nTicket: ${resolvedIntent.approvalTicket?.id || "unknown"}`
      );
      await saveBoulder(
        {
          ...state,
          ...bootstrapPatch,
          ...failurePatch,
          envReady: false,
          blockedReason: approvalReason,
          requiresApproval: true,
          repairLedger: ledger,
          executionBackend: selectedBackend,
          executorState,
          agentRecoveryPending: true,
          agentRecoveryNode: "env_guard",
          agentRecoveryReason: approvalReason,
          pendingApprovalTicketId: resolvedIntent.approvalTicket?.id || "",
        },
        "env_guard_approval_required"
      );
      return {
        ...bootstrapPatch,
        ...failurePatch,
        envReady: false,
        blockedReason: approvalReason,
        requiresApproval: true,
        repairLedger: ledger,
        executionBackend: selectedBackend,
        executorState,
        agentRecoveryPending: true,
        agentRecoveryNode: "env_guard",
        agentRecoveryReason: approvalReason,
        pendingApprovalTicketId: resolvedIntent.approvalTicket?.id || "",
        testResults: `${state.testResults || ""}\n${approvalReason}`.trim(),
      };
    }

    const occupiedPort = extractOccupiedPort(environmentEvidence);
    if (occupiedPort) {
      await AuditLogger.log(WORKSPACE, "Environment", `**Action:** 释放占用端口 ${occupiedPort}`);
      await host.killPortProcess(parseInt(occupiedPort, 10));
      ledger.push({ round, phase: "env_guard", action: `释放占用端口 ${occupiedPort}`, result: "success" });
    }

    const closureResult = await closePackageDependencyGaps(WORKSPACE, { ...state, ...bootstrapPatch } as JimClawState);
    if (closureResult.changed) {
      bootstrapPatch = {
        ...bootstrapPatch,
        code: closureResult.code,
      };
      const actionText = closureResult.actions.join("；");
      ledger.push({ round, phase: "env_guard", action: actionText, result: "success" });
      await AuditLogger.log(WORKSPACE, "Environment", `**Action:** ${actionText}`);
    }

    const typeClosure = await closeTypeDependencyGaps(
      WORKSPACE,
      { ...state, ...bootstrapPatch } as JimClawState,
      environmentEvidence
    );
    if (typeClosure.changed) {
      bootstrapPatch = {
        ...bootstrapPatch,
        code: typeClosure.code,
      };
      const actionText = typeClosure.actions.join("；");
      ledger.push({ round, phase: "env_guard", action: actionText, result: "success" });
      await AuditLogger.log(WORKSPACE, "Environment", `**Action:** ${actionText}`);
    }

    const normalized = await normalizePackageJson(WORKSPACE);
    if (normalized.changed) {
      const actionText = normalized.actions.join("；");
      ledger.push({ round, phase: "env_guard", action: actionText, result: "success" });
      await AuditLogger.log(WORKSPACE, "Environment", `**Action:** ${actionText}`);
    }

    const nodeModulesReady = await hasNodeModules(WORKSPACE);
    if (!nodeModulesReady) {
      if (resolvedIntent.resolution.selected === "docker") {
        const actionText = "检测到缺少 node_modules，但当前 backend= docker，改由 infra_setup 容器内统一安装依赖";
        ledger.push({ round, phase: "env_guard", action: actionText, result: "success" });
        await AuditLogger.log(WORKSPACE, "Environment", `**Action:** ${actionText}`);
      } else if (typeof commandExecutor.executeIntent === "function") {
        await AuditLogger.log(WORKSPACE, "Environment", `**Action:** 预安装依赖 (install_deps)`);
        const installResult = await commandExecutor.executeIntent({
          kind: "install_deps",
          workspace: WORKSPACE,
          command: "npm install --include=dev --silent",
          requiresNetwork: true,
        });
        const installExecutorState = buildExecutorStateFromResult(state, resolvedIntent.capabilitySnapshot, installResult);

        if (installResult.requiresApproval) {
          const approvalReason = `[EnvGuard] 预安装依赖需要授权：${installResult.blockedReason || "approval required for install_deps"}`;
          const failurePatch = buildEnvironmentFailurePatch(approvalReason, [
            approvalReason,
            truncateForLog(installResult.stderr || installResult.stdout || ""),
          ]);
          ledger.push({ round, phase: "env_guard", action: "预安装依赖等待授权", result: "failed" });
          await saveBoulder(
            {
              ...state,
              ...bootstrapPatch,
              ...failurePatch,
              envReady: false,
              blockedReason: approvalReason,
              requiresApproval: true,
              repairLedger: ledger,
              executionBackend: selectedBackend,
              executorState: installExecutorState,
              agentRecoveryPending: true,
              agentRecoveryNode: "env_guard",
              agentRecoveryReason: approvalReason,
              pendingApprovalTicketId: installResult.approvalTicketId || "",
            },
            "env_guard_approval_required"
          );
          return {
            ...bootstrapPatch,
            ...failurePatch,
            envReady: false,
            blockedReason: approvalReason,
            requiresApproval: true,
            repairLedger: ledger,
            executionBackend: selectedBackend,
            executorState: installExecutorState,
            agentRecoveryPending: true,
            agentRecoveryNode: "env_guard",
            agentRecoveryReason: approvalReason,
            pendingApprovalTicketId: installResult.approvalTicketId || "",
            testResults: `${state.testResults || ""}\n${approvalReason}`.trim(),
          };
        }

        if (installResult.blocked) {
          const blockedReason = installResult.blockedReason || "no backend available";
          const reason = "[EnvGuard] 宿主环境阻塞：预安装依赖失败，当前环境无法执行 install_deps。";
          const failurePatch = buildEnvironmentFailurePatch(reason, [
            reason,
            truncateForLog(blockedReason),
          ]);
          ledger.push({ round, phase: "env_guard", action: "预安装依赖被阻塞", result: "failed" });
          await saveBoulder(
            {
              ...state,
              ...bootstrapPatch,
              ...failurePatch,
              envReady: false,
              blockedReason: reason,
              requiresApproval: false,
              repairLedger: ledger,
              executionBackend: selectedBackend,
              executorState: installExecutorState,
              agentRecoveryPending: true,
              agentRecoveryNode: "env_guard",
              agentRecoveryReason: blockedReason,
              resumeFromNode: "env_guard",
            },
            "env_guard_host_blocked"
          );
          return {
            ...bootstrapPatch,
            ...failurePatch,
            envReady: false,
            blockedReason: reason,
            requiresApproval: false,
            repairLedger: ledger,
            executionBackend: selectedBackend,
            executorState: installExecutorState,
            agentRecoveryPending: true,
            agentRecoveryNode: "env_guard",
            agentRecoveryReason: blockedReason,
            resumeFromNode: "env_guard",
            testResults: `${state.testResults || ""}\n${reason}\n${truncateForLog(blockedReason)}`.trim(),
          };
        }

        if (!installResult.ok) {
          const summary = `[EnvGuard] 预安装依赖失败：${installResult.stderr || installResult.stdout || "install_deps failed"}`;
          const failurePatch = buildEnvironmentFailurePatch(summary, [
            truncateForLog(installResult.stderr || ""),
            truncateForLog(installResult.stdout || ""),
          ].filter(Boolean));
          ledger.push({ round, phase: "env_guard", action: "执行预安装依赖", result: "failed" });
          await saveBoulder(
            {
              ...state,
              ...bootstrapPatch,
              ...failurePatch,
              envReady: false,
              blockedReason: summary,
              requiresApproval: false,
              repairLedger: ledger,
              executionBackend: selectedBackend,
              executorState: installExecutorState,
              resumeFromNode: "env_guard",
            },
            "env_guard_install_failed"
          );
          return {
            ...bootstrapPatch,
            ...failurePatch,
            envReady: false,
            blockedReason: summary,
            requiresApproval: false,
            repairLedger: ledger,
            executionBackend: selectedBackend,
            executorState: installExecutorState,
            resumeFromNode: "env_guard",
            testResults: `${state.testResults || ""}\n${summary}`.trim(),
          };
        }

        ledger.push({ round, phase: "env_guard", action: "执行预安装依赖 (install_deps)", result: "success" });
        await AuditLogger.log(
          WORKSPACE,
          "Environment",
          `**Action:** 预安装依赖成功\n${truncateForLog(installResult.stdout || "")}`
        );
      }
    }

    const backendAction = selectedBackend === "host"
      ? "选择 host backend，等待 infra_setup 在宿主机安装依赖"
      : "跳过宿主机 npm install，等待 infra_setup 容器内安装";
    const executorResult: ExecutorResult = {
      ok: true,
      backend: resolvedIntent.resolution.selected,
      stdout: "",
      stderr: "",
      retryable: false,
      requiresApproval: false,
      blocked: false,
    };
    const executorState = buildExecutorStatePatch(state, resolvedIntent, executorResult);
    await AuditLogger.log(
      WORKSPACE,
      "Environment",
      `### [Env Guard]\n\n**Action:** ${backendAction}`
    );
    ledger.push({
      round,
      phase: "env_guard",
      action: backendAction,
      result: "success",
    });
    const result = {
      ...bootstrapPatch,
      envReady: true,
      blockedReason: "",
      recoveredEnvironment: false,
      repairLedger: ledger,
      executionBackend: selectedBackend,
      executorState,
      requiresApproval: false,
      agentRecoveryPending: false,
      agentRecoveryNode: "",
      agentRecoveryReason: "",
    };
    await saveBoulder({ ...state, ...result }, "env_guard_ready");
    return result;
  } catch (e: any) {
    const reason = `[EnvGuard] 环境预检异常：${e.message || e}`;
    ledger.push({ round, phase: "env_guard", action: "环境预检", result: "failed" });
    const failurePatch = buildEnvironmentFailurePatch(reason, [String(e?.message || e || reason)]);
    await saveBoulder({ ...state, ...bootstrapPatch, ...failurePatch, envReady: false, blockedReason: reason, repairLedger: ledger }, "env_guard_exception");
    return { ...bootstrapPatch, ...failurePatch, envReady: false, blockedReason: reason, repairLedger: ledger, testResults: `${state.testResults || ""}\n${reason}`.trim() };
  }
}
