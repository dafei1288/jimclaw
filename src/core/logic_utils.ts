/**
 * logic_utils.ts - JimClaw 核心逻辑工具集
 *
 * 本文件是系统各节点共享的工具函数库。按功能域组织如下:
 *
 * ┌─ 模块目录 ─────────────────────────────────────────────────────────────┐
 * │ §1  基础工具          (L36-165)    时间、日志、路径解析                    │
 * │ §2  协议构建          (L699-1487)  Requirement/Solution/Execution 协议     │
 * │ §3  协议补丁          (L1355-1487)  FixPlan/Mediation 补丁应用              │
 * │ §4  错误类型          (L1488-1568)  AppError 体系                           │
 * │ §5  认证会话          (L1570-2087)  Session/Credential/Role/AuthService     │
 * │ §6  脚手架模板        (L2090-3180)  确定性模板(Express/Python/Go)         │
 * │ §7  Express 中间件     (L3108-3925)  errorHandler/authMiddleware/logger      │
 * │ §8  测试分析          (L3928-4490)  analyzeTestProblem/stabilize/Jest 配置  │
 * │ §9  共识上下文        (L4494-5148)  buildSystemContext/buildCoderContext     │
 * │ §10 持久化与恢复       (L5149-5693)  MeetingNote/TraceIndex/Checkpoint        │
 * │ §11 容器执行           (L5695-5706)  execInContainer                         │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * 重构说明:本文件 5700+ 行,未来应拆分为独立模块(auth_utils、scaffold_templates 等)。
 * 当前通过 re-export 保持向后兼容。新增函数请放在对应功能域的末尾。
 */

import * as fs from "fs/promises";
import * as path from "path";
import { spawn } from "child_process";
import {
  JimClawState,
  ConsensusEntry,
  ConsensusType,
  ProblemAnalysis,
  MeetingNote,
  ExecutionFailureInfo,
  TraceIndex,
  TraceCheckpoint,
  TraceFileSummary,
  TraceTimelineEntry,
  TokenUsageSummary,
  ExecutionProtocol,
  FrontendApiUsage,
  FrontendContract,
  ExecutionPlan,
  ExecutionPlanFile,
  ExecutionPlanTask,
  ExecutionProtocolFileContract,
  ApiContract,
  ProtocolFileRole,
  ProtocolPatch,
  ProductSpec,
  RequirementProtocol,
  RuntimeStateSnapshot,
  RepairPlan,
  SolutionProtocol,
  SprintContract,
  SprintPlan,
  TaskContract,
  TechSpec,
  TechnologyDecision,
  ValidationFailureType,
  ValidationReport,
  VerificationKind,
  ProjectRuntime,
  BackendFramework,
  CustomerApprovalState,
} from "./graph_types";
// ShellExecuteSkill no longer imported — host-level commands use host.exec() from infra
import { AuditLogger } from "../utils/audit";
import { host } from "../infra";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractFailureEvidence(
  testOutput: string = "",
  deploymentStatus?: { status?: string } | null,
  blockedReason?: string
) {
  const normalized = String(testOutput || "");
  const verifierFailed = normalized.includes("[Verifier 预检失败]");
  const evaluatorFailed = normalized.includes("[Evaluator 验收失败]");
  const releaseGateFailed = normalized.includes("[ReleaseGate 阻塞]");
  const deploymentFailed = normalized.includes("[部署验证失败]") || deploymentStatus?.status === "failed";
  const coderBlocked = normalized.startsWith("[Coder 阻塞失败]") || (Boolean(blockedReason) && /Coder 阻塞/i.test(String(blockedReason || "")));
  const commandFailed = /command failed with exit code\s+[1-9]/i.test(normalized);
  const jestFail = /^FAIL\s+/m.test(normalized) || /Test suite failed to run/i.test(normalized);
  const tapFail = /^not ok\s+/m.test(normalized);
  const typeScriptCompileFailed = /\bTS\d{4}\b/.test(normalized);
  const infraBuildFailed = normalized.includes("[基础设施构建失败]") || normalized.includes("[基础设施异常]");
  const envGuardBlocked = /\[EnvGuard\]/.test(normalized);
  const spawnError = /spawn\s+EPERM/i.test(normalized);

  const hasBlockingFailure =
    verifierFailed ||
    evaluatorFailed ||
    releaseGateFailed ||
    deploymentFailed ||
    coderBlocked ||
    commandFailed ||
    jestFail ||
    tapFail ||
    typeScriptCompileFailed ||
    infraBuildFailed ||
    envGuardBlocked ||
    spawnError;

  return {
    verifierFailed,
    evaluatorFailed,
    releaseGateFailed,
    deploymentFailed,
    coderBlocked,
    commandFailed,
    jestFail,
    tapFail,
    typeScriptCompileFailed,
    infraBuildFailed,
    envGuardBlocked,
    spawnError,
    hasBlockingFailure,
  };
}

/**
 * 获取北京时间(东八区)字符串
 */
export function getBeijingTime(): string {
  const date = new Date();
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  const beijingDate = new Date(utc + (3600000 * 8));

  const y = beijingDate.getFullYear();
  const m = String(beijingDate.getMonth() + 1).padStart(2, '0');
  const d = String(beijingDate.getDate()).padStart(2, '0');
  const hh = String(beijingDate.getHours()).padStart(2, '0');
  const mm = String(beijingDate.getMinutes()).padStart(2, '0');
  const ss = String(beijingDate.getSeconds()).padStart(2, '0');

  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

/**
 * 格式化日志输出的前缀
 */
export function logPrefix(agentName: string = "System"): string {
  return `[${getBeijingTime()}] [${agentName}]`;
}

/**
 * 业务逻辑相关辅助函数
 */

/**
 * 动态获取项目入口点
 */
export function getEntryPoint(state: JimClawState): string {
  const allFiles = (state.subTasks || []).map(t => t.fileTarget);
  if (state.spec?.entryPoint) {
    try {
      const url = new URL(state.spec.entryPoint);
      const pathname = url.pathname === "/" ? "" : url.pathname;
      if (pathname) {
        const name = pathname.split("/").pop();
        if (name && allFiles.includes(name)) return name;
      }
    } catch {}
  }
  const serverFile = allFiles.find(f => /server|app|main|index/i.test(f) && !/test|spec/i.test(f) && !f.endsWith(".html") && !/utils|helper|lib/i.test(f));
  if (serverFile) return serverFile;

  const runtime = detectLanguageFamily(state.spec?.language || "javascript");
  if (runtime === "python") return "main.py";
  if (runtime === "go") return "main.go";
  if (runtime === "java") return "src/main/java/Main.java";
  if (runtime === "rust") return "src/main.rs";
  return "server.js";
}

/**
 * 获取主实现文件
 */
export function getImplementationFile(state: JimClawState): string {
  const allFiles = (state.subTasks || []).map(t => t.fileTarget);
  const implFile = allFiles.find(f =>
    !/test|spec/i.test(f) &&
    !f.endsWith("package.json") &&
    !f.endsWith(".html") &&
    !/utils|helper|lib|common/i.test(f)
  );
  return implFile || getEntryPoint(state);
}

function detectLanguageFamily(language: string): ProjectRuntime {
  const normalized = String(language || "").toLowerCase();
  if (/typescript|javascript|node/.test(normalized)) return "node";
  if (/python/.test(normalized)) return "python";
  if (/\bgo\b|golang/.test(normalized)) return "go";
  if (/\bjava\b|spring/.test(normalized)) return "java";
  if (/\brust\b|cargo|axum|actix|rocket/.test(normalized)) return "rust";
  return "unknown";
}

function detectProtocolRuntime(language: string): ProjectRuntime {
  return detectLanguageFamily(language);
}

function inferProtocolFileRole(fileTarget: string): ProtocolFileRole {
  const normalized = String(fileTarget || "").replace(/\\/g, "/").toLowerCase();
  if (
    /^package\.json$|^tsconfig\.json$|^pom\.xml$|^cargo\.toml$|^build\.gradle(?:\.kts)?$|^settings\.gradle(?:\.kts)?$|^gradle\.properties$|jest\.config\./.test(normalized)
  ) return "config";
  if (normalized.endsWith("/dockerfile") || normalized === "dockerfile" || normalized.endsWith("docker-compose.yml")) return "infra";
  if (normalized.includes("/tests/") || normalized.includes("/__tests__/") || normalized.includes("/test/java/") || /^tests?\//.test(normalized) || /\.test\.[^.]+$/.test(normalized) || /\.spec\.[^.]+$/.test(normalized) || /(?:test|tests)\.java$/i.test(normalized) || /_test\.rs$/i.test(normalized)) return "test";
  if (normalized.includes("/routes/") || normalized.includes("/routers/")) return "route";
  if (normalized.includes("/controllers/") || /controller\.java$/i.test(normalized)) return "controller";
  if (normalized.includes("/services/")) return "service";
  if (normalized.includes("/handlers/")) return "controller";  // Go/Rust handler = controller
  if (normalized.includes("/repositories/")) return "repository";
  if (normalized.includes("/models/")) return "model";
  if (normalized.includes("/middleware/")) return "middleware";
  if (
    normalized.endsWith("/index.ts") ||
    normalized.endsWith("/index.js") ||
    normalized === "src/index.ts" ||
    normalized === "src/index.js" ||
    normalized === "src/app.ts" ||
    normalized === "src/app.js" ||
    normalized === "src/server.ts" ||
    normalized === "src/server.js" ||
    normalized === "src/main.rs" ||
    /src\/main\/java\/.+\/(?:application|main)\.java$/.test(normalized) ||
    /src\/main\/kotlin\/.+\/(?:application|main)\.kt$/.test(normalized) ||
    // Python / Go / Java 入口文件
    normalized.endsWith("/app/main.py") ||
    normalized === "app/main.py" ||
    normalized.endsWith("/main.go") ||
    normalized === "main.go"
  ) return "entry";
  return "other";
}

function allowedRolesForProtocolFile(role: ProtocolFileRole): ProtocolFileRole[] {
  // 所有角色允许的通用基础依赖(types、enums、interfaces 等)
  const base: ProtocolFileRole[] = ["model", "config", "other"];
  switch (role) {
    case "entry":
      return ["entry", "route", "controller", "service", "repository", "middleware", ...base];
    case "route":
      return ["controller", "service", "repository", "middleware", ...base];
    case "controller":
      return ["service", "repository", "middleware", ...base];
    case "service":
      return ["service", "repository", ...base];
    case "repository":
      return [...base];
    case "middleware":
      return ["service", "repository", ...base];
    case "test":
      return ["entry", "route", "controller", "service", "repository", "middleware", ...base];
    case "infra":
      return ["entry", ...base];
    case "config":
    case "model":
    case "other":
    default:
      return [...base];
  }
}

function inferRequiredExports(fileTarget: string, contract: { endpoints?: Array<{ path: string; method: string }> } | null | undefined): string[] {
  const normalized = String(fileTarget || "").replace(/\\/g, "/").toLowerCase();
  if (normalized === "src/index.ts" || normalized === "src/index.js") return ["default"];
  if (normalized.includes("/routes/health.")) return ["default"];
  if (normalized.includes("/logger.")) return ["requestLogger"];
  if (normalized.includes("/errorhandler.")) return ["errorHandler"];
  if (normalized.includes("/routes/")) {
    const endpointCount = contract?.endpoints?.length || 0;
    return endpointCount > 0 ? ["default"] : [];
  }
  return [];
}

function inferOwnedEndpoints(fileTarget: string, contract: { endpoints?: Array<{ path: string; method: string }> } | null | undefined): string[] {
  const normalized = String(fileTarget || "").replace(/\\/g, "/").toLowerCase();
  if (!normalized.includes("/routes/")) return [];
  const rawStem = path.posix.basename(normalized, path.posix.extname(normalized)).toLowerCase();
  const stem = rawStem.replace(/routes?$/i, "").replace(/route$/i, "");
  const singularStem = singularizeStem(stem);
  const pluralStem = stem.endsWith("s") ? stem : `${stem}s`;
  const candidateStems = new Set([stem, singularStem, pluralStem].filter(Boolean));
  return (contract?.endpoints || [])
    .filter((endpoint) => {
      const endpointPath = String(endpoint.path || "").toLowerCase();
      if (stem === "index" || stem === "") return false;
      return endpointPath
        .split("/")
        .filter(Boolean)
        .some((segment) => candidateStems.has(segment.replace(/:[^/]+/g, "")));
    })
    .map((endpoint) => `${String(endpoint.method || "").toUpperCase()} ${String(endpoint.path || "")}`);
}

function deriveRouteMountPath(ownedEndpoints: string[], fallback: string): string {
  const paths = ownedEndpoints
    .map((endpoint) => endpoint.replace(/^[A-Z]+\s+/, "").trim())
    .map((endpointPath) => endpointPath.replace(/\/:[^/]+/g, ""))
    .map((endpointPath) => endpointPath.replace(/\/+$/, ""))
    .filter(Boolean);

  if (paths.length === 0) return fallback;

  const segmentsList = paths.map((item) => item.split("/").filter(Boolean));
  const commonSegments: string[] = [];
  const minLength = Math.min(...segmentsList.map((segments) => segments.length));
  for (let index = 0; index < minLength; index += 1) {
    const value = segmentsList[0][index];
    if (segmentsList.every((segments) => segments[index] === value)) {
      commonSegments.push(value);
    } else {
      break;
    }
  }

  return commonSegments.length > 0 ? `/${commonSegments.join("/")}` : fallback;
}

function toPascalCase(value: string): string {
  return String(value || "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
}

function singularizeStem(value: string): string {
  const normalized = String(value || "").trim();
  if (normalized.endsWith("ies")) return `${normalized.slice(0, -3)}y`;
  if (normalized.endsWith("ses")) return normalized.slice(0, -2);
  if (normalized.endsWith("s") && normalized.length > 1) return normalized.slice(0, -1);
  return normalized;
}

function getPrimaryCrudResource(state: Pick<JimClawState, "apiContract" | "requirementProtocol" | "contract">): {
  pluralStem: string;
  singularStem: string;
  resourcePath: string;
  label: string;
  title: string;
} {
  const configuredEntity =
    state.requirementProtocol?.capabilities?.crudEntities?.[0] ||
    state.requirementProtocol?.capabilities?.entities?.[0] ||
    "";
  const contractPath = (state.apiContract?.endpoints || [])
    .map((endpoint) => String(endpoint.path || "").trim())
    .find((endpointPath) => /^\/api\/[^/]+/i.test(endpointPath) && !/\/health(?:\/|$)/i.test(endpointPath));
  const pathStem = contractPath ? contractPath.split("/").filter(Boolean)[1] || "" : "";
  const pluralStem = (configuredEntity || pathStem || "items").replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "items";
  const singularStem = singularizeStem(pluralStem);
  const resourcePath = contractPath ? contractPath.replace(/\/:[^/]+.*$/g, "") : `/api/${pluralStem}`;
  const title = String(state.contract?.title || "").trim() || "业务管理系统";
  const label = singularStem === "book"
    ? "图书"
    : singularStem === "user"
      ? "用户"
      : singularStem === "product"
        ? "商品"
        : singularStem === "log"
          ? "日志"
          : singularStem === "permission"
            ? "权限"
            : "数据项";
  return { pluralStem, singularStem, resourcePath, label, title };
}

function getResourceEndpointCapabilities(
  apiContract: { endpoints?: Array<{ path: string; method: string }> } | null | undefined,
  resourcePath: string
) {
  const basePath = normalizeApiResourcePath(resourcePath);
  const methods = new Set<string>();
  for (const endpoint of apiContract?.endpoints || []) {
    const endpointPath = String(endpoint.path || "");
    if (normalizeApiResourcePath(endpointPath) !== basePath) continue;
    methods.add(String(endpoint.method || "").toUpperCase());
  }
  return {
    supportsList: methods.has("GET"),
    supportsCreate: methods.has("POST"),
    supportsUpdate: methods.has("PUT") || methods.has("PATCH"),
    supportsDelete: methods.has("DELETE"),
  };
}

function parseStateCodeMap(state: Pick<JimClawState, "code">): Record<string, string> {
  try {
    const parsed = JSON.parse(state.code || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([key, value]) => typeof key === "string" && typeof value === "string")
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

function collectNamedExports(source: string): Set<string> {
  const exports = new Set<string>();
  const functionPattern = /export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  const valuePattern = /export\s+(?:const|let|var|class)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  const namedPattern = /export\s*\{([^}]+)\}/g;

  for (const match of source.matchAll(functionPattern)) {
    if (match[1]) exports.add(match[1]);
  }
  for (const match of source.matchAll(valuePattern)) {
    if (match[1]) exports.add(match[1]);
  }
  for (const match of source.matchAll(namedPattern)) {
    const block = String(match[1] || "");
    for (const rawPart of block.split(",")) {
      const part = rawPart.trim();
      if (!part) continue;
      const aliasMatch = part.match(/^(?:([A-Za-z_][A-Za-z0-9_]*)\s+as\s+)?([A-Za-z_][A-Za-z0-9_]*)$/);
      if (!aliasMatch) continue;
      const exportedName = aliasMatch[2];
      if (exportedName) exports.add(exportedName);
    }
  }
  return exports;
}

function pickExistingExport(existingExports: Set<string>, candidates: string[]): string {
  return candidates.find((candidate) => existingExports.has(candidate)) || candidates[0];
}

function toRelativeOwnedRoutePath(endpointPath: string, mountPath: string): string {
  const normalizedPath = String(endpointPath || "").trim().replace(/\/+$/, "") || "/";
  const normalizedMount = String(mountPath || "").trim().replace(/\/+$/, "");
  if (!normalizedMount) return normalizedPath || "/";
  if (!normalizedPath.startsWith(normalizedMount)) return normalizedPath || "/";
  const suffix = normalizedPath.slice(normalizedMount.length);
  return suffix ? (suffix.startsWith("/") ? suffix : `/${suffix}`) : "/";
}

function buildCrudRouteScaffold(options: {
  controllerImportPath: string;
  controllerSource: string;
  authImportPath: string | null;
  ownedEndpoints: string[];
  singularStem: string;
  pluralStem: string;
  resourcePath: string;
}): string {
  const existingExports = collectNamedExports(options.controllerSource);
  const singularPascal = toPascalCase(options.singularStem);
  const pluralPascal = toPascalCase(options.pluralStem);
  const routeSpecs = options.ownedEndpoints
    .map((endpoint) => {
      const [method, ...pathParts] = String(endpoint || "").split(/\s+/);
      const endpointPath = pathParts.join(" ").trim();
      const relativePath = toRelativeOwnedRoutePath(endpointPath, options.resourcePath);
      const signature = `${String(method || "").toUpperCase()} ${relativePath}`;
      let handlerCandidates: string[] | null = null;
      switch (signature) {
        case "GET /":
          handlerCandidates = [`list${pluralPascal}`, `get${pluralPascal}`];
          break;
        case "POST /":
          handlerCandidates = [`create${singularPascal}`, `add${singularPascal}`];
          break;
        case "GET /:id":
          handlerCandidates = [`get${singularPascal}`, `get${singularPascal}ById`];
          break;
        case "PUT /:id":
        case "PATCH /:id":
          handlerCandidates = [`update${singularPascal}`, `edit${singularPascal}`];
          break;
        case "PATCH /:id/status":
          handlerCandidates = [`update${singularPascal}Status`, `set${singularPascal}Status`];
          break;
        case "DELETE /:id":
          handlerCandidates = [`delete${singularPascal}`, `remove${singularPascal}`];
          break;
        case "POST /:id/borrow":
          handlerCandidates = [`borrow${singularPascal}`];
          break;
        case "POST /:id/return":
          handlerCandidates = [`return${singularPascal}`];
          break;
        case "POST /:id/reservations":
          handlerCandidates = [`reserve${singularPascal}`, `create${singularPascal}Reservation`];
          break;
        default:
          handlerCandidates = null;
          break;
      }
      if (!handlerCandidates) return null;
      return {
        method: String(method || "").toLowerCase(),
        path: relativePath,
        handler: pickExistingExport(existingExports, handlerCandidates),
        needsAuth: String(method || "").toUpperCase() !== "GET",
      };
    })
    .filter((item): item is { method: string; path: string; handler: string; needsAuth: boolean } => Boolean(item));

  const controllerImports = Array.from(new Set(routeSpecs.map((item) => item.handler)));
  const usesAuth = Boolean(options.authImportPath) && routeSpecs.some((item) => item.needsAuth);
  const routeLines = routeSpecs.map((item) => {
    const middlewarePrefix = usesAuth && item.needsAuth ? "authMiddleware, " : "";
    return `router.${item.method}("${item.path}", ${middlewarePrefix}${item.handler});`;
  });

  return `import { Router } from "express";
import { ${controllerImports.join(", ")} } from "${options.controllerImportPath}";
${usesAuth ? `import { authMiddleware } from "${options.authImportPath}";\n` : ""}
const router = Router();

${routeLines.join("\n")}

export const ${toCamelCase(options.pluralStem)}RouteBase = "${options.resourcePath}";
export default router;
`;
}

function buildCrudEntityPayloadCode(singularStem: string): string {
  switch (singularStem) {
    case "book":
      return `{
    title: \`图书-\${suffix}\`,
    author: "测试作者",
    category: "测试分类",
    isbn: \`isbn-\${suffix}\`,
    totalCopies: 3,
  }`;
    case "product":
      return `{
    name: \`商品-\${suffix}\`,
    sku: \`sku-\${suffix}\`,
    price: 99,
    stock: 10,
    status: "active",
  }`;
    case "user":
      return `{
    name: \`用户-\${suffix}\`,
    email: \`test\${suffix}@example.com\`,
    age: 25,
  }`;
    default:
      return `{
    name: \`记录-\${suffix}\`,
    status: "active",
  }`;
  }
}

function buildCrudApiTestScaffold(
  state: Pick<JimClawState, "apiContract" | "contract" | "requirementProtocol">,
  resourceStem: string,
  declaredFiles: Set<string>
): string {
  const normalizedPlural = resourceStem.endsWith("s") ? resourceStem : `${resourceStem}s`;
  const singularStem = singularizeStem(resourceStem);
  const singularPascal = toPascalCase(singularStem);
  const ownedEndpoints = inferOwnedEndpoints(`src/routes/${normalizedPlural}.ts`, state.apiContract);
  const resourcePath = deriveRouteMountPath(ownedEndpoints, `/api/${normalizedPlural}`);
  const methodSet = new Set(ownedEndpoints.map((endpoint) => endpoint.split(/\s+/, 1)[0].toUpperCase()));
  const supportsWrite = methodSet.has("POST");
  const payloadCode = supportsWrite ? buildCrudEntityPayloadCode(singularStem) : "";
  const payloadBlock = supportsWrite
    ? `
function buildPayload(suffix = "1") {
  return ${payloadCode};
}
`
    : "";
  const writeAssertionBlock = supportsWrite
    ? `
  it("未认证写入请求返回受控状态", async () => {
    const response = await request(app).post(RESOURCE_PATH).send(buildPayload("http"));
    expect([201, 400, 401, 403, 422]).toContain(response.status);
  });
`
    : "";

  return `import request from "supertest";
import app from "../src/index";

const RESOURCE_PATH = "${resourcePath}";
${payloadBlock}

describe("${singularPascal} API 基线", () => {
  it("GET 列表接口返回受控响应", async () => {
    const response = await request(app).get(RESOURCE_PATH);
    expect(response.status).toBeLessThan(500);
  });
${writeAssertionBlock}
});
`;
}

function buildVerifyScriptScaffold(
  state: Pick<JimClawState, "apiContract" | "contract" | "manifest" | "requirementProtocol">
): string {
  const port = state.manifest?.services?.[0]?.port || 8080;
  const primaryResource = getPrimaryCrudResource(state);
  const payloadCode = buildCrudEntityPayloadCode(primaryResource.singularStem);
  return `const baseUrl = process.env.VERIFY_BASE_URL || "http://127.0.0.1:${port}";

type VerifyResult = {
  name: string;
  ok: boolean;
  detail: string;
};

async function requestJson(path: string, init?: RequestInit): Promise<{ status: number; bodyText: string }> {
  const response = await fetch(baseUrl + path, init);
  return {
    status: response.status,
    bodyText: await response.text(),
  };
}

async function runStep(name: string, fn: () => Promise<void>): Promise<VerifyResult> {
  try {
    await fn();
    return { name, ok: true, detail: "PASS" };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildPayload(suffix = "verify") {
  return ${payloadCode};
}

async function main(): Promise<void> {
  const results: VerifyResult[] = [];

  results.push(
    await runStep("health", async () => {
      const response = await requestJson("/api/health");
      if (response.status !== 200) {
        throw new Error(\`健康检查失败: \${response.status}\`);
      }
    })
  );

  results.push(
    await runStep("${primaryResource.pluralStem}-list", async () => {
      const response = await requestJson("${primaryResource.resourcePath}");
      if (response.status >= 500) {
        throw new Error(\`列表接口返回 5xx: \${response.status}\`);
      }
    })
  );

  results.push(
    await runStep("${primaryResource.pluralStem}-write-guard", async () => {
      const response = await requestJson("${primaryResource.resourcePath}", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      if (![201, 401, 403].includes(response.status)) {
        throw new Error(\`写接口返回了未预期状态: \${response.status}\`);
      }
    })
  );

  results.forEach((result) => {
    const status = result.ok ? "PASS" : "FAIL";
    console.log(\`[\${status}] \${result.name} - \${result.detail}\`);
  });

  const hasFailure = results.some((result) => !result.ok);
  process.exit(hasFailure ? 1 : 0);
}

main().catch((error) => {
  console.error("[FATAL]", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
`;
}

function hasFrontendFiles(files: string[]): boolean {
  return files.some((file) => {
    const normalized = String(file || "").replace(/\\/g, "/").toLowerCase();
    return normalized.startsWith("public/") || normalized.endsWith(".html") || normalized.endsWith(".css") || normalized.endsWith(".js");
  });
}

function hasBackendFiles(files: string[]): boolean {
  return files.some((file) => {
    const role = inferProtocolFileRole(String(file || "").replace(/\\/g, "/"));
    return ["entry", "route", "controller", "service", "model", "middleware"].includes(role);
  });
}

function inferEntities(lines: string[]): string[] {
  const entities = new Set<string>();
  const entityPatterns: Array<[RegExp, string]> = [
    [/待办|todo/gi, "todo"],
    [/任务|task/gi, "task"],
    [/商品|产品|电器|product|appliance/gi, "product"],
    [/图书|book/gi, "book"],
    [/用户|user/gi, "user"],
    [/日志|log/gi, "log"],
    [/权限|permission/gi, "permission"],
    [/文章|post|article|blog/gi, "article"],
    [/订单|order/gi, "order"],
    [/评论|comment/gi, "comment"],
  ];
  for (const line of lines) {
    for (const [pattern, entity] of entityPatterns) {
      if (pattern.test(line)) entities.add(entity);
    }
  }
  return Array.from(entities);
}

function inferUiCapabilities(lines: string[]): string[] {
  const capabilities = new Set<string>();
  const joined = lines.join("\n");
  if (/列表|list|查看/.test(joined)) capabilities.add("list");
  if (/添加|新增|create|add/.test(joined)) capabilities.add("create");
  if (/编辑|修改|update|edit/.test(joined)) capabilities.add("edit");
  if (/删除|remove|delete/.test(joined)) capabilities.add("delete");
  if (/登录|login/.test(joined)) capabilities.add("login");
  return Array.from(capabilities);
}

function joinedRequirementText(requirementProtocol: RequirementProtocol | null | undefined): string {
  return [
    requirementProtocol?.userIntent?.title || "",
    ...(requirementProtocol?.userIntent?.requirements || []),
    ...(requirementProtocol?.userIntent?.acceptanceCriteria || []),
  ].join("\n");
}

function requiresStructuredLogging(requirementProtocol: RequirementProtocol | null | undefined): boolean {
  return /结构化日志|structured log|json log/i.test(joinedRequirementText(requirementProtocol));
}

function requiresVerifyScript(requirementProtocol: RequirementProtocol | null | undefined): boolean {
  return /验证脚本|校验脚本|verify script|verify\.ps1|verify\.sh/i.test(joinedRequirementText(requirementProtocol));
}

function getPrimaryEntityStems(requirementProtocol: RequirementProtocol | null | undefined): {
  singular: string;
  plural: string;
} {
  const ignoredSupportEntities = new Set(["auth", "permission", "role", "session", "audit", "log"]);
  const titleEntities = inferEntities([requirementProtocol?.userIntent?.title || ""])
    .filter((entity) => !ignoredSupportEntities.has(String(entity || "").toLowerCase()));
  const primary =
    titleEntities[0] ||
    requirementProtocol?.capabilities?.crudEntities?.find((entity) => !ignoredSupportEntities.has(String(entity || "").toLowerCase())) ||
    requirementProtocol?.capabilities?.entities?.find((entity) => !ignoredSupportEntities.has(String(entity || "").toLowerCase())) ||
    requirementProtocol?.capabilities?.crudEntities?.[0] ||
    requirementProtocol?.capabilities?.entities?.[0] ||
    "item";
  const singular = singularizeStem(primary) || "item";
  const plural = singular.endsWith("s") ? singular : `${singular}s`;
  return { singular, plural };
}

function toCamelCase(value: string): string {
  const pascal = toPascalCase(value);
  return pascal ? pascal.charAt(0).toLowerCase() + pascal.slice(1) : "";
}

export function inferVerificationKind(text: string): VerificationKind {
  const normalized = String(text || "").toLowerCase();
  if (/页面|前端|界面|浏览器|点击|显示|表单|button|page|ui/i.test(text)) return "ui";
  if (/api|http|get\s+\/|post\s+\/|put\s+\/|delete\s+\/|patch\s+\/|接口|端点|返回\s*\d{3}/i.test(text)) return "api";
  if (/部署|启动|访问地址|health|健康检查|docker|容器/i.test(normalized)) return "deploy";
  if (/测试|单元|npm test|pytest|go test|cargo test|验证脚本/i.test(text)) return "unit";
  if (/构建|build|compile|tsc/i.test(text)) return "build";
  return "manual";
}

export function buildProductSpec(userGoal: string, contract: TaskContract | null | undefined): ProductSpec {
  const requirements = contract?.requirements || [];
  const acceptanceCriteria = contract?.acceptanceCriteria || [];
  return {
    version: "v1",
    title: contract?.title || userGoal || "未命名任务",
    userGoal: userGoal || contract?.title || "",
    userStories: requirements.map((requirement, index) => ({
      id: `US-${index + 1}`,
      story: requirement,
      priority: "must" as const,
    })),
    acceptanceCriteria: acceptanceCriteria.map((criterion, index) => ({
      id: `AC-${index + 1}`,
      description: criterion,
      verificationKind: inferVerificationKind(criterion),
    })),
    nonGoals: [],
  };
}

export function buildSprintPlans(args: {
  productSpec: ProductSpec | null | undefined;
  apiContract: ApiContract | null | undefined;
  spec: Partial<TechSpec> | null | undefined;
}): SprintPlan[] {
  const product = args.productSpec;
  if (!product) return [];

  const criteria = product.acceptanceCriteria || [];
  const hasUi = criteria.some((item) => item.verificationKind === "ui");
  const hasApi = criteria.some((item) => item.verificationKind === "api");
  const allAcceptanceIds = criteria.map((item) => item.id);
  const foundationAcceptanceIds = criteria
    .filter((item) => ["build", "deploy", "unit"].includes(item.verificationKind))
    .map((item) => item.id);

  const plans: SprintPlan[] = [{
    id: "SP-1",
    title: "可运行骨架与健康检查",
    goal: "应用可以安装、启动，并通过基础健康检查",
    userStoryIds: product.userStories.slice(0, 1).map((item) => item.id),
    acceptanceCriteriaIds: foundationAcceptanceIds,
    deliverables: ["可运行应用", "基础测试", "健康检查"],
    allowedScope: ["package.json", "tsconfig.json", "src/", "tests/", "Dockerfile", "docker-compose.yml"],
    dependencies: [],
    estimatedComplexity: "small",
    doneWhen: ["测试命令通过", "健康检查可访问"],
  }];

  if (hasApi || hasUi) {
    plans.push({
      id: "SP-2",
      title: "核心用户路径闭环",
      goal: "完成用户最重要的 API/UI 纵向路径",
      userStoryIds: product.userStories.map((item) => item.id),
      acceptanceCriteriaIds: allAcceptanceIds,
      deliverables: [
        hasApi ? "核心 API 行为" : "",
        hasUi ? "核心页面交互" : "",
      ].filter(Boolean),
      allowedScope: ["src/", "tests/", "frontend/", "public/"],
      dependencies: ["SP-1"],
      estimatedComplexity: "medium",
      doneWhen: criteria.map((item) => item.description),
    });
  }

  const hasWriteEndpoint = (args.apiContract?.endpoints || []).some((endpoint) =>
    ["POST", "PUT", "PATCH", "DELETE"].includes(String(endpoint.method || "").toUpperCase())
  );
  if (hasWriteEndpoint && criteria.length > 2) {
    plans.push({
      id: "SP-3",
      title: "写操作与回归验收",
      goal: "完成核心写操作并回归用户验收",
      userStoryIds: product.userStories.map((item) => item.id),
      acceptanceCriteriaIds: allAcceptanceIds,
      deliverables: ["写操作 API", "错误处理", "回归测试"],
      allowedScope: ["src/", "tests/", "frontend/", "public/"],
      dependencies: ["SP-2"],
      estimatedComplexity: "medium",
      doneWhen: criteria.map((item) => item.description),
    });
  }

  return plans.filter((plan) => plan.id === "SP-1" || plan.acceptanceCriteriaIds.length > 0);
}

export function buildRequirementProtocol(contract: TaskContract | null | undefined): RequirementProtocol {
  const requirements = contract?.requirements || [];
  const acceptanceCriteria = contract?.acceptanceCriteria || [];
  const allLines = [...requirements, ...acceptanceCriteria, contract?.title || ""];
  const joined = allLines.join("\n");
  const entities = inferEntities(allLines);
  const uiCapabilities = inferUiCapabilities(allLines);
// ═══════════════════════════════════════════════════════════════════════
// §2  协议构建 (Requirement / Solution / Execution)
// ═══════════════════════════════════════════════════════════════════════

  // 奥卡姆剃刀:否定语境检测--如果关键词出现在"不包含/不需要/排除"等语境中,视为不需要
  const negatePattern = /不包含|不需要|排除|不涉及|不要求|不含|无需|没有|不提供/i;
  function hasPositiveMatch(pattern: RegExp): boolean {
    for (const line of allLines) {
      if (!pattern.test(line)) continue;
      // 检查同一行或相邻上下文是否有否定词
      const negate = negatePattern.test(line);
      if (!negate) return true;
    }
    return false;
  }

  const frontendRequired = hasPositiveMatch(/前端|页面|界面|ui|web|浏览器|vue|react|svelte/i);
  const backendRequired = hasPositiveMatch(/后端|api|接口|服务|express|fastapi|node/i) || !frontendRequired;
  const authRequired = hasPositiveMatch(/权限|授权|认证|登录|jwt/i);
  // "认证系统"任务中 authRequired 应为 true--但需要排除否定语境中的"权限""授权"等
  // 如果 title 直接提到认证/登录,即使 acceptanceCriteria 中有否定语境,仍视为需要
  const titleAuth = /认证|登录|jwt|auth/i.test(contract?.title || "");
  const authRequiredFinal = authRequired || titleAuth;
  const auditLogRequired = hasPositiveMatch(/日志|审计|追踪/i);
  const dockerRequired = hasPositiveMatch(/docker|容器|compose/i);

  return {
    version: "v1",
    userIntent: {
      title: contract?.title || "",
      requirements,
      acceptanceCriteria,
    },
    capabilities: {
      frontendRequired,
      backendRequired,
      authRequired: authRequiredFinal,
      auditLogRequired,
      dockerRequired,
      entities,
      crudEntities: entities.filter((entity) => {
        // 实体被认为是 CRUD 实体的条件：
        // 1. 需求中提到任何 CRUD 操作（列表/创建/修改/删除 或 GET/POST/PUT/DELETE）
        // 2. 或者该实体在已知业务实体列表中
        const hasCrudKeywords = /(list|create|edit|delete|列表|创建|新增|修改|更新|删除|GET|POST|PUT|DELETE)/i.test(uiCapabilities.join(","));
        const knownCrudEntities = /book|log|permission|task|todo|user|product|article|order|comment|item/i;
        return hasCrudKeywords || knownCrudEntities.test(entity);
      }),
      uiCapabilities,
    },
  };
}

export function buildTechnologyDecision(
  requirementProtocol: RequirementProtocol | null | undefined,
  spec: { framework?: string; language?: string; filesToCreate?: string[]; entryPoint?: string; testCommand?: string } | null | undefined
): TechnologyDecision {
  const files = (spec?.filesToCreate || []).map((file) => String(file).replace(/\\/g, "/"));
  const framework = String(spec?.framework || "").toLowerCase();
  const language = String(spec?.language || "").toLowerCase();
  const frontendFramework =
    files.some((file) => /react|tsx$/i.test(file)) ? "react" :
    files.some((file) => /vue$/i.test(file)) ? "vue" :
    requirementProtocol?.capabilities.frontendRequired ? "vanilla" :
    "none";
  const runtime = detectLanguageFamily(language);
  const backendFramework: BackendFramework =
    /express/.test(framework) || /typescript|javascript/.test(language) ? "express-typescript" :
    /fastapi|python/.test(framework) || /python/.test(language) ? "fastapi-python" :
    /gin|go/.test(framework) || /\bgo\b/.test(language) ? "gin-go" :
    /spring/.test(framework) || runtime === "java" ? "spring-java" :
    /axum|actix|rocket/.test(framework) || runtime === "rust" ? "rust-web" :
    "unknown";

  return {
    version: "v1",
    source: "architect",
    frontend: {
      required: Boolean(requirementProtocol?.capabilities.frontendRequired),
      framework: frontendFramework,
      buildTool: frontendFramework === "react" || frontendFramework === "vue" ? "vite" : "none",
      entryFiles: files.filter((file) => /^(public\/index\.html|src\/main\.(t|j)sx?|src\/app\.(t|j)sx?)$/i.test(file)),
    },
    backend: {
      required: Boolean(requirementProtocol?.capabilities.backendRequired),
      framework: backendFramework,
      entryFiles: [String(spec?.entryPoint || "").replace(/\\/g, "/")].filter(Boolean),
    },
    database: {
      kind: /postgres|mongoose|prisma|sequelize/i.test(files.join("\n")) ? "postgres" :
        /sqlite/i.test(files.join("\n")) ? "sqlite" :
        requirementProtocol?.capabilities.backendRequired ? "memory" : "none",
    },
    testing: {
      unit: spec?.testCommand || "",
      api: requirementProtocol?.capabilities.backendRequired ? (spec?.testCommand || "") : undefined,
      e2e: requirementProtocol?.capabilities.frontendRequired ? "playwright" : undefined,
    },
    deploy: {
      docker: Boolean(requirementProtocol?.capabilities.dockerRequired),
      compose: files.some((file) => /docker-compose\.ya?ml$/i.test(file)),
    },
  };
}

export function ensureRequirementDrivenFiles(
  spec: { filesToCreate?: string[]; language?: string } | null | undefined,
  requirementProtocol: RequirementProtocol | null | undefined
) {
  const nextSpec = { ...(spec || {}) } as Record<string, any>;
  const files = Array.isArray(nextSpec.filesToCreate) ? [...nextSpec.filesToCreate] : [];
  const fileSet = new Set(files.map((file) => String(file).replace(/\\/g, "/")));

  // ── 非 Node/JS/TS 项目跳过所有文件注入 ──
  const language = String(nextSpec.language || "").toLowerCase();
  const isNode = /typescript|javascript|node/.test(language);
  if (!isNode) {
    // Python/Java/Go/Rust 项目：注入语言特定的基础文件
    const { singular: s_np, plural: p_np } = getPrimaryEntityStems(requirementProtocol);
    const ensureFile_np = (target: string) => {
      if (!fileSet.has(target)) {
        files.push(target);
        fileSet.add(target);
      }
    };
    if (/python/.test(language)) {
      ensureFile_np("requirements.txt");
      ensureFile_np("app/__init__.py");
      ensureFile_np("app/main.py");
      if ((!spec?.filesToCreate || spec.filesToCreate.length <= 3) && s_np && p_np) {
        ensureFile_np(`app/routers/${p_np}.py`);
        ensureFile_np(`tests/test_${p_np}.py`);
      }
    } else if (/java/.test(language)) {
      ensureFile_np("pom.xml");
      ensureFile_np("src/main/resources/application.properties");
      ensureFile_np("src/main/java/com/example/app/Application.java");
      ensureFile_np("src/main/java/com/example/app/HealthController.java");
      ensureFile_np("src/test/java/com/example/app/HealthControllerTest.java");
    } else if (/go/.test(language)) {
      ensureFile_np("go.mod");
      ensureFile_np("main.go");
      ensureFile_np("handler/health.go");
      ensureFile_np("handler/health_test.go");
      if ((!spec?.filesToCreate || spec.filesToCreate.length <= 3) && s_np && p_np) {
        ensureFile_np(`handler/${p_np}.go`);
        ensureFile_np(`handler/${p_np}_test.go`);
      }
    } else if (/rust/.test(language)) {
      ensureFile_np("Cargo.toml");
      ensureFile_np("src/main.rs");
      ensureFile_np("src/handlers/mod.rs");
      ensureFile_np("src/handlers/health.rs");
      ensureFile_np("tests/health_test.rs");
    }
    return { ...nextSpec, filesToCreate: files };
  }

  const frontendRequired = Boolean(requirementProtocol?.capabilities?.frontendRequired);
  const backendRequired = Boolean(requirementProtocol?.capabilities?.backendRequired);
  const authRequired = Boolean(requirementProtocol?.capabilities?.authRequired);
  const auditLogRequired = Boolean(requirementProtocol?.capabilities?.auditLogRequired || requiresStructuredLogging(requirementProtocol));
  const dockerRequired = Boolean(requirementProtocol?.capabilities?.dockerRequired);
  const verifyScriptRequired = requiresVerifyScript(requirementProtocol);
  const { singular, plural } = getPrimaryEntityStems(requirementProtocol);
  const pascalSingular = toPascalCase(singular);
  const camelSingular = toCamelCase(singular) || "item";

  const ensureFile = (target: string) => {
    if (!fileSet.has(target)) {
      files.push(target);
      fileSet.add(target);
    }
  };

  const hasModernFrontend = Boolean((nextSpec as any).frontend) || files.some((file) => /^frontend\//i.test(String(file).replace(/\\/g, "/")));
  if (frontendRequired && !hasModernFrontend) {
    ensureFile("public/index.html");
  }

  if (backendRequired) {
    // 只在 Node/TS/JS 项目中注入 Node 配置文件
    // Python/Go/Java 狱目项目使用自己的配置文件(requirements.txt/go.mod/pom.xml)
    const lang = String((nextSpec as any).language || "").toLowerCase();
    if (/typescript|javascript|node/.test(lang)) {
      ensureFile("package.json");
      ensureFile("tsconfig.json");
      ensureFile("src/index.ts");
      // CRUD 测试文件:无论 Architect 是否已规划,都确保存在
      // (Architect 经常遗漏测试文件)
      if (singular && plural) {
        ensureFile(`tests/${plural}.test.ts`);
      }
      // 只在 spec 没有明确文件列表时注入完整 CRUD 分层结构
      if ((!spec?.filesToCreate || spec.filesToCreate.length <= 3) && singular && plural) {
        ensureFile(`src/routes/${plural}.ts`);
        ensureFile(`src/controllers/${camelSingular}Controller.ts`);
        ensureFile(`src/services/${camelSingular}Service.ts`);
        ensureFile(`src/models/${singular}.ts`);
      }
    } else if (/python/.test(lang)) {
      ensureFile("requirements.txt");
      ensureFile("app/__init__.py");
      ensureFile("app/main.py");
      if ((!spec?.filesToCreate || spec.filesToCreate.length <= 3) && singular && plural) {
        ensureFile(`app/routers/${plural}.py`);
        ensureFile(`tests/test_${plural}.py`);
      }
    } else if (/java/.test(lang)) {
      // Java/Spring Boot: pom.xml + Application + Controller
      ensureFile("pom.xml");
      ensureFile("src/main/resources/application.properties");
      ensureFile("src/main/java/com/example/app/Application.java");
      ensureFile("src/main/java/com/example/app/HealthController.java");
      ensureFile("src/test/java/com/example/app/HealthControllerTest.java");
    } else if (/rust/.test(lang)) {
      // Rust/Axum: Cargo.toml + main.rs + handlers
      ensureFile("Cargo.toml");
      ensureFile("src/main.rs");
      ensureFile("src/handlers/mod.rs");
      ensureFile("src/handlers/health.rs");
      ensureFile("tests/health_test.rs");
    }
  }

  if (authRequired) {
    // 只在 spec 没有明确文件列表时注入 auth 分层
    // 如果 spec 已经有文件列表(说明 Architect 已规划),不强制注入
    if (!spec?.filesToCreate || spec.filesToCreate.length <= 3) {
      ensureFile("src/middleware/auth.ts");
      ensureFile("src/routes/auth.ts");
      ensureFile("src/controllers/authController.ts");
      ensureFile("src/services/authService.ts");
      ensureFile("tests/auth.test.ts");
    } else {
      // Architect 已规划:仍需保留最小认证入口和测试，避免 authRequired 只剩中间件不可验收。
      ensureFile("src/middleware/auth.ts");
      ensureFile("src/routes/auth.ts");
      ensureFile("tests/auth.test.ts");
    }
  }

  if (auditLogRequired) {
    ensureFile("src/logging/logger.ts");
    ensureFile("src/errors.ts");
  }

  if (dockerRequired) {
    ensureFile("Dockerfile");
    ensureFile("docker-compose.yml");
  }

  if (fileSet.has("Dockerfile") || fileSet.has("docker-compose.yml") || fileSet.has(".dockerignore")) {
    ensureFile(".dockerignore");
  }

  // verify.ps1 不再注入--测试由 jest/pytest 覆盖,验证脚本是冗余文件

  if (backendRequired && pascalSingular && (!spec?.filesToCreate || spec.filesToCreate.length <= 3)) {
    const existingModelMatches = files.some((file) => new RegExp(`src/models/${pascalSingular}`, "i").test(file));
    if (!existingModelMatches) {
      ensureFile(`src/models/${singular}.ts`);
    }
  }

  nextSpec.filesToCreate = files;
  return nextSpec;
}

export function ensureRequirementDrivenApiContract(
  apiContract: { endpoints?: Array<{ path: string; method: string; description?: string; requestBody?: any; responseBody?: any; parameters?: any }> } | null | undefined,
  requirementProtocol: RequirementProtocol | null | undefined
): { endpoints: Array<{ path: string; method: string; description: string; requestBody?: any; responseBody?: any; parameters?: any }> } {
  const contract: { endpoints: Array<{ path: string; method: string; description: string; requestBody?: any; responseBody?: any; parameters?: any }> } = {
    endpoints: Array.isArray(apiContract?.endpoints)
      ? apiContract.endpoints.map((endpoint) => ({
          ...endpoint,
          method: String(endpoint.method || "").toUpperCase(),
          description: String(endpoint.description || "未命名接口"),
        }))
      : [],
  };
  const endpointMap = new Map<string, { path: string; method: string; description: string; requestBody?: any; responseBody?: any; parameters?: any }>();
  for (const endpoint of contract.endpoints) {
    const key = `${String(endpoint.method || "").toUpperCase()} ${String(endpoint.path || "")}`;
    endpointMap.set(key, {
      ...endpoint,
      method: String(endpoint.method || "").toUpperCase(),
      description: String(endpoint.description || "未命名接口"),
    });
  }

  const ensureEndpoint = (method: string, targetPath: string, description: string) => {
    const normalizedMethod = method.toUpperCase();
    const key = `${normalizedMethod} ${targetPath}`;
    if (!endpointMap.has(key)) {
      endpointMap.set(key, { method: normalizedMethod, path: targetPath, description });
    }
  };

  const { singular, plural } = getPrimaryEntityStems(requirementProtocol);
  const resourceLabel = singular === "product" ? "商品" : singular === "book" ? "图书" : singular === "user" ? "用户" : "数据";
  const basePath = `/api/${plural}`;

  if (requirementProtocol?.capabilities?.backendRequired) {
    ensureEndpoint("GET", "/api/health", "健康检查");
  }

  // 读写意图必须拆开判断：列表/查询只能补 GET，不能升级成完整 CRUD。
  // 奥卡姆剃刀:如果已有足够的端点覆盖需求,不额外注入。
  const intentLines = [...(requirementProtocol?.userIntent?.requirements || []), ...(requirementProtocol?.userIntent?.acceptanceCriteria || [])].map(String);
  const reqText = intentLines.join(" ").toLowerCase();
  const explicitlyWantsRead = /列表|查询|检索|浏览|展示|查看|获取|list|query|getall|findall|read/i.test(reqText);
  const resourceTerms = [singular, plural, resourceLabel, basePath].filter(Boolean).map((term) => escapeRegExp(String(term)));
  const resourceTermPattern = resourceTerms.length > 0 ? `(?:${resourceTerms.join("|")})` : "";
  const mutationOperationPattern = "(?:新增|添加|编辑|修改|更新|删除|借阅|归还|预约|add|edit|update|delete|remove|borrow|reserve)";
  const createOperationPattern = "(?:创建|create)";
  const writeNearResource = resourceTermPattern
    ? new RegExp(
        `(?:${resourceTermPattern}.{0,30}${mutationOperationPattern}|${mutationOperationPattern}.{0,30}${resourceTermPattern})`,
        "i"
      )
    : null;
  const createNearResource = resourceTermPattern
    ? new RegExp(
        `(?:${resourceTermPattern}.{0,12}${createOperationPattern}|${createOperationPattern}.{0,12}${resourceTermPattern})`,
        "i"
      )
    : null;
  const projectCreationClause = /(?:创建|create).{0,40}(?:应用|系统|项目|服务|网站|页面|工具|平台|程序|目录应用|mvp|app|application|system|service|project|website|page|tool|platform)/i;
  const explicitlyWantsWrite = intentLines.some((line) => {
    const text = String(line || "");
    if (/\b(POST|PUT|PATCH|DELETE)\b/i.test(text)) return true;
    return text.split(/[，。；;,.]/).some((clause) => {
      if (writeNearResource?.test(clause)) return true;
      return Boolean(createNearResource?.test(clause)) && !projectCreationClause.test(clause);
    });
  });
  if ((requirementProtocol?.capabilities?.crudEntities || []).length > 0 && !explicitlyWantsWrite) {
    for (const [key, endpoint] of Array.from(endpointMap.entries())) {
      const method = String(endpoint.method || "").toUpperCase();
      if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) continue;
      if (normalizeApiResourcePath(endpoint.path) === basePath) {
        endpointMap.delete(key);
      }
    }
  }
  if ((requirementProtocol?.capabilities?.crudEntities || []).length > 0 && (explicitlyWantsRead || explicitlyWantsWrite)) {
    ensureEndpoint("GET", basePath, `${resourceLabel}列表`);
  }
  if ((requirementProtocol?.capabilities?.crudEntities || []).length > 0 && explicitlyWantsWrite) {
    ensureEndpoint("POST", basePath, `创建${resourceLabel}`);
    ensureEndpoint("PUT", `${basePath}/:id`, `更新${resourceLabel}`);
    ensureEndpoint("DELETE", `${basePath}/:id`, `删除${resourceLabel}`);
  }

  // auth 端点:仅在 requirements 明确提到但 LLM 未生成时补充
  if (requirementProtocol?.capabilities?.authRequired) {
    // 不重复注入--如果 LLM 已生成 /api/register + /api/login + /api/me,跳过
    const hasLoginEndpoint = endpointMap.has("POST /api/login") || endpointMap.has("POST /api/auth/login");
    const hasMeEndpoint = endpointMap.has("GET /api/me") || endpointMap.has("GET /api/auth/me");
    if (!hasLoginEndpoint) ensureEndpoint("POST", "/api/auth/login", "登录认证");
    if (!hasMeEndpoint) ensureEndpoint("GET", "/api/auth/me", "当前用户信息");
  }

  contract.endpoints = Array.from(endpointMap.values());
  return contract;
}

export function buildSolutionProtocol(
  requirementProtocol: RequirementProtocol | null | undefined,
  spec: { filesToCreate?: string[] } | null | undefined,
  apiContract: { endpoints?: Array<{ path: string; method: string }> } | null | undefined
): SolutionProtocol {
  const files = (spec?.filesToCreate || []).map((file) => String(file).replace(/\\/g, "/"));
  const frontendPlanned = hasFrontendFiles(files);
  const backendPlanned = hasBackendFiles(files) || (apiContract?.endpoints?.length || 0) > 0;
  const authPlanned = files.some((file) => /auth/i.test(file)) || (apiContract?.endpoints || []).some((endpoint) => /auth|login/i.test(String(endpoint.path || "")));
  const auditLogPlanned = files.some((file) => /logger|audit/i.test(file));
  const coverageMatrix = (requirementProtocol?.userIntent?.requirements || []).map((requirement) => {
    const coveredBy: string[] = [];
    if (/前端|页面|界面|ui|web/i.test(requirement) && frontendPlanned) coveredBy.push("frontend");
    if (/后端|api|接口|服务/i.test(requirement) && backendPlanned) coveredBy.push("backend");
    if (/权限|授权|认证|登录|jwt/i.test(requirement) && authPlanned) coveredBy.push("auth");
    if (/日志|审计|追踪/i.test(requirement) && auditLogPlanned) coveredBy.push("audit");
    return { requirement, coveredBy };
  });
  const uncoveredRequirements = (requirementProtocol?.userIntent?.requirements || []).filter((requirement) => {
    // 跳过否定语境("不包含""不需要"等)
    if (/不包含|不需要|排除|不涉及|不要求|不含|无需|不提供/i.test(requirement)) return false;
    if (/前端|页面|界面|ui|web/i.test(requirement)) return !frontendPlanned;
    if (/后端|api|接口|服务/i.test(requirement)) return !backendPlanned;
    if (/权限|授权|认证|登录|jwt/i.test(requirement)) return !authPlanned;
    if (/日志|审计|追踪/i.test(requirement)) return !auditLogPlanned;
    return false;
  });
  const uncoveredAcceptanceCriteria = (requirementProtocol?.userIntent?.acceptanceCriteria || []).filter((criteria) => {
    // 跳过否定语境
    if (/不包含|不需要|排除|不涉及|不要求|不含|无需|不提供/i.test(criteria)) return false;
    if (/前端|页面|界面|ui|web/i.test(criteria)) return !frontendPlanned;
    if (/后端|api|接口|服务/i.test(criteria)) return !backendPlanned;
    if (/权限|授权|认证|登录|jwt/i.test(criteria)) return !authPlanned;
    if (/日志|审计|追踪/i.test(criteria)) return !auditLogPlanned;
    return false;
  });

  return {
    version: "v1",
    coverage: {
      frontendPlanned,
      backendPlanned,
      authPlanned,
      auditLogPlanned,
      uncoveredRequirements,
      uncoveredAcceptanceCriteria,
      coverageMatrix,
    },
  };
}

function detectFrontendRoots(files: string[] = []): string[] {
  const normalizedFiles = files.map((file) => String(file || "").replace(/\\/g, "/"));
  if (normalizedFiles.some((file) => /^frontend\//i.test(file))) {
    return ["frontend"];
  }
  if (normalizedFiles.some((file) => /^public\//i.test(file))) {
    return ["public"];
  }
  return [];
}

function normalizeApiResourcePath(rawPath: string): string {
  const normalized = String(rawPath || "").trim().replace(/\/+$/g, "") || "/";
  return normalized
    .replace(/\/:[^/]+(?:\/.*)?$/g, "")
    .replace(/\/\{[^/]+\}(?:\/.*)?$/g, "")
    .replace(/\/[0-9a-f-]{8,}(?:\/.*)?$/gi, "");
}

function deriveFrontendApiUsage(
  apiContract: { endpoints?: Array<{ path: string; method: string }> } | null | undefined
): FrontendApiUsage[] {
  const resourceMethods = new Map<string, Set<string>>();
  for (const endpoint of apiContract?.endpoints || []) {
    const method = String(endpoint.method || "").toUpperCase();
    const endpointPath = String(endpoint.path || "");
    if (!method || !endpointPath || /^\/?(api\/)?health\/?$/i.test(endpointPath.replace(/^\/+/, ""))) {
      continue;
    }
    const resourcePath = normalizeApiResourcePath(endpointPath);
    if (!resourceMethods.has(resourcePath)) {
      resourceMethods.set(resourcePath, new Set<string>());
    }
    resourceMethods.get(resourcePath)?.add(method);
  }

  const methodOrder = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  return Array.from(resourceMethods.entries()).map(([resourcePath, methodSet]) => {
    const methods = Array.from(methodSet).sort((a, b) => {
      const ai = methodOrder.indexOf(a);
      const bi = methodOrder.indexOf(b);
      return (ai === -1 ? methodOrder.length : ai) - (bi === -1 ? methodOrder.length : bi) || a.localeCompare(b);
    });
    return {
      resourcePath,
      methods,
      supportsList: methodSet.has("GET"),
      supportsCreate: methodSet.has("POST"),
      supportsUpdate: methodSet.has("PUT") || methodSet.has("PATCH"),
      supportsDelete: methodSet.has("DELETE"),
    };
  });
}

function buildFrontendContract(
  spec: { frontend?: any; filesToCreate?: string[] } | null | undefined,
  apiContract: { endpoints?: Array<{ path: string; method: string }> } | null | undefined,
  files: string[] = []
): FrontendContract {
  const roots = detectFrontendRoots(files);
  const rootDir = roots[0] || "";
  const frontendFramework = String(spec?.frontend?.framework || "").toLowerCase();
  const normalizedFiles = files.map((file) => String(file || "").replace(/\\/g, "/"));
  const framework: FrontendContract["framework"] =
    rootDir === "frontend"
      ? frontendFramework.includes("react") || normalizedFiles.some((file) => /\.tsx$/i.test(file))
        ? "react"
        : frontendFramework.includes("vue") || normalizedFiles.some((file) => /\.vue$/i.test(file))
          ? "vue"
          : frontendFramework.includes("svelte")
            ? "svelte"
            : "react"
      : rootDir === "public"
        ? "vanilla"
        : "none";
  const appType: FrontendContract["appType"] = rootDir === "frontend" ? "spa" : rootDir === "public" ? "static" : "none";
  const entryFiles = normalizedFiles
    .filter((file) => {
      if (rootDir === "frontend") {
        return /^frontend\/index\.html$/i.test(file) || /^frontend\/src\/(main|app)\.(ts|tsx|js|jsx|vue|svelte)$/i.test(file);
      }
      return /^public\/index\.html$/i.test(file);
    })
    .sort((a, b) => {
      const order = ["index.html", "src/main.ts", "src/main.tsx", "src/app.ts", "src/app.tsx", "src/app.vue", "src/app.svelte"];
      const relA = a.replace(/^frontend\//i, "").replace(/^public\//i, "").toLowerCase();
      const relB = b.replace(/^frontend\//i, "").replace(/^public\//i, "").toLowerCase();
      const ai = order.indexOf(relA);
      const bi = order.indexOf(relB);
      return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi) || relA.localeCompare(relB);
    });

  return {
    appType,
    framework,
    rootDir: rootDir as FrontendContract["rootDir"],
    entryFiles,
    apiUsage: deriveFrontendApiUsage(apiContract),
  };
}

export function buildExecutionProtocol(
  spec: { language?: string; framework?: string; filesToCreate?: string[]; runCommand?: string; testCommand?: string; entryPoint?: string } | null | undefined,
  manifest: { services?: Array<{ port?: number }> } | null | undefined,
  apiContract: { endpoints?: Array<{ path: string; method: string }> } | null | undefined,
  requirementProtocol?: RequirementProtocol | null | undefined
): ExecutionProtocol {
  const normalizedSpec = stabilizeSpecForExecution(spec, requirementProtocol);
  const resolvedRequirementProtocol = requirementProtocol || buildRequirementProtocol(null);
  const solutionProtocol = buildSolutionProtocol(resolvedRequirementProtocol, normalizedSpec, apiContract);
  const preferredHealthCheckPath =
    (apiContract?.endpoints || []).find(
      (endpoint) =>
        String(endpoint.method || "").toUpperCase() === "GET" &&
        /^\/api\/health\/?$/i.test(String(endpoint.path || ""))
    )?.path ||
    (apiContract?.endpoints || []).find(
      (endpoint) =>
        String(endpoint.method || "").toUpperCase() === "GET" &&
        /^\/health\/?$/i.test(String(endpoint.path || ""))
    )?.path ||
    (solutionProtocol.coverage.frontendPlanned ? "/" : "") ||
    (apiContract?.endpoints || []).find((endpoint) => String(endpoint.method || "").toUpperCase() === "GET")?.path ||
    "/api/health";
  const files = normalizedSpec.filesToCreate || [];
  const frontendRoots = detectFrontendRoots(files);
  const frontendContract = buildFrontendContract(normalizedSpec, apiContract, files);
  const fileContracts: Record<string, ExecutionProtocolFileContract> = {};
  for (const file of files) {
    const normalizedFile = String(file).replace(/\\/g, "/");
    const role = inferProtocolFileRole(normalizedFile);
    fileContracts[normalizedFile] = {
      role,
      allowedDependencyRoles: allowedRolesForProtocolFile(role),
      requiredExports: inferRequiredExports(normalizedFile, apiContract),
      ownedEndpoints: inferOwnedEndpoints(normalizedFile, apiContract),
      notes: role === "test" ? ["测试文件必须位于 testRoots 内并被 testMatch 覆盖"] : undefined,
    };
  }

  return {
    version: "v1",
    requirements: resolvedRequirementProtocol,
    solution: solutionProtocol,
    project: {
      language: normalizedSpec.language || "",
      framework: normalizedSpec.framework || "",
      runtime: detectProtocolRuntime(normalizedSpec.language || ""),
      workspaceLayout: {
        sourceRoots: ["src"],
        testRoots: getExpectedJestRoots(normalizedSpec),
        frontendRoots,
        entryFiles: normalizedSpec.entryPoint ? [normalizedSpec.entryPoint.replace(/\\/g, "/")] : [getEntryPoint({ spec: normalizedSpec } as JimClawState)],
        configFiles: files
          .filter((file: string) => inferProtocolFileRole(file) === "config")
          .map((file: string) => String(file).replace(/\\/g, "/")),
        infraFiles: files
          .filter((file: string) => inferProtocolFileRole(file) === "infra")
          .map((file: string) => String(file).replace(/\\/g, "/")),
      },
    },
    contracts: {
      api: {
        endpoints: (apiContract?.endpoints || []).map((endpoint) => ({
          path: String(endpoint.path || ""),
          method: String(endpoint.method || "").toUpperCase(),
        })),
      },
      frontend: frontendContract,
      files: fileContracts,
    },
    runtime: {
      startCommand: normalizedSpec.runCommand,
      testCommand: normalizedSpec.testCommand,
      entryPoint: normalizedSpec.entryPoint,
      buildOutput: detectProtocolRuntime(normalizedSpec.language || "") === "node" ? "dist" : undefined,
      listenPort: manifest?.services?.[0]?.port,
      healthCheckPath: preferredHealthCheckPath,
    },
    workflow: {
      blockingRules: [
        "协议文件布局不匹配时禁止进入 verifier/deploy",
        "测试文件未被测试框架发现时禁止进入 deploy",
        "引用不存在导出时禁止将当前文件标记为 completed",
      ],
      recoveryRules: [
        "layout_mismatch 由 architect/orchestrator 协议回收",
        "contract_drift 由 coder 在当前文件原地修复",
        "test_discovery_gap 优先修复测试目录与配置,而不是继续部署",
      ],
    },
    validation: {
      layoutRules: [
        "tests 必须位于 testRoots 内",
        "配置文件必须位于 configFiles 声明集合内",
      ],
      dependencyRules: [
        "route/controller/service/model/middleware 必须遵守 allowedDependencyRoles",
        "requiredExports 缺失时视为 contract_drift",
      ],
      runtimeRules: [
        "entryPoint/runCommand/healthCheckPath 必须互相一致",
        "listenPort 必须来自 manifest.services[0].port",
      ],
      acceptanceRules: [
        "声明的业务测试文件必须被实际测试配置覆盖",
        "deployment health check 必须命中协议 healthCheckPath",
        "用户明确要求前端时,必须存在前端页面文件与可访问入口",
        "用户明确要求前后端时,不得只交付 API 或只交付静态页面",
      ],
    },
  };
}

function inferExecutionPlanRole(file: string): ExecutionPlanFile["role"] {
  const normalized = String(file || "").replace(/\\/g, "/");
  if (/^public\/.+/i.test(normalized) || /\.html$/i.test(normalized)) {
    return "ui";
  }
  return inferProtocolFileRole(normalized);
}

export function buildExecutionPlan(
  spec: { filesToCreate?: string[] } | null | undefined,
  subTasks: Array<{ id: string; fileTarget: string; dependencies?: string[] }> = [],
  requirementProtocol: RequirementProtocol | null | undefined,
  executionProtocol: ExecutionProtocol | null | undefined
): ExecutionPlan {
  const normalizedFiles = (spec?.filesToCreate || []).map((file) => String(file).replace(/\\/g, "/"));
  const files: ExecutionPlanFile[] = normalizedFiles.map((file) => ({
    path: file,
    role: inferExecutionPlanRole(file),
    required: true,
    satisfiesRequirements: (requirementProtocol?.userIntent?.requirements || []).filter((requirement) => {
      if (/前端|页面|界面|ui|web/i.test(requirement)) return /^public\/.+|\.html$/i.test(file);
      if (/后端|api|接口|服务|express|fastapi|node/i.test(requirement)) return /^(src\/.+\.(ts|js)|package\.json|tsconfig\.json)$/i.test(file) && !/^public\//i.test(file);
      if (/权限|授权|认证|登录|jwt/i.test(requirement)) return /auth/i.test(file);
      if (/日志|审计|追踪/i.test(requirement)) return /log|audit/i.test(file);
      return false;
    }),
    dependsOnFiles: [],
  }));
  const fileSet = new Set(files.map((file) => file.path));
  const tasks: ExecutionPlanTask[] = subTasks.map((task) => ({
    id: task.id,
    fileTarget: String(task.fileTarget || "").replace(/\\/g, "/"),
    role: inferExecutionPlanRole(task.fileTarget),
    dependsOnTaskIds: subTasks
      .filter((candidate) => (task.dependencies || []).map((dep) => String(dep).replace(/\\/g, "/")).includes(String(candidate.fileTarget || "").replace(/\\/g, "/")))
      .map((candidate) => candidate.id),
    verificationHooks: [
      inferExecutionPlanRole(task.fileTarget) === "test" ? "test-discovery" : "file-written",
      inferExecutionPlanRole(task.fileTarget) === "route" ? "route-mounted" : "syntax-check",
    ],
  }));

  for (const file of files) {
    const task = tasks.find((candidate) => candidate.fileTarget === file.path);
    if (task) {
      file.dependsOnFiles = task.dependsOnTaskIds
        .map((taskId) => tasks.find((candidate) => candidate.id === taskId)?.fileTarget)
        .filter(Boolean) as string[];
    }
  }

  const acceptanceChecks = [
    "requirements-covered",
    "task-graph-complete",
    "route-mounted",
    "test-discovery",
    "health-check-ready",
  ];

  if (executionProtocol?.runtime?.healthCheckPath) {
    acceptanceChecks.push(`health:${executionProtocol.runtime.healthCheckPath}`);
  }

  return {
    version: "v1",
    files: files.filter((file) => fileSet.has(file.path)),
    tasks,
    acceptanceChecks,
  };
}

export function findExecutionPlanGaps(
  executionPlan: ExecutionPlan | null | undefined,
  requirementProtocol: RequirementProtocol | null | undefined
) {
  const files = executionPlan?.files || [];
  const tasks = executionPlan?.tasks || [];
  const hasRole = (role: ExecutionPlanFile["role"]) => files.some((file) => file.role === role);
  const gaps: Array<{ summary: string; evidence: string[] }> = [];

  if (requirementProtocol?.capabilities.frontendRequired) {
    if (!files.some((file) => file.role === "ui")) {
      gaps.push({
        summary: "执行计划缺少前端页面任务",
        evidence: [`files=${files.map((file) => file.path).join(", ")}`],
      });
    }
  }

  if (requirementProtocol?.capabilities.backendRequired) {
    // 如果文件列表已经很小,说明 Architect 已精简规划,
    // 入口文件可能直接包含路由定义,不需要强制 CRUD 分层
    // 排除非业务文件(jest config, scripts, tsconfig, package.json)后再判断
    const businessFiles = (files || []).filter(f => !/^(jest\.config|tsconfig|package|\.eslintrc|scripts\/|Dockerfile|docker-compose|README|\.gitignore|\.env|conftest|pytest|__init__|requirements)/i.test(f.path));
    const minimalPlan = businessFiles.length > 0 && businessFiles.length <= 8;
    for (const role of ["entry", ...(minimalPlan ? [] : ["route", "controller", "service", "model"] as const)] as const) {
      if (!hasRole(role)) {
        gaps.push({
          summary: `执行计划缺少 ${role} 角色任务`,
          evidence: [`files=${files.map((file) => `${file.path}:${file.role}`).join(", ")}`],
        });
      }
    }
  }

  if (requirementProtocol?.capabilities.authRequired && !files.some((file) => /auth/i.test(file.path))) {
    gaps.push({
      summary: "执行计划缺少认证相关任务",
      evidence: [`files=${files.map((file) => file.path).join(", ")}`],
    });
  }

  if ((requirementProtocol?.userIntent?.acceptanceCriteria || []).length > 0 && !tasks.some((task) => task.role === "test")) {
    gaps.push({
      summary: "执行计划缺少测试任务",
      evidence: [`tasks=${tasks.map((task) => task.fileTarget).join(", ")}`],
    });
  }

  return gaps;
}

export function buildValidationReport(
  protocolFailures: Array<{ blocking?: boolean; summary?: string; file?: string; evidence?: string[] }> = [],
  opts: {
    failureType?: ValidationFailureType;
    status?: "pass" | "fail";
    blocking?: boolean;
  } = {}
): ValidationReport {
  const findings = protocolFailures.map((failure) => ({
    type: opts.failureType || "implementation_bug",
    summary: String(failure.summary || ""),
    file: failure.file,
    evidence: Array.isArray(failure.evidence) ? failure.evidence : [],
  }));
  const blocking = opts.blocking ?? findings.length > 0;
  return {
    version: "v1",
    status: opts.status || (blocking ? "fail" : "pass"),
    failureType: blocking ? (opts.failureType || "implementation_bug") : undefined,
    blocking,
    findings,
  };
}

export function buildRuntimeStateSnapshot(state: Partial<JimClawState>): RuntimeStateSnapshot {
  const deploymentStatus = (state as any).deploymentStatus || null;
  return {
    version: "v1",
    envReady: Boolean(state.envReady),
    hostDepsReady: Boolean(state.envReady),
    testRuntimeReady: Boolean(state.containerId || deploymentStatus?.status === "running"),
    deployRuntimeReady: Boolean(state.containerId),
    containerId: state.containerId || undefined,
    hostPort: state.allocatedHostPort || state.manifest?.services?.[0]?.port,
    containerPort: state.manifest?.services?.[0]?.port,
    deploymentUrl: deploymentStatus?.url,
    startupLogPath: deploymentStatus?.logPath,
  };
}

export function buildRepairPlan(report: ValidationReport | null | undefined): RepairPlan | null {
  if (!report?.blocking || !report.failureType) return null;
  const repairType =
    report.failureType === "planning_gap" ? "planning" :
    report.failureType === "environment_gap" ? "environment" :
    report.failureType === "runtime_gap" ? "runtime" :
    "implementation";
  const targets = Array.from(new Set(report.findings.map((finding) => finding.file || finding.summary).filter(Boolean)));
  return {
    version: "v1",
    repairType,
    targets,
    allowedEdits: targets,
    expectedEvidence: report.findings.flatMap((finding) => finding.evidence || []),
  };
}

export function buildCustomerApprovalState(
  opts: {
    autoApprove?: Partial<{ requirements: boolean; solution: boolean; deploy: boolean }>;
    summaries?: Partial<Record<"requirements" | "solution" | "deploy", string>>;
    previous?: CustomerApprovalState | null;
  } = {}
) {
  const autoApprove = {
    requirements: Boolean(opts.autoApprove?.requirements),
    solution: Boolean(opts.autoApprove?.solution),
    deploy: Boolean(opts.autoApprove?.deploy),
  };
  const previousByStage = new Map(
    (opts.previous?.checkpoints || []).map((checkpoint) => [checkpoint.stage, checkpoint])
  );
  return {
    version: "v1" as const,
    autoApprove,
    checkpoints: (["requirements", "solution", "deploy"] as const).map((stage) => ({
      stage,
      required: true,
      approved: autoApprove[stage] || Boolean(previousByStage.get(stage)?.approved),
      approvedBy: previousByStage.get(stage)?.approvedBy || (autoApprove[stage] ? ("default-authorization" as const) : undefined),
      summary: opts.summaries?.[stage] || "",
      timestamp: previousByStage.get(stage)?.timestamp || (autoApprove[stage] ? getBeijingTime() : undefined),
    })),
  };
}

export function getProtocolTestRoots(
  protocol: ExecutionProtocol | null | undefined,
  spec: { filesToCreate?: string[] } | null | undefined
): string[] {
  const roots = protocol?.project?.workspaceLayout?.testRoots || [];
  return roots.length > 0 ? roots : getExpectedJestRoots(spec);
}

export function getProtocolBusinessTestFiles(
  protocol: ExecutionProtocol | null | undefined,
  spec: { filesToCreate?: string[] } | null | undefined
): string[] {
  const protocolFiles = Object.entries(protocol?.contracts?.files || {})
    .filter(([, contract]) => contract.role === "test")
    .map(([file]) => file);
  return protocolFiles.length > 0 ? protocolFiles : getDeclaredBusinessTestFiles(spec);
}

export function getProtocolFileContract(
  protocol: ExecutionProtocol | null | undefined,
  fileTarget: string
): ExecutionProtocolFileContract | null {
  return protocol?.contracts?.files?.[String(fileTarget || "").replace(/\\/g, "/")] || null;
}

export function buildProtocolPatchesForFixPlan(
  failingFiles: string[],
  protocol: ExecutionProtocol | null | undefined,
  apiContract: { endpoints?: Array<{ path: string; method: string }> } | null | undefined
): ProtocolPatch[] {
  const patches: ProtocolPatch[] = [];
  for (const rawFile of failingFiles) {
    const file = String(rawFile || "").replace(/\\/g, "/");
    const fileContract = getProtocolFileContract(protocol, file);
    if (!fileContract) continue;

    if (fileContract.role === "route") {
      const ownedEndpoints = inferOwnedEndpoints(file, apiContract);
      if (ownedEndpoints.length > 0) {
        patches.push({
          target: "contracts",
          action: "replace",
          path: `files.${file}.ownedEndpoints`,
          value: ownedEndpoints,
          reason: `${file} 是路由文件,修复时必须严格绑定到协议端点所有权`,
        });
      }
    }

    if (fileContract.role === "test") {
      patches.push({
        target: "validation",
        action: "append",
        path: "acceptanceRules",
        value: `测试文件 ${file} 必须被 testRoots/testMatch 实际发现`,
        reason: `${file} 是失败测试文件,修复时必须确认测试发现链路有效`,
      });
    }

    if (fileContract.role === "entry") {
      patches.push({
        target: "runtime",
        action: "replace",
        path: "entryPoint",
        value: file,
        reason: `${file} 是入口文件,修复时必须作为运行时唯一入口`,
      });
    }
  }

  return patches;
}

function normalizeProtocolPatchSegments(pathValue: string): string[] {
  const raw = String(pathValue || "");
  if (raw.startsWith("files.") && raw.split(".").length >= 3) {
    const parts = raw.split(".");
    return ["files", parts.slice(1, -1).join("."), parts[parts.length - 1]];
  }
  return raw
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function ensureObjectPath(root: Record<string, any>, segments: string[]): { parent: Record<string, any>; leaf: string } | null {
  if (segments.length === 0) return null;
  let current: Record<string, any> = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (current[segment] === undefined || current[segment] === null || typeof current[segment] !== "object") {
      current[segment] = {};
    }
    current = current[segment];
  }
  return { parent: current, leaf: segments[segments.length - 1] };
}

export function applyProtocolPatches(
  protocol: ExecutionProtocol | null | undefined,
  patches: ProtocolPatch[] | null | undefined
): ExecutionProtocol | null {
  if (!protocol) return null;
  if (!patches || patches.length === 0) return protocol;

  const nextProtocol = JSON.parse(JSON.stringify(protocol)) as ExecutionProtocol;
  const rootByTarget: Record<ProtocolPatch["target"], any> = {
    project: nextProtocol.project,
    contracts: nextProtocol.contracts,
    runtime: nextProtocol.runtime,
    validation: nextProtocol.validation,
    workflow: nextProtocol.workflow,
  };

  for (const patch of patches) {
    const targetRoot = rootByTarget[patch.target];
    if (!targetRoot) continue;
    const pointer = ensureObjectPath(targetRoot, normalizeProtocolPatchSegments(patch.path));
    if (!pointer) continue;

    if (patch.action === "remove") {
      delete pointer.parent[pointer.leaf];
      continue;
    }

    if (patch.action === "replace") {
      pointer.parent[pointer.leaf] = patch.value;
      continue;
    }

    if (patch.action === "append") {
      const currentValue = pointer.parent[pointer.leaf];
      if (Array.isArray(currentValue)) {
        pointer.parent[pointer.leaf] = [...currentValue, patch.value];
      } else if (currentValue === undefined) {
        pointer.parent[pointer.leaf] = [patch.value];
      } else {
        pointer.parent[pointer.leaf] = [currentValue, patch.value];
      }
    }
  }

  return nextProtocol;
}

function buildErrorModuleScaffold(): string {
  return `export interface AppErrorOptions {
  statusCode?: number;
  code?: string;
  details?: unknown;
  cause?: unknown;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message);
// ═══════════════════════════════════════════════════════════════════════
// §4  错误类型体系 (AppError / ValidationError / NotFoundError ...)
// ═══════════════════════════════════════════════════════════════════════
    this.name = new.target.name;
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? "APP_ERROR";
    this.details = options.details;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: unknown) {
    super(message, { statusCode: 400, code: "VALIDATION_ERROR", details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized", details?: unknown) {
    super(message, { statusCode: 401, code: "UNAUTHORIZED", details });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", details?: unknown) {
    super(message, { statusCode: 403, code: "FORBIDDEN", details });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found", details?: unknown) {
    super(message, { statusCode: 404, code: "NOT_FOUND", details });
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", details?: unknown) {
    super(message, { statusCode: 409, code: "CONFLICT", details });
  }
}

export function toErrorResponse(error: unknown): {
  success: false;
  error: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof AppError) {
    return {
      success: false,
      error: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      success: false,
      error: "INTERNAL_ERROR",
      message: error.message,
    };
  }

  return {
    success: false,
    error: "UNKNOWN_ERROR",
    message: "Unknown error",
  };
}
`;
}

function buildAuthSessionServiceScaffold(): string {
  return `import { UnauthorizedError, ValidationError } from "../errors";

export interface AuthSessionUser {
  id: string;
  username: string;
  role?: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════
// §5  认证与会话 (AuthSession / Credential / Role / AuthService)
// ═══════════════════════════════════════════════════════════════════════
export interface AuthSessionTokenPayload {
  sub: string;
  username: string;
  role?: string;
  iat: number;
  exp: number;
}

export interface AuthSession {
  token: string;
  issuedAt: string;
  expiresAt: string;
  user: AuthSessionUser;
}

function encodePayload(payload: AuthSessionTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

export function decodeSessionToken(token: string): AuthSessionTokenPayload {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf-8");
    return JSON.parse(decoded) as AuthSessionTokenPayload;
  } catch {
    throw new UnauthorizedError("无效的会话令牌");
  }
}

export function createSession(user: AuthSessionUser, ttlMinutes = 120): AuthSession {
  if (!user?.id || !user?.username) {
    throw new ValidationError("创建会话时缺少用户标识");
  }

  const now = new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = issuedAt + ttlMinutes * 60;
  const payload: AuthSessionTokenPayload = {
    sub: user.id,
    username: user.username,
    role: user.role,
    iat: issuedAt,
    exp: expiresAt,
  };

  return {
    token: encodePayload(payload),
    issuedAt: now.toISOString(),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    user,
  };
}

export function verifySessionToken(token: string, now: Date = new Date()): AuthSessionTokenPayload {
  const payload = decodeSessionToken(token);
  if (payload.exp <= Math.floor(now.getTime() / 1000)) {
    throw new UnauthorizedError("会话已过期");
  }
  return payload;
}

export function buildSessionUser(payload: AuthSessionTokenPayload): AuthSessionUser {
  return {
    id: payload.sub,
    username: payload.username,
    role: payload.role,
  };
}
`;
}

function buildAuthCredentialServiceScaffold(): string {
  return `import { createHash, randomUUID } from "crypto";
import { UnauthorizedError, ValidationError } from "../errors";

export interface CredentialHash {
  algorithm: "sha256";
  salt: string;
  digest: string;
}

export function ensureCredentialStrength(secret: string): void {
  const normalized = String(secret || "").trim();
  if (normalized.length < 8) {
    throw new ValidationError("口令长度至少需要 8 位");
  }
  if (!/[A-Za-z]/.test(normalized) || !/\\d/.test(normalized)) {
    throw new ValidationError("口令必须同时包含字母和数字");
  }
}

export function hashCredential(secret: string, salt: string = randomUUID()): CredentialHash {
  ensureCredentialStrength(secret);
  return {
    algorithm: "sha256",
    salt,
    digest: createHash("sha256").update(\`\${salt}:\${secret}\`).digest("hex"),
  };
}

export function verifyCredential(secret: string, stored: CredentialHash): boolean {
  const candidate = createHash("sha256")
    .update(\`\${stored.salt}:\${secret}\`)
    .digest("hex");
  return candidate === stored.digest;
}

export function assertCredential(secret: string, stored: CredentialHash): void {
  if (!verifyCredential(secret, stored)) {
    throw new UnauthorizedError("账号或口令错误");
  }
}
`;
}

function buildAuthAccountPolicyServiceScaffold(): string {
  return `import { ForbiddenError, ValidationError } from "../errors";

export interface AuthAccountPolicyContext {
  accountId: string;
  status?: "active" | "disabled" | "locked" | "pending";
  roles?: string[];
  lockedUntil?: string | null;
  disabledReason?: string;
}

export function normalizeRoles(roles: string[] = []): string[] {
  return Array.from(
    new Set(
      roles
        .map((role) => String(role || "").trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

export function hasRequiredRole(
  context: Pick<AuthAccountPolicyContext, "roles">,
  requiredRoles: string[] = []
): boolean {
  const normalizedRoles = normalizeRoles(context.roles || []);
  const normalizedRequired = normalizeRoles(requiredRoles);
  if (normalizedRequired.length === 0) return true;
  return normalizedRequired.some((role) => normalizedRoles.includes(role));
}

export function ensureAccountPolicy(
  context: AuthAccountPolicyContext,
  requiredRoles: string[] = []
): void {
  if (!context.accountId) {
    throw new ValidationError("缺少账号标识");
  }

  if (context.status && context.status !== "active") {
    throw new ForbiddenError("账号当前不可用", {
      status: context.status,
      disabledReason: context.disabledReason,
    });
  }

  if (context.lockedUntil && new Date(context.lockedUntil).getTime() > Date.now()) {
    throw new ForbiddenError("账号仍处于锁定状态", { lockedUntil: context.lockedUntil });
  }

  if (!hasRequiredRole(context, requiredRoles)) {
    throw new ForbiddenError("账号缺少访问所需角色", {
      roles: normalizeRoles(context.roles || []),
      requiredRoles: normalizeRoles(requiredRoles),
    });
  }
}

export function buildAccountPolicySnapshot(context: AuthAccountPolicyContext): {
  accountId: string;
  status: string;
  roles: string[];
  locked: boolean;
} {
  return {
    accountId: context.accountId,
    status: context.status || "active",
    roles: normalizeRoles(context.roles || []),
    locked: Boolean(context.lockedUntil && new Date(context.lockedUntil).getTime() > Date.now()),
  };
}
`;
}

function buildAuthServiceScaffold(loggerImportPath: string): string {
  return `import { createHash, randomUUID } from "crypto";
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from "../errors";
import { logEntries } from "${loggerImportPath}";

export type AuthRole = "admin" | "librarian" | "auditor" | "member";

export interface StoredUser {
  id: string;
  username: string;
  passwordHash: string;
  roles: AuthRole[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUser {
  id: string;
  username: string;
  roles: AuthRole[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  endedAt?: string;
}

export interface AuthServiceState {
  usersById: Map<string, StoredUser>;
  userIdByUsername: Map<string, string>;
  sessionsByToken: Map<string, AuthSession>;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface CreateUserInput {
  username: string;
  password: string;
  roles?: AuthRole[];
  enabled?: boolean;
}

export interface ActorContext {
  actorId?: string;
  source?: string;
  roles?: AuthRole[];
}

function getNow(): Date {
  return new Date();
}

function normalizeUsername(username: string): string {
  const normalized = String(username || "").trim().toLowerCase();
  if (!normalized) {
    throw new ValidationError("用户名不能为空");
  }
  return normalized;
}

function normalizeRole(role: string): AuthRole {
  const normalized = String(role || "").trim().toLowerCase();
  if (normalized === "admin" || normalized === "librarian" || normalized === "auditor" || normalized === "member") {
    return normalized;
  }
  throw new ValidationError("角色不合法", { role });
}

function ensureRoleList(roles: AuthRole[] = ["member"]): AuthRole[] {
  const normalizedRoles = Array.from(new Set(roles.map((role) => normalizeRole(role))));
  if (normalizedRoles.length === 0) {
    throw new ValidationError("至少需要一个角色");
  }
  return normalizedRoles;
}

function hashPassword(password: string): string {
  const normalized = String(password || "");
  if (normalized.length < 8) {
    throw new ValidationError("密码长度至少为 8 位");
  }
  return createHash("sha256").update(normalized).digest("hex");
}

function verifyPassword(password: string, passwordHash: string): boolean {
  return hashPassword(password) === passwordHash;
}

function generateSessionToken(userId: string, createdAt: string): string {
  return Buffer.from(JSON.stringify({ sub: userId, createdAt }), "utf-8").toString("base64url");
}

function toPublicUser(user: StoredUser): PublicUser {
  return {
    id: user.id,
    username: user.username,
    roles: [...user.roles],
    enabled: user.enabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function buildAuditPayload(
  event: string,
  actor: ActorContext,
  targetId: string,
  result: "success" | "failure"
): {
  actor: string;
  source: string;
  timestamp: string;
  targetId: string;
  result: "success" | "failure";
  event: string;
} {
  return {
    actor: actor.actorId || "system",
    source: actor.source || "auth-service",
    timestamp: getNow().toISOString(),
    targetId,
    result,
    event,
  };
}

function appendAuditLog(payload: ReturnType<typeof buildAuditPayload>): void {
  logEntries.push({
    timestamp: payload.timestamp,
    method: "AUTH",
    path: \`/audit/\${payload.event}\`,
    statusCode: payload.result === "success" ? 200 : 400,
    responseTime: 0,
    userAgent: payload.actor,
    ip: payload.source,
    userId: payload.targetId,
  });
}

function findUserByUsername(state: AuthServiceState, username: string): StoredUser | null {
  const userId = state.userIdByUsername.get(normalizeUsername(username));
  return userId ? state.usersById.get(userId) || null : null;
}

function findUserById(state: AuthServiceState, userId: string): StoredUser | null {
  return state.usersById.get(userId) || null;
}

function requireUser(state: AuthServiceState, userId: string): StoredUser {
  const user = findUserById(state, userId);
  if (!user) {
    throw new NotFoundError("用户不存在", { userId });
  }
  return user;
}

function requireActorPermission(actor: ActorContext, requiredRoles: AuthRole[]): void {
  const actorRoles = ensureRoleList(actor.roles || ["admin"]);
  if (!requiredRoles.some((role) => actorRoles.includes(role))) {
    throw new UnauthorizedError("权限不足");
  }
}

function seedDefaultAdmin(state: AuthServiceState): void {
  if (state.userIdByUsername.has("admin")) return;
  const now = getNow().toISOString();
  const admin: StoredUser = {
    id: "user-admin",
    username: "admin",
    passwordHash: hashPassword("Admin1234"),
    roles: ["admin"],
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  state.usersById.set(admin.id, admin);
  state.userIdByUsername.set(admin.username, admin.id);
}

/** 创建自包含的认证服务内存态。 */
export function createAuthServiceState(): AuthServiceState {
  const state: AuthServiceState = {
    usersById: new Map<string, StoredUser>(),
    userIdByUsername: new Map<string, string>(),
    sessionsByToken: new Map<string, AuthSession>(),
  };
  seedDefaultAdmin(state);
  return state;
}

/** 断言用户处于启用状态。 */
export function assertUserActive(user: Pick<StoredUser, "id" | "enabled">, code = "AUTH_USER_DISABLED"): void {
  if (!user.id) {
    throw new ValidationError("缺少用户标识");
  }
  if (!user.enabled) {
    throw new UnauthorizedError(code);
  }
}

/** 使用用户名和密码登录,返回会话与公开用户信息。 */
export function login(
  state: AuthServiceState,
  input: LoginInput,
  actor: ActorContext = {}
): { session: AuthSession; user: PublicUser } {
  const username = normalizeUsername(input.username);
  const user = findUserByUsername(state, username);
  if (!user || !verifyPassword(input.password, user.passwordHash)) {
    appendAuditLog(buildAuditPayload("login_failure", actor, username, "failure"));
    throw new UnauthorizedError("账号或密码错误");
  }
  assertUserActive(user);

  const createdAt = getNow().toISOString();
  const session: AuthSession = {
    token: generateSessionToken(user.id, createdAt),
    userId: user.id,
    createdAt,
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  };
  state.sessionsByToken.set(session.token, session);
  appendAuditLog(buildAuditPayload("login_success", actor, user.id, "success"));
  return { session, user: toPublicUser(user) };
}

/** 注销会话。 */
export function logout(state: AuthServiceState, sessionToken: string, actor: ActorContext = {}): { success: true } {
  const session = state.sessionsByToken.get(sessionToken);
  if (!session) {
    throw new UnauthorizedError("会话不存在");
  }
  session.endedAt = getNow().toISOString();
  appendAuditLog(buildAuditPayload("logout", actor, session.userId, "success"));
  return { success: true };
}

/** 创建新用户并保证用户名唯一。 */
export function createUser(
  state: AuthServiceState,
  input: CreateUserInput,
  actor: ActorContext = {}
): PublicUser {
  const username = normalizeUsername(input.username);
  if (findUserByUsername(state, username)) {
    throw new ConflictError("用户已存在", { username });
  }
  const now = getNow().toISOString();
  const user: StoredUser = {
    id: randomUUID(),
    username,
    passwordHash: hashPassword(input.password),
    roles: ensureRoleList(input.roles || ["member"]),
    enabled: input.enabled !== false,
    createdAt: now,
    updatedAt: now,
  };
  state.usersById.set(user.id, user);
  state.userIdByUsername.set(user.username, user.id);
  appendAuditLog(buildAuditPayload("user_created", actor, user.id, "success"));
  return toPublicUser(user);
}

/** 启用或禁用用户。 */
export function setUserEnabled(
  state: AuthServiceState,
  userId: string,
  enabled: boolean,
  actor: ActorContext = {}
): PublicUser {
  requireActorPermission(actor, ["admin"]);
  const user = requireUser(state, userId);
  user.enabled = enabled;
  user.updatedAt = getNow().toISOString();
  appendAuditLog(buildAuditPayload(enabled ? "user_enabled" : "user_disabled", actor, user.id, "success"));
  return toPublicUser(user);
}

/** 重置用户密码。 */
export function resetPassword(
  state: AuthServiceState,
  userId: string,
  newPassword: string,
  actor: ActorContext = {}
): PublicUser {
  requireActorPermission(actor, ["admin", "librarian"]);
  const user = requireUser(state, userId);
  user.passwordHash = hashPassword(newPassword);
  user.updatedAt = getNow().toISOString();
  appendAuditLog(buildAuditPayload("password_reset", actor, user.id, "success"));
  return toPublicUser(user);
}

/** 为用户分配角色。 */
export function assignRoles(
  state: AuthServiceState,
  userId: string,
  roles: AuthRole[],
  actor: ActorContext = {}
): PublicUser {
  requireActorPermission(actor, ["admin"]);
  const user = requireUser(state, userId);
  user.roles = ensureRoleList(roles);
  user.updatedAt = getNow().toISOString();
  appendAuditLog(buildAuditPayload("role_changed", actor, user.id, "success"));
  return toPublicUser(user);
}

export function __resetAuthStore(state: AuthServiceState): void {
  state.usersById.clear();
  state.userIdByUsername.clear();
  state.sessionsByToken.clear();
  seedDefaultAdmin(state);
}
`;
}

function buildQueryServiceScaffold(entityStem: string): string {
  const entityPascal = toPascalCase(entityStem) || "Item";
  return `import { NotFoundError } from "../errors";

export interface ${entityPascal}Record {
// ═══════════════════════════════════════════════════════════════════════
// §6  脚手架模板 (getDeterministicTemplateScaffold + 实体模板)
// ═══════════════════════════════════════════════════════════════════════
  id: string;
  title: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface ${entityPascal}QueryOptions {
  keyword?: string;
  status?: string;
  limit?: number;
}

function matches${entityPascal}Keyword(record: ${entityPascal}Record, keyword: string): boolean {
  return JSON.stringify(record).toLowerCase().includes(keyword.toLowerCase());
}

export function list${entityPascal}Records(
  records: ${entityPascal}Record[],
  options: ${entityPascal}QueryOptions = {}
): ${entityPascal}Record[] {
  let result = [...records];
  if (options.keyword) {
    result = result.filter((record) => matches${entityPascal}Keyword(record, options.keyword as string));
  }
  if (options.status) {
    result = result.filter((record) => String(record.status || "").toLowerCase() === String(options.status).toLowerCase());
  }
  if (typeof options.limit === "number" && options.limit >= 0) {
    result = result.slice(0, options.limit);
  }
  return result;
}

export function find${entityPascal}ById(records: ${entityPascal}Record[], id: string): ${entityPascal}Record {
  const found = records.find((record) => record.id === id);
  if (!found) {
    throw new NotFoundError("${entityPascal} 记录不存在", { id });
  }
  return found;
}

export function summarize${entityPascal}Collection(records: ${entityPascal}Record[]): {
  total: number;
  active: number;
} {
  return {
    total: records.length,
    active: records.filter((record) => String(record.status || "active").toLowerCase() !== "archived").length,
  };
}
`;
}

function buildMutationServiceScaffold(entityStem: string): string {
  const entityPascal = toPascalCase(entityStem) || "Item";
  const entityCamel = toCamelCase(entityStem) || "item";
  return `import { NotFoundError, ValidationError } from "../errors";

export interface ${entityPascal}MutationInput {
  id?: string;
  title: string;
  status?: string;
  [key: string]: unknown;
}

export interface ${entityPascal}Record extends ${entityPascal}MutationInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

function build${entityPascal}Id(seed: number): string {
  return "${entityCamel}-" + String(seed).padStart(4, "0");
}

export function create${entityPascal}Record(
  input: ${entityPascal}MutationInput,
  existing: ${entityPascal}Record[] = []
): ${entityPascal}Record {
  const title = String(input.title || "").trim();
  if (!title) {
    throw new ValidationError("${entityPascal} 标题不能为空");
  }

  const now = new Date().toISOString();
  return {
    ...input,
    id: input.id || build${entityPascal}Id(existing.length + 1),
    title,
    status: input.status || "active",
    createdAt: now,
    updatedAt: now,
  };
}

export function update${entityPascal}Record(
  records: ${entityPascal}Record[],
  id: string,
  patch: Partial<${entityPascal}MutationInput>
): ${entityPascal}Record {
  const index = records.findIndex((record) => record.id === id);
  if (index < 0) {
    throw new NotFoundError("${entityPascal} 记录不存在", { id });
  }

  const nextTitle = patch.title === undefined ? records[index].title : String(patch.title).trim();
  if (!nextTitle) {
    throw new ValidationError("${entityPascal} 标题不能为空");
  }

  const updated: ${entityPascal}Record = {
    ...records[index],
    ...patch,
    title: nextTitle,
    updatedAt: new Date().toISOString(),
  };
  records[index] = updated;
  return updated;
}

export function delete${entityPascal}Record(records: ${entityPascal}Record[], id: string): ${entityPascal}Record[] {
  const exists = records.some((record) => record.id === id);
  if (!exists) {
    throw new NotFoundError("${entityPascal} 记录不存在", { id });
  }
  return records.filter((record) => record.id !== id);
}
`;
}

function buildInventoryServiceScaffold(entityStem: string): string {
  const entityPascal = toPascalCase(entityStem) || "Item";
  return `import { NotFoundError, ValidationError } from "../errors";

export interface ${entityPascal}InventoryRecord {
  id: string;
  totalQuantity: number;
  availableQuantity: number;
  reservedQuantity: number;
  status?: string;
  [key: string]: unknown;
}

function find${entityPascal}InventoryIndex(records: ${entityPascal}InventoryRecord[], id: string): number {
  return records.findIndex((record) => record.id === id);
}

export function adjust${entityPascal}Inventory(
  records: ${entityPascal}InventoryRecord[],
  id: string,
  delta: number
): ${entityPascal}InventoryRecord {
  const index = find${entityPascal}InventoryIndex(records, id);
  if (index < 0) {
    throw new NotFoundError("${entityPascal} 库存记录不存在", { id });
  }

  const nextAvailable = records[index].availableQuantity + delta;
  if (nextAvailable < 0) {
    throw new ValidationError("${entityPascal} 可用库存不能小于 0", { id, delta });
  }

  const updated = {
    ...records[index],
    availableQuantity: nextAvailable,
    totalQuantity: Math.max(records[index].totalQuantity, nextAvailable + records[index].reservedQuantity),
  };
  records[index] = updated;
  return updated;
}

export function mark${entityPascal}Availability(
  records: ${entityPascal}InventoryRecord[],
  id: string,
  status: string
): ${entityPascal}InventoryRecord {
  const index = find${entityPascal}InventoryIndex(records, id);
  if (index < 0) {
    throw new NotFoundError("${entityPascal} 库存记录不存在", { id });
  }

  const updated = {
    ...records[index],
    status: String(status || "active"),
  };
  records[index] = updated;
  return updated;
}

export function summarize${entityPascal}Inventory(records: ${entityPascal}InventoryRecord[]): {
  totalItems: number;
  totalQuantity: number;
  availableQuantity: number;
  lowStockIds: string[];
} {
  return {
    totalItems: records.length,
    totalQuantity: records.reduce((sum, record) => sum + record.totalQuantity, 0),
    availableQuantity: records.reduce((sum, record) => sum + record.availableQuantity, 0),
    lowStockIds: records.filter((record) => record.availableQuantity <= 1).map((record) => record.id),
  };
}
`;
}

function buildEntitySeedInputCode(entityStem: string): string {
  switch (entityStem) {
    case "book":
      return `{
  title: "示例图书",
  author: "示例作者",
  category: "默认分类",
  isbn: "isbn-demo-001",
  totalCopies: 3,
  availableCopies: 3,
  status: "available",
}`;
    case "product":
      return `{
  name: "示例商品",
  sku: "sku-demo-001",
  price: 99,
  stock: 10,
  status: "active",
}`;
    default:
      return `{
  name: "示例记录",
  status: "active",
}`;
  }
}

function buildEntityModelScaffold(entityStem: string): string {
  const singularStem = singularizeStem(entityStem) || "item";
  const entityPascal = toPascalCase(singularStem) || "Item";
  let shape = `  id: string;
  name: string;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;`;
  let inputShape = `  name: string;
  status?: "active" | "inactive";`;

  if (singularStem === "book") {
    shape = `  id: string;
  title: string;
  author: string;
  category: string;
  isbn: string;
  totalCopies: number;
  availableCopies: number;
  status: "available" | "borrowed" | "reserved";
  createdAt: string;
  updatedAt: string;`;
    inputShape = `  title: string;
  author: string;
  category?: string;
  isbn: string;
  totalCopies?: number;
  availableCopies?: number;
  status?: "available" | "borrowed" | "reserved";`;
  } else if (singularStem === "product") {
    shape = `  id: string;
  name: string;
  sku: string;
  price: number;
  stock: number;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;`;
    inputShape = `  name: string;
  sku: string;
  price?: number;
  stock?: number;
  status?: "active" | "inactive";`;
  }

  return `export interface ${entityPascal} {
${shape}
}

export interface ${entityPascal}Input {
${inputShape}
}

function build${entityPascal}Id(): string {
  return "${singularStem}-" + Math.random().toString(36).slice(2, 10);
}

export function create${entityPascal}(input: ${entityPascal}Input): ${entityPascal} {
  const now = new Date().toISOString();
  return {
    id: build${entityPascal}Id(),
${singularStem === "book"
    ? `    title: String(input.title || "").trim(),
    author: String(input.author || "").trim(),
    category: String(input.category || "未分类").trim(),
    isbn: String(input.isbn || "").trim(),
    totalCopies: Number(input.totalCopies || 1),
    availableCopies: Number(input.availableCopies ?? input.totalCopies ?? 1),
    status: input.status || "available",`
    : singularStem === "product"
      ? `    name: String(input.name || "").trim(),
    sku: String(input.sku || "").trim(),
    price: Number(input.price || 0),
    stock: Number(input.stock || 0),
    status: input.status || "active",`
      : `    name: String(input.name || "").trim(),
    status: input.status || "active",`}
    createdAt: now,
    updatedAt: now,
  };
}

export function update${entityPascal}FromPatch(
  current: ${entityPascal},
  patch: Partial<${entityPascal}Input>
): ${entityPascal} {
  return {
    ...current,
${singularStem === "book"
    ? `    title: patch.title !== undefined ? String(patch.title).trim() : current.title,
    author: patch.author !== undefined ? String(patch.author).trim() : current.author,
    category: patch.category !== undefined ? String(patch.category).trim() : current.category,
    isbn: patch.isbn !== undefined ? String(patch.isbn).trim() : current.isbn,
    totalCopies: patch.totalCopies !== undefined ? Number(patch.totalCopies) : current.totalCopies,
    availableCopies: patch.availableCopies !== undefined ? Number(patch.availableCopies) : current.availableCopies,
    status: patch.status || current.status,`
    : singularStem === "product"
      ? `    name: patch.name !== undefined ? String(patch.name).trim() : current.name,
    sku: patch.sku !== undefined ? String(patch.sku).trim() : current.sku,
    price: patch.price !== undefined ? Number(patch.price) : current.price,
    stock: patch.stock !== undefined ? Number(patch.stock) : current.stock,
    status: patch.status || current.status,`
      : `    name: patch.name !== undefined ? String(patch.name).trim() : current.name,
    status: patch.status || current.status,`}
    updatedAt: new Date().toISOString(),
  };
}
`;
}

function buildAggregateCrudServiceScaffold(entityStem: string): string {
  const singularStem = singularizeStem(entityStem) || "item";
  const pluralStem = singularStem.endsWith("s") ? singularStem : `${singularStem}s`;
  const entityPascal = toPascalCase(singularStem) || "Item";
  const seedInput = buildEntitySeedInputCode(singularStem);
  return `import {
  ${entityPascal},
  ${entityPascal}Input,
  create${entityPascal} as create${entityPascal}Record,
  update${entityPascal}FromPatch,
} from "../models/${singularStem}";

const ${pluralStem}Store: ${entityPascal}[] = [create${entityPascal}Record(${seedInput})];

export function list${toPascalCase(pluralStem)}(): ${entityPascal}[] {
  return ${pluralStem}Store.map((item) => ({ ...item }));
}

export function get${entityPascal}ById(id: string): ${entityPascal} | null {
  return ${pluralStem}Store.find((item) => item.id === id) || null;
}

export function create${entityPascal}(input: ${entityPascal}Input): ${entityPascal} {
  const created = create${entityPascal}Record(input);
  ${pluralStem}Store.push(created);
  return created;
}

export function update${entityPascal}(id: string, patch: Partial<${entityPascal}Input>): ${entityPascal} | null {
  const index = ${pluralStem}Store.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const updated = update${entityPascal}FromPatch(${pluralStem}Store[index], patch);
  ${pluralStem}Store[index] = updated;
  return updated;
}

export function update${entityPascal}Status(id: string, status: string): ${entityPascal} | null {
  return update${entityPascal}(id, { status } as Partial<${entityPascal}Input>);
}

export function delete${entityPascal}(id: string): boolean {
  const index = ${pluralStem}Store.findIndex((item) => item.id === id);
  if (index < 0) return false;
  ${pluralStem}Store.splice(index, 1);
  return true;
}

export function borrow${entityPascal}(id: string): ${entityPascal} | null {
  return update${entityPascal}Status(id, "borrowed");
}

export function return${entityPascal}(id: string): ${entityPascal} | null {
  return update${entityPascal}Status(id, "available");
}

export function reserve${entityPascal}(id: string): ${entityPascal} | null {
  return update${entityPascal}Status(id, "reserved");
}
`;
}

/**
 * 自包含的 CRUD Service scaffold--当对应的 model 文件不在 filesToCreate 中时使用。
 * 将类型定义和工厂函数全部内联到 service 文件中,避免编译错误。
 */
function buildSelfContainedCrudServiceScaffold(entityStem: string): string {
  const singularStem = singularizeStem(entityStem) || "item";
  const pluralStem = singularStem.endsWith("s") ? singularStem : `${singularStem}s`;
  const entityPascal = toPascalCase(singularStem) || "Item";
  const seedInput = buildEntitySeedInputCode(singularStem);

  // 内联类型定义(根据 entity 特化)
  let interfaceBlock = "";
  if (singularStem === "book") {
    interfaceBlock = `export interface ${entityPascal} {
  id: string;
  title: string;
  author: string;
  category: string;
  isbn: string;
  totalCopies: number;
  availableCopies: number;
  status: "available" | "borrowed" | "reserved";
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ${entityPascal}Input {
  title: string;
  author: string;
  category?: string;
  isbn?: string;
  totalCopies?: number;
  availableCopies?: number;
  status?: "available" | "borrowed" | "reserved";
  summary?: string;
}`;
  } else if (singularStem === "product") {
    interfaceBlock = `export interface ${entityPascal} {
  id: string;
  name: string;
  sku: string;
  price: number;
  stock: number;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

export interface ${entityPascal}Input {
  name: string;
  sku: string;
  price?: number;
  stock?: number;
  status?: "active" | "inactive";
}`;
  } else {
    interfaceBlock = `export interface ${entityPascal} {
  id: string;
  name: string;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

export interface ${entityPascal}Input {
  name: string;
  status?: "active" | "inactive";
}`;
  }

  return `${interfaceBlock}

function build${entityPascal}Id(): string {
  return "${singularStem}-" + Math.random().toString(36).slice(2, 10);
}

function create${entityPascal}Record(input: ${entityPascal}Input): ${entityPascal} {
  const now = new Date().toISOString();
  return {
    id: build${entityPascal}Id(),${singularStem === "book" ? `
    title: String(input.title || "").trim(),
    author: String(input.author || "").trim(),
    category: String(input.category || "未分类").trim(),
    isbn: String(input.isbn || "").trim(),
    totalCopies: Number(input.totalCopies || 1),
    availableCopies: Number(input.availableCopies ?? input.totalCopies ?? 1),
    status: input.status || "available",
    summary: input.summary || "",` : singularStem === "product" ? `
    name: String(input.name || "").trim(),
    sku: String(input.sku || "").trim(),
    price: Number(input.price || 0),
    stock: Number(input.stock || 0),
    status: input.status || "active",` : `
    name: String(input.name || "").trim(),
    status: input.status || "active",`}
    createdAt: now,
    updatedAt: now,
  };
}

function update${entityPascal}FromPatch(
  current: ${entityPascal},
  patch: Partial<${entityPascal}Input>
): ${entityPascal} {
  return {
    ...current,${singularStem === "book" ? `
    ...(patch.title !== undefined && { title: String(patch.title).trim() }),
    ...(patch.author !== undefined && { author: String(patch.author).trim() }),
    ...(patch.status !== undefined && { status: patch.status }),` : singularStem === "product" ? `
    ...(patch.name !== undefined && { name: String(patch.name).trim() }),
    ...(patch.sku !== undefined && { sku: String(patch.sku).trim() }),
    ...(patch.price !== undefined && { price: Number(patch.price) }),
    ...(patch.stock !== undefined && { stock: Number(patch.stock) }),
    ...(patch.status !== undefined && { status: patch.status }),` : `
    ...(patch.name !== undefined && { name: String(patch.name).trim() }),
    ...(patch.status !== undefined && { status: patch.status }),`}
    updatedAt: new Date().toISOString(),
  };
}

const ${pluralStem}Store: ${entityPascal}[] = [create${entityPascal}Record(${seedInput})];

export function list${toPascalCase(pluralStem)}(): ${entityPascal}[] {
  return ${pluralStem}Store.map((item) => ({ ...item }));
}

export function get${entityPascal}ById(id: string): ${entityPascal} | null {
  return ${pluralStem}Store.find((item) => item.id === id) || null;
}

export function create${entityPascal}(input: ${entityPascal}Input): ${entityPascal} {
  const created = create${entityPascal}Record(input);
  ${pluralStem}Store.push(created);
  return created;
}

export function update${entityPascal}(id: string, patch: Partial<${entityPascal}Input>): ${entityPascal} | null {
  const index = ${pluralStem}Store.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const updated = update${entityPascal}FromPatch(${pluralStem}Store[index], patch);
  ${pluralStem}Store[index] = updated;
  return updated;
}

export function delete${entityPascal}(id: string): boolean {
  const index = ${pluralStem}Store.findIndex((item) => item.id === id);
  if (index < 0) return false;
  ${pluralStem}Store.splice(index, 1);
  return true;
}
`;
}

function buildEntityControllerScaffold(entityStem: string): string {
  const singularStem = singularizeStem(entityStem) || "item";
  const pluralStem = singularStem.endsWith("s") ? singularStem : `${singularStem}s`;
  const entityPascal = toPascalCase(singularStem) || "Item";
  const pluralPascal = toPascalCase(pluralStem) || "Items";
  return `import { Request, Response } from "express";
import {
  list${pluralPascal} as list${pluralPascal}Records,
  get${entityPascal}ById,
  create${entityPascal} as create${entityPascal}Record,
  update${entityPascal} as update${entityPascal}Record,
  update${entityPascal}Status as update${entityPascal}StatusRecord,
  delete${entityPascal} as delete${entityPascal}Record,
  borrow${entityPascal} as borrow${entityPascal}Record,
  return${entityPascal} as return${entityPascal}Record,
  reserve${entityPascal} as reserve${entityPascal}Record,
} from "../services/${singularStem}Service";

export async function list${pluralPascal}(_req: Request, res: Response): Promise<void> {
  const items = list${pluralPascal}Records();
  res.status(200).json({ success: true, items, total: items.length });
}

export async function get${entityPascal}(req: Request, res: Response): Promise<void> {
  const resourceId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const item = get${entityPascal}ById(resourceId);
  if (!item) {
    res.status(404).json({ success: false, message: "${entityPascal} 不存在" });
    return;
  }
  res.status(200).json({ success: true, item });
}

export async function create${entityPascal}(req: Request, res: Response): Promise<void> {
  const created = create${entityPascal}Record(req.body || {});
  res.status(201).json({ success: true, item: created });
}

export async function update${entityPascal}(req: Request, res: Response): Promise<void> {
  const resourceId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const updated = update${entityPascal}Record(resourceId, req.body || {});
  if (!updated) {
    res.status(404).json({ success: false, message: "${entityPascal} 不存在" });
    return;
  }
  res.status(200).json({ success: true, item: updated });
}

export async function update${entityPascal}Status(req: Request, res: Response): Promise<void> {
  const resourceId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const updated = update${entityPascal}StatusRecord(resourceId, String(req.body?.status || "active"));
  if (!updated) {
    res.status(404).json({ success: false, message: "${entityPascal} 不存在" });
    return;
  }
  res.status(200).json({ success: true, item: updated });
}

export async function delete${entityPascal}(req: Request, res: Response): Promise<void> {
  const resourceId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const deleted = delete${entityPascal}Record(resourceId);
  if (!deleted) {
    res.status(404).json({ success: false, message: "${entityPascal} 不存在" });
    return;
  }
  res.status(204).send();
}

export async function borrow${entityPascal}(req: Request, res: Response): Promise<void> {
  const resourceId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const updated = borrow${entityPascal}Record(resourceId);
  if (!updated) {
    res.status(404).json({ success: false, message: "${entityPascal} 不存在" });
    return;
  }
  res.status(200).json({ success: true, item: updated });
}

export async function return${entityPascal}(req: Request, res: Response): Promise<void> {
  const resourceId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const updated = return${entityPascal}Record(resourceId);
  if (!updated) {
    res.status(404).json({ success: false, message: "${entityPascal} 不存在" });
    return;
  }
  res.status(200).json({ success: true, item: updated });
}

export async function reserve${entityPascal}(req: Request, res: Response): Promise<void> {
  const resourceId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const updated = reserve${entityPascal}Record(resourceId);
  if (!updated) {
    res.status(404).json({ success: false, message: "${entityPascal} 不存在" });
    return;
  }
  res.status(200).json({ success: true, item: updated });
}
`;
}

function buildAuthControllerScaffold(): string {
  return `import { Request, Response } from "express";
import { createAuthServiceState, createUser, login as loginWithPassword } from "../services/authService";

const authState = createAuthServiceState();

export async function register(req: Request, res: Response): Promise<void> {
  try {
    const user = createUser(authState, {
      username: String(req.body?.username || ""),
      password: String(req.body?.password || ""),
      roles: Array.isArray(req.body?.roles) ? req.body.roles : ["member"],
    });
    res.status(201).json({ success: true, user });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error instanceof Error ? error.message : "注册失败",
    });
  }
}

export async function login(req: Request, res: Response): Promise<void> {
  try {
    const result = loginWithPassword(authState, {
      username: String(req.body?.username || ""),
      password: String(req.body?.password || ""),
    });
    res.status(200).json({
      success: true,
      token: result.session.token,
      user: result.user,
    });
  } catch (error) {
    res.status(401).json({
      success: false,
      message: error instanceof Error ? error.message : "登录失败",
    });
  }
}
`;
}

/**
 * 通过 ScaffoldProvider 注册表生成非 Express/TS 的 scaffold。
 * 返回 null 表示无匹配 provider。
 */
function tryExternalScaffoldProvider(
  state: JimClawState,
  fileTarget: string
): string | null {
  const language = String(state.spec?.language || "").toLowerCase();
  const framework = String(state.spec?.framework || "").toLowerCase();
  const normalizedTarget = fileTarget.replace(/\\/g, "/");
  const port = state.manifest?.services?.[0]?.port || state.consensusCore?.port || 10000;
  const declaredFiles = new Set(
    (state.spec?.filesToCreate || []).map((f: string) => String(f).replace(/\\/g, "/"))
  );

  const ctx: import("../scaffolds/types").ScaffoldContext = {
    port,
    projectName: String(state.contract?.title || "jimclaw-app")
      .normalize("NFKD")
      .replace(/[^\x00-\x7F]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "jimclaw-app",
    description: state.contract?.title || state.consensusCore?.projectTitle || "",
    language,
    framework,
    declaredFiles,
    hasAuth:
      Boolean(state.requirementProtocol?.capabilities?.authRequired) ||
      declaredFiles.has("app/routers/auth.py") ||
      declaredFiles.has("src/middleware/auth.ts"),
    hasHealthRoute: declaredFiles.has("app/routers/health.py") || declaredFiles.has("src/routes/health.ts"),
    hasFrontendPage: false,
    hasLogger: false,
    loggerModulePath: null,
    hasErrorHandler: false,
    errorHandlerModulePath: null,
    routeFiles: Array.from(declaredFiles).filter(
      (f) => /routes\//.test(f) && !/health/i.test(f)
    ).sort(),
    apiContract: state.apiContract,
    contract: state.contract,
    spec: state.spec,
    manifest: state.manifest,
    consensusCore: state.consensusCore,
    requirementProtocol: state.requirementProtocol,
  };

  // 延迟加载 scaffold 注册表(避免循环依赖)
  try {
    const { findScaffoldProvider, getScaffoldProviderById } = require("../scaffolds") as typeof import("../scaffolds");
    // 前端文件：使用前端 scaffold provider
    if (normalizedTarget.startsWith("frontend/")) {
      // 根据架构师决定的前端框架选择 scaffold，不能使用后端 framework。
      const feFramework = String((state.spec as any)?.frontend?.framework || state.spec?.framework || "").toLowerCase();
      const feProviderId = feFramework.includes("react") ? "react-typescript" : "vue-typescript";
      const feProvider = getScaffoldProviderById(feProviderId);
      if (feProvider && feProvider.canHandle(ctx, normalizedTarget)) {
        return feProvider.generate(ctx, normalizedTarget);
      }
      // fallback: try the other frontend provider
      const fallbackId = feProviderId === "react-typescript" ? "vue-typescript" : "react-typescript";
      const fallbackProvider = getScaffoldProviderById(fallbackId);
      if (fallbackProvider && fallbackProvider.canHandle(ctx, normalizedTarget)) {
        return fallbackProvider.generate(ctx, normalizedTarget);
      }
      return null;
    }
    const provider = findScaffoldProvider(language, framework);
    if (!provider) return null;
    if (!provider.canHandle(ctx, normalizedTarget)) return null;
    return provider.generate(ctx, normalizedTarget);
  } catch (e: any) {
    console.warn(`${logPrefix("System")} [Scaffold] 外部 provider 查找失败: ${e.message}`);
    return null;
  }
}

export function getDeterministicTemplateScaffold(
  state: JimClawState,
  fileTarget: string
): string | null {
  const normalizedTarget = fileTarget.replace(/\\/g, "/");
  if (normalizedTarget.startsWith("frontend/")) {
    return tryExternalScaffoldProvider(state, normalizedTarget);
  }

  // ── 确定性 requirements.txt(裸包名,无版本约束) ──
  const _reqFile = normalizedTarget.toLowerCase();
  if (_reqFile === "requirements.txt" && (state.spec as any)?._pinnedRequirements) {
    return (state.spec as any)._pinnedRequirements;
  }

  // ── 多语言 Scaffold 分发 ──
  // 非 Express/TS 模板:尝试通过 ScaffoldProvider 注册表生成
  if (state.templateId !== "express-typescript") {
    const providerResult = tryExternalScaffoldProvider(state, fileTarget);
    if (providerResult !== null) return providerResult;
    return null;
  }

  const port = state.manifest?.services?.[0]?.port || state.consensusCore?.port || 10000;
  const declaredFiles = new Set((state.spec?.filesToCreate || []).map((file) => String(file).replace(/\\/g, "/")));
  const codeMap = parseStateCodeMap(state);
  const loggerModulePath = declaredFiles.has("src/logging/logger.ts")
    ? "./logging/logger"
    : declaredFiles.has("src/middleware/logger.ts")
    ? "./middleware/logger"
    : declaredFiles.has("src/logger.ts")
      ? "./logger"
      : null;
  const hasLogger = Boolean(loggerModulePath);
  const errorHandlerModulePath = declaredFiles.has("src/utils/errorHandler.ts")
    ? "./utils/errorHandler"
    : declaredFiles.has("src/errorHandler.ts")
      ? "./errorHandler"
      : null;
  const hasErrorHandler = Boolean(errorHandlerModulePath);
  const hasHealthRoute = declaredFiles.has("src/routes/health.ts");
  const hasFrontendPage = declaredFiles.has("public/index.html");
  const routeFiles = Array.from(declaredFiles)
    .filter((file) => /^src\/routes\/.+\.(ts|js)$/i.test(file) && !/routes\/health\./i.test(file))
    .sort();
  const toIdentifier = (value: string) => {
    const base = path.posix.basename(value, path.posix.extname(value));
    return base
      .replace(/[^a-zA-Z0-9]+(.)/g, (_, ch) => String(ch || "").toUpperCase())
      .replace(/^[A-Z]/, (ch) => ch.toLowerCase());
  };
  const normalizePackageName = (rawName: string) => {
    const ascii = rawName
      .normalize("NFKD")
      .replace(/[^\x00-\x7F]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-");
    return ascii || "jimclaw-app";
  };
  const projectName = normalizePackageName(state.contract?.title?.trim() || "jimclaw-app");
  const description = state.contract?.title || state.consensusCore?.projectTitle || "Express TypeScript service";
  const runtimeDeps = { ...(state.spec?.dependencies || {}) };
  const devDeps = { ...(state.spec?.devDependencies || {}) };

  if (normalizedTarget === ".env.example") {
    return `PORT=${port}
NODE_ENV=development
JWT_SECRET=change-me-in-production
`;
  }

  if (normalizedTarget === ".dockerignore") {
    return `node_modules
dist
coverage
workspace
audit
.git
.DS_Store
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
`;
  }

  if (normalizedTarget === "package.json") {
    const language = String(state.spec?.language || "").toLowerCase();
    const framework = String(state.spec?.framework || "").toLowerCase();
    const hasAuthSurface =
      Boolean(state.requirementProtocol?.capabilities?.authRequired) ||
      declaredFiles.has("src/middleware/auth.ts") ||
      declaredFiles.has("src/controllers/authController.ts") ||
      declaredFiles.has("src/routes/auth.ts") ||
      declaredFiles.has("tests/auth.test.ts");
    const isExpressRuntime =
      /express/.test(framework) ||
      declaredFiles.has("src/index.ts") ||
      declaredFiles.has("src/index.js");
    const isTypeScriptRuntime = /typescript/.test(language);
    const nextRuntimeDeps = { ...runtimeDeps };
    const nextDevDeps = { ...devDeps };

    if (isExpressRuntime) {
      nextRuntimeDeps.express = nextRuntimeDeps.express || "^4.18.2";
      nextRuntimeDeps.cors = nextRuntimeDeps.cors || "^2.8.5";
    }
    if (hasAuthSurface) {
      nextRuntimeDeps.jsonwebtoken = nextRuntimeDeps.jsonwebtoken || "^9.0.2";
    }
    if (isTypeScriptRuntime) {
      nextDevDeps.typescript = nextDevDeps.typescript || "^5.3.3";
      nextDevDeps["ts-node"] = nextDevDeps["ts-node"] || "^10.9.2";
      nextDevDeps["@types/node"] = nextDevDeps["@types/node"] || "^20.10.0";
      nextDevDeps["@types/express"] = nextDevDeps["@types/express"] || "^4.17.21";
      if (nextRuntimeDeps.jsonwebtoken) {
        nextDevDeps["@types/jsonwebtoken"] = nextDevDeps["@types/jsonwebtoken"] || "^9.0.10";
      }
    }
    const packageJson = {
      name: projectName,
      version: "1.0.0",
      description,
      main: "dist/src/index.js",
      scripts: {
        dev: "ts-node src/index.ts",
        build: "tsc",
        start: "node dist/src/index.js",
        test: "jest",
      },
      dependencies: nextRuntimeDeps,
      devDependencies: {
        ...nextDevDeps,
        "@types/cors": nextDevDeps["@types/cors"] || "^2.8.17",
        supertest: nextDevDeps.supertest || "^7.1.1",
        "@types/supertest": nextDevDeps["@types/supertest"] || "^6.0.3",
      },
    };
    return `${JSON.stringify(packageJson, null, 2)}\n`;
  }

  if (normalizedTarget === "tsconfig.json") {
    const tsconfig = {
      compilerOptions: {
        target: "ES2020",
        module: "commonjs",
        lib: ["ES2020"],
        moduleResolution: "node",
        outDir: "./dist",
        rootDir: ".",
        strict: false,
        noImplicitAny: false,
        esModuleInterop: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        types: ["node", "jest"],
      },
      include: ["src/**/*", "tests/**/*"],
      exclude: ["node_modules", "dist"],
    };
    return `${JSON.stringify(tsconfig, null, 2)}\n`;
  }

  if (normalizedTarget === "jest.config.cjs") {
    const jestRoots = getExpectedJestRoots(state.spec).map((root) => `"<rootDir>/${root}"`);
    return `module.exports = {
  testEnvironment: "node",
  roots: [${jestRoots.join(", ")}],
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\\\\.ts$": ["ts-jest", { diagnostics: false }],
  },
  moduleFileExtensions: ["ts", "js", "json"],
};
`;
  }

  if (normalizedTarget === "tests/setup.test.ts") {
    return `describe("测试基线", () => {
  it("Jest + ts-jest 基线可运行", () => {
    expect(true).toBe(true);
  });
});
`;
  }

  const modelMatch = normalizedTarget.match(/^src\/models\/([^/]+)\.(ts|js)$/i);
  if (modelMatch) {
    return buildEntityModelScaffold(modelMatch[1]);
  }

  if (normalizedTarget === "src/errors.ts") {
    return buildErrorModuleScaffold();
  }

  if (/^src\/services\/authSessionService\.(ts|js)$/i.test(normalizedTarget)) {
    return buildAuthSessionServiceScaffold();
  }

  if (/^src\/services\/authCredentialService\.(ts|js)$/i.test(normalizedTarget)) {
    return buildAuthCredentialServiceScaffold();
  }

  if (/^src\/services\/authAccountPolicyService\.(ts|js)$/i.test(normalizedTarget)) {
    return buildAuthAccountPolicyServiceScaffold();
  }

  if (/^src\/services\/authService\.(ts|js)$/i.test(normalizedTarget)) {
    const authLoggerImportPath = declaredFiles.has("src/logging/logger.ts")
      ? "../logging/logger"
      : declaredFiles.has("src/logger.ts")
        ? "../logger"
        : "../middleware/logger";
    return buildAuthServiceScaffold(authLoggerImportPath);
  }

  const aggregateServiceMatch = normalizedTarget.match(/^src\/services\/(.+?)Service\.(ts|js)$/i);
  if (aggregateServiceMatch && !/^auth/i.test(aggregateServiceMatch[1]) && !/(Query|Mutation|Inventory)$/i.test(aggregateServiceMatch[1])) {
    const entityStem = aggregateServiceMatch[1];
    const singularStem = singularizeStem(entityStem) || "item";
    const modelPath = `src/models/${singularStem}.ts`;
    const modelExists = declaredFiles.has(modelPath);
    if (modelExists) {
      return buildAggregateCrudServiceScaffold(entityStem);
    } else {
      // model 文件不在 filesToCreate 中--生成自包含的 service(内联类型定义)
      return buildSelfContainedCrudServiceScaffold(entityStem);
    }
  }

  const splitServiceMatch = normalizedTarget.match(/^src\/services\/(.+?)(Query|Mutation|Inventory)Service\.(ts|js)$/i);
  if (splitServiceMatch) {
    const entityStem = toCamelCase(splitServiceMatch[1]) || "item";
    const serviceKind = splitServiceMatch[2].toLowerCase();
    if (serviceKind === "query") {
      return buildQueryServiceScaffold(entityStem);
    }
    if (serviceKind === "mutation") {
      return buildMutationServiceScaffold(entityStem);
    }
    if (serviceKind === "inventory") {
      return buildInventoryServiceScaffold(entityStem);
    }
  }

  if (normalizedTarget === "src/errorHandler.ts" || normalizedTarget === "src/utils/errorHandler.ts") {
    return `import { NextFunction, Request, Response } from "express";

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error("[ErrorHandler]", err.message);
// ═══════════════════════════════════════════════════════════════════════
// §7  Express 中间件 (errorHandler / authMiddleware / logger)
// ═══════════════════════════════════════════════════════════════════════
  res.status(500).json({
    success: false,
    error: "Internal Server Error",
    message: err.message,
  });
}
`;
  }

  if (
    normalizedTarget === "src/logger.ts" ||
    normalizedTarget === "src/middleware/logger.ts" ||
    normalizedTarget === "src/logging/logger.ts"
  ) {
    return `import { NextFunction, Request, Response } from "express";

export interface LogEntry {
  timestamp: string;
  method: string;
  path: string;
  statusCode: number;
  responseTime: number;
  userAgent?: string;
  ip?: string;
  userId?: string;
}

export const logEntries: LogEntry[] = [];

export function loggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();
  const requestTime = new Date().toISOString();
  const userId = (req as Request & { user?: { id: string } }).user?.id;

  res.on("finish", () => {
    const responseTime = Date.now() - startedAt;
    const path = req.originalUrl || req.baseUrl + req.path || req.path;
    const logEntry: LogEntry = {
      timestamp: requestTime,
      method: req.method,
      path,
      statusCode: res.statusCode,
      responseTime,
      userAgent: req.get("user-agent"),
      ip: req.ip || req.socket.remoteAddress,
      userId,
    };

    logEntries.push(logEntry);
    console.log(
      \`[\${logEntry.timestamp}] \${logEntry.method} \${logEntry.path} - \${logEntry.statusCode} (\${logEntry.responseTime}ms)\`
    );
  });

  next();
}

export function getLogs(): LogEntry[] {
  return [...logEntries];
}

export function clearLogs(): void {
  logEntries.length = 0;
}

export const requestLogger = loggerMiddleware;

export default loggerMiddleware;
`;
  }

  if (normalizedTarget === "src/routes/health.ts") {
    const hasAuthMiddleware = declaredFiles.has("src/middleware/auth.ts");
    const hasLoggerMiddleware = declaredFiles.has("src/middleware/logger.ts");
    return `import { Router, Request, Response } from "express";
${hasAuthMiddleware ? 'import { authMiddleware } from "../middleware/auth";\n' : ""}${hasLoggerMiddleware ? 'import { loggerMiddleware } from "../middleware/logger";\n' : ""}

const healthRouter = Router();

${hasLoggerMiddleware ? "healthRouter.use(loggerMiddleware);\n\n" : ""}healthRouter.get("/", ${hasAuthMiddleware ? "authMiddleware, " : ""}(_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: "1.0.0",
  });
});

healthRouter.get("/ping", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "pong",
    timestamp: new Date().toISOString(),
  });
});

export default healthRouter;
`;
  }

  if (/^src\/middleware\/auth[^/]*\.(ts|js)$/.test(normalizedTarget)) {
    return `import { Request, RequestHandler } from "express";
import jwt from "jsonwebtoken";

export interface AuthUser {
  userId: string;
  username: string;
  role?: string;
}

export type AuthRequest = Request & {
  user?: AuthUser;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

interface JwtPayload {
  userId: string;
  username: string;
  role?: string;
  iat?: number;
  exp?: number;
}

export const authMiddleware: RequestHandler = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ success: false, message: "未提供认证令牌,访问被拒绝" });
      return;
    }

    const [scheme, token] = authHeader.split(" ");
    if (scheme !== "Bearer" || !token) {
      res.status(401).json({ success: false, message: "认证令牌格式错误,应为 Bearer <token>" });
      return;
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || "default-secret-key") as JwtPayload;
    req.user = {
      userId: decoded.userId,
      username: decoded.username,
      role: decoded.role,
    };
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError || error instanceof jwt.NotBeforeError) {
      res.status(401).json({ success: false, message: "认证令牌无效或已过期" });
      return;
    }
    console.error("认证中间件错误:", error);
    res.status(500).json({ success: false, message: "服务器内部错误" });
  }
};

export const optionalAuthMiddleware: RequestHandler = (req, _res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      next();
      return;
    }
    const [scheme, token] = authHeader.split(" ");
    if (scheme !== "Bearer" || !token) {
      next();
      return;
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "default-secret-key") as JwtPayload;
    req.user = {
      userId: decoded.userId,
      username: decoded.username,
      role: decoded.role,
    };
  } catch (error) {
    console.warn("可选认证失败:", error);
  }
  next();
};

export function requireRole(...allowedRoles: string[]): RequestHandler {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ success: false, message: "未认证的用户" });
      return;
    }
    if (!req.user.role || !allowedRoles.includes(req.user.role)) {
      res.status(403).json({ success: false, message: "权限不足,无法访问此资源" });
      return;
    }
    next();
  };
}
`;
  }

  if (/^src\/controllers\/authController\.(ts|js)$/i.test(normalizedTarget)) {
    return buildAuthControllerScaffold();
  }

  const controllerMatch = normalizedTarget.match(/^src\/controllers\/(.+?)Controller\.(ts|js)$/i);
  if (controllerMatch && !/^auth$/i.test(controllerMatch[1])) {
    return buildEntityControllerScaffold(controllerMatch[1]);
  }

  if (/^src\/routes\/auth\.(ts|js)$/i.test(normalizedTarget)) {
    const ownedEndpoints = inferOwnedEndpoints(normalizedTarget, state.apiContract);
    const hasAuthMiddleware = declaredFiles.has("src/middleware/auth.ts");
    const needsLogin = ownedEndpoints.some((endpoint) => /POST\s+\/api\/auth\/login$/i.test(endpoint));
    const needsRegister = ownedEndpoints.some((endpoint) => /POST\s+\/api\/auth\/register$/i.test(endpoint));
    const needsProfile = ownedEndpoints.some((endpoint) => /GET\s+\/api\/auth\/me$/i.test(endpoint));
    const controllerImports = [
      needsLogin ? "login" : "",
      needsRegister ? "register" : "",
    ].filter(Boolean);
    return `import { Router${needsProfile ? ", Request, Response" : ""} } from "express";
${controllerImports.length > 0 ? `import { ${controllerImports.join(", ")} } from "../controllers/authController";\n` : ""}${hasAuthMiddleware && needsProfile ? 'import { authMiddleware } from "../middleware/auth";\n' : ""}

const router = Router();

${needsLogin ? 'router.post("/login", login);\n' : ""}${needsRegister ? 'router.post("/register", register);\n' : ""}${hasAuthMiddleware && needsProfile ? `router.get("/me", authMiddleware, (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    user: req.user || null,
  });
});
` : ""}

export default router;
`;
  }

  const crudRouteMatch = normalizedTarget.match(/^src\/routes\/([^/]+)\.(ts|js)$/);
  if (crudRouteMatch && !/health$/i.test(crudRouteMatch[1])) {
    const ownedEndpoints = inferOwnedEndpoints(normalizedTarget, state.apiContract);
    const methodSet = new Set(ownedEndpoints.map((item) => item.split(/\s+/, 1)[0]));
    const resourceStem = crudRouteMatch[1].replace(/routes?$/i, "").replace(/route$/i, "");
    const singularStem = singularizeStem(resourceStem);
    const resourcePath = deriveRouteMountPath(ownedEndpoints, `/api/${resourceStem}`);
    const hasCrudShape =
      ownedEndpoints.length > 0 &&
      methodSet.has("GET") &&
      methodSet.has("POST") &&
      (methodSet.has("PUT") || methodSet.has("PATCH")) &&
      methodSet.has("DELETE");

    if (hasCrudShape) {
      const controllerPath = `src/controllers/${singularStem}Controller`;
      const controllerSource =
        codeMap[`${controllerPath}.ts`] ||
        codeMap[`${controllerPath}.js`] ||
        "";
      const authImportPath = declaredFiles.has("src/middleware/auth.ts")
        ? "../middleware/auth"
        : declaredFiles.has("src/middleware/authMiddleware.ts")
          ? "../middleware/authMiddleware"
          : declaredFiles.has("src/middleware/authMiddleware.js")
            ? "../middleware/authMiddleware"
            : null;
      return buildCrudRouteScaffold({
        controllerImportPath: `../controllers/${singularStem}Controller`,
        controllerSource,
        authImportPath,
        ownedEndpoints,
        singularStem,
        pluralStem: resourceStem.endsWith("s") ? resourceStem : `${resourceStem}s`,
        resourcePath,
      });
    }
  }

  if (normalizedTarget === "src/index.ts") {
    const routeImports = routeFiles
      .map((file) => {
        const identifier = `${toIdentifier(file)}Router`;
        const importPath = "./" + file.replace(/^src\//, "").replace(/\.(ts|js)$/i, "");
        const routeBase = path.posix.basename(file, path.posix.extname(file))
          .replace(/routes?$/i, "")
          .replace(/route$/i, "");
        const ownedEndpoints = inferOwnedEndpoints(file, state.apiContract);
        const fallbackMountPath = routeBase === "user" ? "/api/auth" : `/api/${routeBase}`;
        return {
          identifier,
          statement: `import ${identifier} from "${importPath}";`,
          mountPath: deriveRouteMountPath(ownedEndpoints, fallbackMountPath),
        };
      });
    return `import express, { Express, Request, Response${hasErrorHandler ? "" : ", NextFunction"} } from "express";
import cors from "cors";
import path from "path";
${hasLogger ? `import { requestLogger } from "${loggerModulePath}";\n` : ""}${hasErrorHandler ? `import { errorHandler } from "${errorHandlerModulePath}";\n` : ""}${hasHealthRoute ? 'import healthRouter from "./routes/health";\n' : ""}${routeImports.map((item) => item.statement).join("\n")}

const app: Express = express();
const PORT = Number(process.env.PORT || ${port});

app.use(cors());
app.use(express.json());
${hasLogger ? "app.use(requestLogger);\n" : ""}
${hasFrontendPage ? 'app.use(express.static(path.join(process.cwd(), "public")));\n' : ""}

${hasHealthRoute
  ? 'app.use("/api/health", healthRouter);\n'
  : ""}
${routeImports.map((item) => `app.use("${item.mountPath}", ${item.identifier});`).join("\n")}
${hasHealthRoute
  ? ""
  : `app.get("/api/health", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: "1.0.0",
  });
});

app.get("/api/health/ping", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "pong",
    timestamp: new Date().toISOString(),
  });
});
`}
${hasFrontendPage ? `app.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});
` : ""}

${hasErrorHandler
  ? "app.use(errorHandler);\n"
  : `app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({
    success: false,
    error: "Internal Server Error",
    message: err.message,
  });
});
`}

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(\`Health service listening on \${PORT}\`);
  });
}

export default app;
`;
  }

  if (normalizedTarget === "public/index.html") {
    const primaryResource = getPrimaryCrudResource(state);
    const resourceCapabilities = getResourceEndpointCapabilities(state.apiContract, primaryResource.resourcePath);
    if (!resourceCapabilities.supportsCreate && !resourceCapabilities.supportsUpdate && !resourceCapabilities.supportsDelete) {
      return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${primaryResource.title}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Segoe UI", "PingFang SC", sans-serif; background: #f4f7fb; color: #1f2937; }
      .shell { max-width: 960px; margin: 0 auto; padding: 32px 20px 48px; }
      .hero { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 24px; }
      .hero h1 { margin: 0; font-size: 32px; }
      .hero p { margin: 8px 0 0; color: #4b5563; }
      .panel { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); }
      .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
      button { border: none; border-radius: 8px; padding: 10px 14px; cursor: pointer; background: #e5e7eb; color: #111827; font-weight: 600; }
      .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
      .card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; background: #fff; }
      .card h3 { margin: 0 0 8px; font-size: 18px; }
      .card p { margin: 4px 0; color: #4b5563; font-size: 14px; }
      .status { font-size: 14px; color: #2563eb; min-height: 20px; }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="hero">
        <div>
          <h1>${primaryResource.title}</h1>
          <p>前后端一体页面,直接调用后端 API 展示${primaryResource.label}列表。</p>
        </div>
        <div class="status" id="status">正在初始化...</div>
      </div>
      <section class="panel">
        <div class="toolbar">
          <strong>${primaryResource.label}列表</strong>
          <button type="button" id="refresh-btn">刷新</button>
        </div>
        <div class="cards" id="record-list"></div>
      </section>
    </div>
    <script>
      const state = { records: [] };
      const els = {
        status: document.getElementById("status"),
        list: document.getElementById("record-list"),
        refresh: document.getElementById("refresh-btn"),
      };

      function setStatus(message, isError = false) {
        els.status.textContent = message;
        els.status.style.color = isError ? "#dc2626" : "#2563eb";
      }

      function renderRecords() {
        if (!state.records.length) {
          els.list.innerHTML = "<div class='card'><p>暂无${primaryResource.label}数据。</p></div>";
          return;
        }
        els.list.innerHTML = state.records.map((record) => {
          const title = record.title || record.name || record.label || record.id || "未命名${primaryResource.label}";
          const description = record.description || record.author || record.category || "";
          return \`<article class="card">
            <h3>\${title}</h3>
            <p>\${description || "-"}</p>
          </article>\`;
        }).join("");
      }

      async function requestJson(url) {
        const response = await fetch(url, { headers: { "Content-Type": "application/json" } });
        const text = await response.text();
        const data = text ? JSON.parse(text) : {};
        if (!response.ok) {
          throw new Error(data.message || data.error || \`请求失败: \${response.status}\`);
        }
        return data;
      }

      async function loadRecords() {
        try {
          setStatus("正在加载${primaryResource.label}列表...");
          const data = await requestJson("${primaryResource.resourcePath}");
          state.records = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
          renderRecords();
          setStatus(\`已加载 \${state.records.length} 条${primaryResource.label}数据\`);
        } catch (error) {
          setStatus(error.message, true);
        }
      }

      els.refresh.addEventListener("click", loadRecords);
      loadRecords();
    </script>
  </body>
</html>
`;
    }
    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${primaryResource.title}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Segoe UI", "PingFang SC", sans-serif; background: #f4f7fb; color: #1f2937; }
      .shell { max-width: 1100px; margin: 0 auto; padding: 32px 20px 48px; }
      .hero { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 24px; }
      .hero h1 { margin: 0; font-size: 32px; }
      .hero p { margin: 8px 0 0; color: #4b5563; }
      .panel { background: #fff; border-radius: 16px; padding: 20px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); margin-bottom: 20px; }
      .grid { display: grid; grid-template-columns: 340px 1fr; gap: 20px; }
      form { display: grid; gap: 12px; }
      input { width: 100%; padding: 12px 14px; border: 1px solid #d1d5db; border-radius: 10px; }
      button { border: none; border-radius: 10px; padding: 12px 16px; cursor: pointer; font-weight: 600; }
      .primary { background: #2563eb; color: #fff; }
      .muted { background: #e5e7eb; color: #111827; }
      .danger { background: #dc2626; color: #fff; }
      .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
      .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
      .card { border: 1px solid #e5e7eb; border-radius: 14px; padding: 16px; background: #fff; }
      .card h3 { margin: 0 0 8px; font-size: 18px; }
      .card p { margin: 4px 0; color: #4b5563; font-size: 14px; }
      .actions { display: flex; gap: 8px; margin-top: 12px; }
      .status { font-size: 14px; color: #2563eb; min-height: 20px; }
      @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="hero">
        <div>
          <h1>${primaryResource.title}</h1>
          <p>前后端一体页面,直接调用后端 API 完成${primaryResource.label}列表、添加、编辑、删除。</p>
        </div>
        <div class="status" id="status">正在初始化...</div>
      </div>
      <div class="grid">
        <section class="panel">
          <div class="toolbar">
            <strong id="form-title">新增${primaryResource.label}</strong>
            <button class="muted" type="button" id="reset-btn">重置</button>
          </div>
          <form id="book-form">
            <input id="title" placeholder="${primaryResource.label}名称" required />
            <input id="author" placeholder="负责人 / 品牌 / 作者" required />
            <input id="publishedDate" type="date" required />
            <input id="genre" placeholder="分类" />
            <button class="primary" type="submit">保存${primaryResource.label}</button>
          </form>
        </section>
        <section class="panel">
          <div class="toolbar">
            <strong>${primaryResource.label}列表</strong>
            <button class="muted" type="button" id="refresh-btn">刷新</button>
          </div>
          <div class="cards" id="book-list"></div>
        </section>
      </div>
    </div>
    <script>
      const state = { editingId: null, records: [] };
      const els = {
        status: document.getElementById("status"),
        form: document.getElementById("book-form"),
        title: document.getElementById("title"),
        author: document.getElementById("author"),
        publishedDate: document.getElementById("publishedDate"),
        genre: document.getElementById("genre"),
        list: document.getElementById("book-list"),
        formTitle: document.getElementById("form-title"),
        reset: document.getElementById("reset-btn"),
        refresh: document.getElementById("refresh-btn"),
      };

      function setStatus(message, isError = false) {
        els.status.textContent = message;
        els.status.style.color = isError ? "#dc2626" : "#2563eb";
      }

      function resetForm() {
        state.editingId = null;
        els.form.reset();
        els.formTitle.textContent = "新增${primaryResource.label}";
      }

      function fillForm(record) {
        state.editingId = record._id || record.id;
        els.title.value = record.title || "";
        els.author.value = record.author || "";
        els.publishedDate.value = (record.publishedDate || "").slice(0, 10);
        els.genre.value = record.genre || "";
        els.formTitle.textContent = "编辑${primaryResource.label}";
      }

      function renderRecords() {
        if (!state.records.length) {
          els.list.innerHTML = "<div class='card'><p>暂无${primaryResource.label},请先添加。</p></div>";
          return;
        }
        els.list.innerHTML = state.records.map((record) => {
          const id = record._id || record.id;
          return \`<article class="card">
            <h3>\${record.title || "未命名${primaryResource.label}"}</h3>
            <p>负责人:\${record.author || "-"}</p>
            <p>日期:\${(record.publishedDate || "").slice(0, 10) || "-"}</p>
            <p>分类:\${record.genre || "-"}</p>
            <div class="actions">
              <button class="muted" type="button" onclick="window.editRecord('\${id}')">编辑</button>
              <button class="danger" type="button" onclick="window.removeRecord('\${id}')">删除</button>
            </div>
          </article>\`;
        }).join("");
      }

      async function requestJson(url, options = {}) {
        const response = await fetch(url, {
          headers: { "Content-Type": "application/json" },
          ...options,
        });
        const text = await response.text();
        const data = text ? JSON.parse(text) : {};
        if (!response.ok) {
          throw new Error(data.message || data.error || \`请求失败: \${response.status}\`);
        }
        return data;
      }

      async function loadRecords() {
        try {
          setStatus("正在加载${primaryResource.label}列表...");
          const data = await requestJson("${primaryResource.resourcePath}");
          state.records = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
          renderRecords();
          setStatus(\`已加载 \${state.records.length} 条${primaryResource.label}数据\`);
        } catch (error) {
          setStatus(error.message, true);
        }
      }

      async function saveRecord(event) {
        event.preventDefault();
        const payload = {
          title: els.title.value.trim(),
          author: els.author.value.trim(),
          publishedDate: els.publishedDate.value,
          genre: els.genre.value.trim(),
        };
        try {
          const id = state.editingId;
          const method = id ? "PUT" : "POST";
          const url = id ? \`${primaryResource.resourcePath}/\${id}\` : "${primaryResource.resourcePath}";
          await requestJson(url, { method, body: JSON.stringify(payload) });
          setStatus(id ? "${primaryResource.label}更新成功" : "${primaryResource.label}创建成功");
          resetForm();
          await loadRecords();
        } catch (error) {
          setStatus(error.message, true);
        }
      }

      window.editRecord = function editRecord(id) {
        const found = state.records.find((record) => (record._id || record.id) === id);
        if (found) fillForm(found);
      };

      window.removeRecord = async function removeRecord(id) {
        try {
          await requestJson(\`${primaryResource.resourcePath}/\${id}\`, { method: "DELETE" });
          setStatus("${primaryResource.label}删除成功");
          await loadRecords();
        } catch (error) {
          setStatus(error.message, true);
        }
      };

      els.form.addEventListener("submit", saveRecord);
      els.reset.addEventListener("click", resetForm);
      els.refresh.addEventListener("click", loadRecords);
      loadRecords();
    </script>
  </body>
</html>
`;
  }

  if (normalizedTarget === "tests/health.test.ts") {
    // 只有在 logger 模块存在时才导入和使用
    const loggerImportPath = declaredFiles.has("src/logging/logger.ts")
      ? "../src/logging/logger"
      : declaredFiles.has("src/logger.ts")
        ? "../src/logger"
        : null;
    const loggerImport = loggerImportPath
      ? `import { clearLogs, getLogs } from "${loggerImportPath}";\n`
      : "";
    const beforeEachBlock = loggerImportPath
      ? `  beforeEach(() => { clearLogs(); });\n`
      : "";
    return `import request from "supertest";
import app from "../src/index";
${loggerImport}
describe("Health API", () => {
${beforeEachBlock}
  it("GET /api/health 返回 200", async () => {
    const response = await request(app).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("status", "ok");
  });
});
`;
  }

  if (normalizedTarget === "tests/auth.test.ts") {
    return `import request from "supertest";
import app from "../src/index";

describe("Auth API 基线", () => {
  it("POST /api/auth/login 缺少凭据时返回受控状态", async () => {
    const response = await request(app).post("/api/auth/login").send({});

    expect(response.status).toBeLessThan(500);
    expect([200, 201, 400, 401]).toContain(response.status);
  });

  it("GET /api/auth/me 未登录时返回受控状态", async () => {
    const response = await request(app).get("/api/auth/me");

    expect([200, 401, 403]).toContain(response.status);
  });
});
`;
  }

  if (normalizedTarget === "scripts/verify.ts") {
    return buildVerifyScriptScaffold(state);
  }

  const crudTestMatch = normalizedTarget.match(/^tests\/([^/]+)\.test\.(ts|js)$/);
  if (crudTestMatch && !/^(health|user)$/i.test(crudTestMatch[1])) {
    const resourceStem = crudTestMatch[1];
    const ownedEndpoints = inferOwnedEndpoints(`src/routes/${resourceStem}.ts`, state.apiContract);
    const hasBoundedCrudApp =
      declaredFiles.has("src/index.ts") &&
      ownedEndpoints.some((endpoint) => /^(GET|POST|PUT|PATCH|DELETE)\s+/i.test(endpoint));
    if (hasBoundedCrudApp) {
      return buildCrudApiTestScaffold(state, resourceStem, declaredFiles);
    }
    const singularStem = singularizeStem(resourceStem);
    const singularPascal = toPascalCase(singularStem);
    const pluralPascal = toPascalCase(resourceStem.endsWith("s") ? resourceStem : `${resourceStem}s`);
    const controllerPath = `src/controllers/${singularStem}Controller.ts`;
    const modelPath = `src/models/${singularStem}Model.ts`;
    if (declaredFiles.has(controllerPath) && declaredFiles.has(modelPath)) {
      return `import { Request, Response } from "express";
import Model, { I${singularPascal} } from "../src/models/${singularStem}Model";
import { AuthRequest } from "../src/middleware/authMiddleware";
import { get${pluralPascal}, add${singularPascal}, edit${singularPascal}, delete${singularPascal} } from "../src/controllers/${singularStem}Controller";

jest.mock("../src/models/${singularStem}Model", () => ({
  __esModule: true,
  default: {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    findByIdAndDelete: jest.fn(),
  },
}));

function createResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res) as any;
  res.json = jest.fn().mockReturnValue(res) as any;
  return res;
}

describe("${singularPascal} Controller", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("get${pluralPascal} 返回列表", async () => {
    const res = createResponse();
    const sort = jest.fn().mockResolvedValue([{ _id: "1", name: "demo" }]);
    (Model.find as jest.Mock).mockReturnValue({ sort });

    await get${pluralPascal}({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("add${singularPascal} 缺少字段时返回 400", async () => {
    const res = createResponse();
    await add${singularPascal}({ body: {} } as AuthRequest, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("edit${singularPascal} 成功更新资源", async () => {
    const res = createResponse();
    const req = { params: { id: "item-1" }, body: { title: "更新值", name: "更新值" } } as AuthRequest;
    (Model.findByIdAndUpdate as jest.Mock).mockResolvedValue({ _id: "item-1" } as Partial<I${singularPascal}>);

    await edit${singularPascal}(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("delete${singularPascal} 在资源不存在时返回 404", async () => {
    const res = createResponse();
    (Model.findByIdAndDelete as jest.Mock).mockResolvedValue(null);

    await delete${singularPascal}({ params: { id: "missing" } } as AuthRequest, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
`;
    }
  }

  if (normalizedTarget === "tests/userController.test.ts") {
    return `import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import User from "../src/models/user";
import { UserController } from "../src/controllers/userController";

jest.mock("../src/models/user", () => {
  const MockUser = jest.fn();
  Object.assign(MockUser, {
    findOne: jest.fn(),
  });
  return { __esModule: true, default: MockUser };
});

jest.mock("jsonwebtoken", () => ({
  sign: jest.fn(() => "token-123"),
}));

jest.mock("../src/utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

function createResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res) as any;
  res.json = jest.fn().mockReturnValue(res) as any;
  return res;
}

describe("UserController", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("register returns 400 when username or password is missing", async () => {
    const req = { body: { username: "" } } as Request;
    const res = createResponse();

    await UserController.register(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("login returns token when credentials are valid", async () => {
    const req = { body: { username: "alice", password: "secret123" } } as Request;
    const res = createResponse();
    const mockedUser = User as unknown as { findOne: jest.Mock };

    mockedUser.findOne.mockResolvedValue({
      _id: "user-1",
      username: "alice",
      password: "secret123",
      role: "user",
    });

    await UserController.login(req, res);

    expect(mockedUser.findOne).toHaveBeenCalledWith({ username: "alice" });
    expect(jwt.sign).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalled();
  });
});
`;
  }

  if (normalizedTarget === "Dockerfile") {
    return `# 构建阶段
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# 运行阶段
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE ${port}

CMD ["npm", "start"]
`;
  }

  if (normalizedTarget === "docker-compose.yml") {
    return `version: "3.8"

services:
  health-check-service:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: health-check-service
    ports:
      - "${port}:${port}"
    environment:
      NODE_ENV: production
      PORT: ${port}
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:${port}/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    restart: unless-stopped
`;
  }

  return null;
}

/**
 * 分析测试失败的原因分类
 */
export function analyzeTestProblem(testOutput: string, retryCount: number, hasMediation: boolean): ProblemAnalysis {
  const hasPassStats = /pass(?:ed)?[:\s]+([1-9]\d*)/i.test(testOutput);
  const hasZeroFail = /fail(?:ures|ed)?[:\s]+0\b/i.test(testOutput);
  const hasRealFailure =
    /command failed with exit code\s+[1-9]/i.test(testOutput) ||
    testOutput.includes('✖') ||
    /^not ok\s+/m.test(testOutput);
// ═══════════════════════════════════════════════════════════════════════
// §8  测试分析 (analyzeTestProblem / stabilizeSpec / Jest 配置)
// ═══════════════════════════════════════════════════════════════════════

  if (hasPassStats && hasZeroFail && !hasRealFailure) {
    return {
      type: 'judgment_problem',
      confidence: 0.9,
      reason: "统计显示测试通过但没有明确失败信号",
      suggestedAction: 'QA 使用 LLM 重新分析测试结果'
    };
  }

  if (/EADDRINUSE|EACCES|ENOENT.*node_modules|cannot find module\s+['"]([^'"./][^'"]*)['"]|spawn \w+ ENOENT/i.test(testOutput)) {
    return {
      type: 'environment_problem',
      confidence: 0.85,
      reason: '检测到环境相关的错误(端口占用、依赖缺失等)',
      suggestedAction: '检查并修复环境问题'
    };
  }

  const isCrossFileError = /not exported|is not a function|undefined is not|cannot read property.*of undefined/i.test(testOutput);
  if ((retryCount >= 1 && isCrossFileError && !hasMediation) || (retryCount >= 2 && !hasMediation)) {
    return {
      type: 'architecture_problem',
      confidence: 0.8,
      reason: isCrossFileError ? '检测到明显的跨文件接口不匹配' : `经过 ${retryCount} 次重试仍未解决,怀疑存在架构冲突`,
      suggestedAction: '触发架构师仲裁'
    };
  }

  return {
    type: 'code_problem',
    confidence: 0.6,
    reason: '检测到明确的测试失败',
    suggestedAction: '返回 failedFiles,让 coder 修复代码'
  };
}

/**
 * 尝试自动修复环境问题
 */
export async function tryFixEnvironmentProblem(testOutput: string, state: JimClawState, workspacePath: string): Promise<{ fixed: boolean; action?: string; reason?: string }> {
  const runInstallCmd = async (cmd: string, timeout: number = 120000) => {
    if (state.containerId) {
      await execInContainer(state.containerId, cmd, { timeout });
    } else {
      await host.exec(`cd ${workspacePath} && ${cmd}`, { timeout });
    }
  };

  // npm ETARGET: 常见于无效版本(例如 @types/mongoose@^7.0.0)
  if (/No matching version found for @types\/mongoose@|ETARGET/i.test(testOutput)) {
    try {
      await runInstallCmd("npm pkg delete devDependencies.@types/mongoose", 60000);
      await runInstallCmd("npm install --silent", 180000);
      return { fixed: true, action: "已移除无效依赖 @types/mongoose 并重新安装依赖" };
    } catch (e: any) {
      return { fixed: false, reason: `自动修复 ETARGET 失败: ${e.message || e}` };
    }
  }

  if (/EADDRINUSE/.test(testOutput)) {
    const portMatch = testOutput.match(/port\s+(\d+)/i) || testOutput.match(/:(\d+)\)/);
    if (portMatch) {
      const port = portMatch[1];
      await host.killPortProcess(parseInt(port, 10));
      return { fixed: true, action: `已释放端口 ${port}` };
    }
  }
  if (/cannot find module\s+['"]([^'"./][^'"]*)['"]|Cannot find module/.test(testOutput)) {
    const moduleMatch = testOutput.match(/cannot find module\s+['"]([^'"./][^'"]*)['"]|Cannot find module\s+'([^']+)'/i);
    const moduleName = moduleMatch?.[1] || moduleMatch?.[2];
    if (moduleName) {
      try {
        const installCmd = `npm install ${moduleName} --save --silent`;
        await runInstallCmd(installCmd, 60000);
        return { fixed: true, action: `已安装缺失模块 ${moduleName}` };
      } catch (e: any) {
        const errorText = String(e?.message || e || "");
        if (/No matching version found for @types\/mongoose@|ETARGET/i.test(errorText)) {
          try {
            await runInstallCmd("npm pkg delete devDependencies.@types/mongoose", 60000);
            await runInstallCmd("npm install --silent", 180000);
            return { fixed: true, action: `安装 ${moduleName} 时发现 @types/mongoose 版本无效,已自动修复并重装依赖` };
          } catch (fixErr: any) {
            return { fixed: false, reason: `修复缺失模块失败: ${fixErr.message || fixErr}` };
          }
        }
        return { fixed: false, reason: `安装缺失模块失败: ${errorText}` };
      }
    }
  }
  return { fixed: false, reason: "无法自动修复" };
}

/**
 * 将原始错误输出归一化为"失败指纹",用于识别自旋
 */
export function buildFailureFingerprint(testOutput: string): string {
  const lines = (testOutput || "")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => /error|fail|exception|cannot find|ts\d+|etarget|eaddrinuse|enoent|not found/i.test(l))
    .slice(0, 12)
    .map(l => l.replace(/\d+/g, "#").replace(/\s+/g, " ").toLowerCase());

  const fingerprint = lines.join("|");
  return fingerprint.slice(0, 500);
}

/**
 * 团队共识转换辅助函数
 */
export function consensusToStringArray(consensus: ConsensusEntry[]): string[] {
  if (!consensus || consensus.length === 0) return [];
  return consensus.map(entry => {
    const prefix = `[${entry.type}]`;
    const agent = entry.agent ? `[${entry.agent}] ` : '';
    const file = entry.relatedFile ? `(${entry.relatedFile})` : '';
    return `${prefix} ${agent}${entry.content}${file}`;
  });
}

export function createConsensus(
  type: ConsensusType,
  content: string,
  agent?: string,
  relatedFile?: string
): ConsensusEntry {
  return {
    type,
    content,
    agent,
    timestamp: Date.now(),
    relatedFile
  };
}

/**
 * 格式化共识为 LLM 可读文本
 */
export function formatConsensusForLLM(consensus: ConsensusEntry[]): string {
  if (!consensus || consensus.length === 0) return '';
  const sections: string[] = [];
  const types: ConsensusType[] = ['requirement', 'technical', 'problem', 'solution', 'decision', 'discussion'];

  for (const type of types) {
    const entries = consensus.filter(e => e.type === type);
    if (entries.length > 0) {
      sections.push(`## ${type.toUpperCase()}`);
      entries.forEach(e => {
        const agent = e.agent ? `[${e.agent}] ` : '';
        sections.push(`- ${agent}${e.content}${e.relatedFile ? ` (${e.relatedFile})` : ''}`);
      });
    }
  }
  return sections.join('\n');
}

/**
 * 语言特定的依赖规则
 */
export function getDependencyRules(language: string, serverFile?: string, filesContent?: Record<string, string>): string {
  const lang = language.toLowerCase();
  if (lang.includes("javascript") || lang.includes("typescript")) {
    const needsCors = serverFile && filesContent?.[serverFile]?.includes("cors");
    const needsExpress = lang.includes("javascript") || lang.includes("typescript");

    return `\n\n[package.json 依赖分类规则 - 严格执行]
• 【dependencies】运行时必需的包:express, cors, sqlite3, pg, mongoose, axios 等
• 【devDependencies】仅开发时需要的工具:typescript, ts-node, jest, eslint, prettier 等${needsCors ? `\n• 【本项目特别要求】cors 必须放在 dependencies 中` : ""}${needsExpress ? `\n• 【本项目特别要求】express 必须放在 dependencies 中` : ""}`;
  }

  if (lang.includes("python")) {
    return `\n\n[requirements.txt 依赖规则]
• 【运行时依赖】fastapi, uvicorn, sqlalchemy, requests, pydantic 等
• 【开发依赖】pytest, mypy, black 等`;
  }
  return "";
}

function isInfraOwnedArtifactFile(file: string): boolean {
  const normalized = String(file || "").replace(/\\/g, "/").trim().toLowerCase();
  if (!normalized) return false;

  // 冗余/无价值文件--LLM 经常生成但不对测试/运行产生贡献
  if (
    normalized === "scripts/verify.ts" ||
    normalized === "scripts/verify.js" ||
    normalized === "scripts/verify.ps1" ||
    normalized === "scripts/verify.sh" ||
    normalized === ".env.example" ||
    normalized === "readme.md"
  ) {
    return true;
  }

  if (
    normalized === "package-lock.json" ||
    normalized === "npm-shrinkwrap.json" ||
    normalized === "pnpm-lock.yaml" ||
    normalized === "yarn.lock" ||
    normalized === "bun.lockb" ||
    normalized === "cargo.lock" ||
    normalized === "gradle.lockfile"
  ) {
    return true;
  }

  if (
    /(?:^|\/)(?:node_modules|dist|build|coverage|\.next|\.turbo|out|target|\.gradle)(?:\/|$)/.test(normalized) ||
    /\.tsbuildinfo$/i.test(normalized)
  ) {
    return true;
  }

  return false;
}

function getFallbackTaskPriority(file: string): number {
  const normalized = String(file || "").replace(/\\/g, "/").toLowerCase();
  if (!normalized) return 999;
  if (/^(package\.json|pom\.xml|cargo\.toml)$/.test(normalized)) return 0;
  if (/^(tsconfig\.json|jest\.config\.[^.]+|vitest\.config\.[^.]+|eslint\.config\.[^.]+|\.env(?:\..+)?|prisma\/schema\.prisma)$/.test(normalized)) return 5;
  if (/^src\/models\//.test(normalized)) return 10;
  if (/^src\/repositories\//.test(normalized)) return 20;
  if (/^src\/services\//.test(normalized)) return 30;
  if (/^src\/controllers\//.test(normalized)) return 40;
  if (/^src\/middlewares?\//.test(normalized)) return 50;
  if (/^src\/routes\//.test(normalized)) return 60;
  if (/^src\/(app|index|main)\./.test(normalized) || normalized === "src/main.rs") return 70;
  if (/^public\/.+|\.html$|\.css$|\.jsx?$|\.tsx?$/.test(normalized)) return 80;
  if (/^tests?\//.test(normalized) || /\.test\.[^.]+$/.test(normalized) || /\.spec\.[^.]+$/.test(normalized)) return 90;
  if (/^scripts\//.test(normalized)) return 100;
  if (/^(dockerfile|docker-compose\.ya?ml|\.dockerignore)$/.test(normalized)) return 110;
  if (/^readme\.md$|^docs\//.test(normalized)) return 120;
  return 95;
}

function getFallbackStem(file: string): string {
  return getExecutionDependencyStem(file);
}

function stripExecutionCapabilitySuffix(stem: string): string {
  const normalized = String(stem || "").toLowerCase();
  const suffixes = [
    "accountpolicy",
    "credential",
    "session",
    "inventory",
    "mutation",
    "query",
    "status",
  ];
  for (const suffix of suffixes) {
    if (normalized.endsWith(suffix) && normalized.length > suffix.length) {
      return normalized.slice(0, -suffix.length);
    }
  }
  return normalized;
}

export function getExecutionDependencyStem(file: string): string {
  const normalized = String(file || "").replace(/\\/g, "/");
  const base = path.posix.basename(normalized, path.posix.extname(normalized)).toLowerCase();
  return singularizeStem(
    stripExecutionCapabilitySuffix(
      base
      .replace(/controller$/, "")
      .replace(/service$/, "")
      .replace(/repository$/, "")
      .replace(/routes?$/, "")
      .replace(/middleware$/, "")
      .replace(/validator$/, "")
      .replace(/model$/, "")
      .replace(/test$/, "")
      .replace(/spec$/, "")
    )
  );
}

export function isAggregateExecutionServiceFile(file: string): boolean {
  const normalized = String(file || "").replace(/\\/g, "/").toLowerCase();
  if (!/^src\/services\//i.test(normalized)) return false;
  const base = path.posix.basename(normalized, path.posix.extname(normalized)).toLowerCase();
  if (!base.endsWith("service")) return false;
  const rawStem = base.replace(/service$/, "");
  return stripExecutionCapabilitySuffix(rawStem) === rawStem;
}

function isCrossCuttingExecutionFile(file: string): boolean {
  const stem = getExecutionDependencyStem(file);
  return ["auth", "permission", "rbac", "logger", "logging", "error", "audit"].includes(stem);
}

function getFallbackCandidatesByPattern(files: string[], currentFile: string, patterns: RegExp[]): string[] {
  const normalizedCurrent = String(currentFile || "").replace(/\\/g, "/").toLowerCase();
  return files.filter((file) => {
    const normalized = String(file || "").replace(/\\/g, "/").toLowerCase();
    return normalized !== normalizedCurrent && patterns.some((pattern) => pattern.test(normalized));
  });
}

function pickPreferredFallbackServiceDependency(files: string[], currentFile: string, stem: string): string[] {
  const normalizedStem = String(stem || "").toLowerCase();
  const candidates = getFallbackCandidatesByPattern(files, currentFile, [/^src\/services\//i]);
  if (!normalizedStem) return candidates.length > 0 ? [candidates[0]] : [];
  const sameStem = candidates.filter((file) => getExecutionDependencyStem(file) === normalizedStem);
  if (sameStem.length === 0) return [];
  const aggregate = sameStem.find((file) => isAggregateExecutionServiceFile(file));
  return [aggregate || sameStem[0]];
}

function pickPreferredFallbackControllerDependency(files: string[], currentFile: string, stem: string): string[] {
  const normalizedStem = String(stem || "").toLowerCase();
  const candidates = getFallbackCandidatesByPattern(files, currentFile, [/^src\/controllers\//i]);
  if (!normalizedStem) return candidates.length > 0 ? [candidates[0]] : [];
  const sameStem = candidates.filter((file) => getExecutionDependencyStem(file) === normalizedStem);
  return sameStem.length > 0 ? [sameStem[0]] : [];
}

function pickPreferredFallbackMiddlewareDependencies(files: string[], currentFile: string, stem: string): string[] {
  const normalizedStem = String(stem || "").toLowerCase();
  const candidates = getFallbackCandidatesByPattern(files, currentFile, [/^src\/middlewares?\//i]);
  const sameStem = normalizedStem
    ? candidates.filter((file) => getExecutionDependencyStem(file) === normalizedStem)
    : [];
  const crossCutting = candidates.filter((file) => isCrossCuttingExecutionFile(file));
  return Array.from(new Set([...sameStem, ...crossCutting]));
}

function pickSplitFallbackServiceDependencies(files: string[], currentFile: string, stem: string): string[] {
  const normalizedStem = String(stem || "").toLowerCase();
  if (!normalizedStem || !isAggregateExecutionServiceFile(currentFile)) return [];
  return getFallbackCandidatesByPattern(files, currentFile, [/^src\/services\//i])
    .filter((file) => getExecutionDependencyStem(file) === normalizedStem)
    .filter((file) => !isAggregateExecutionServiceFile(file));
}

function pickFallbackDependencyByPattern(
  files: string[],
  currentFile: string,
  patterns: RegExp[],
  stem?: string,
  strictStem = false
): string[] {
  const normalizedCurrent = String(currentFile || "").replace(/\\/g, "/").toLowerCase();
  const normalizedStem = String(stem || "").toLowerCase();
  const candidates = files.filter((file) => {
    const normalized = String(file || "").replace(/\\/g, "/").toLowerCase();
    return normalized !== normalizedCurrent && patterns.some((pattern) => pattern.test(normalized));
  });

  if (candidates.length === 0) return [];
  if (!normalizedStem) return [candidates[0]];

  const preferred = candidates.find((file) => getFallbackStem(file) === normalizedStem);
  if (preferred) return [preferred];
  return strictStem ? [] : [candidates[0]];
}

function inferFallbackDependencies(file: string, files: string[], runtime: ProjectRuntime): string[] {
  const normalized = String(file || "").replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  const stem = getFallbackStem(normalized);
  const deps = new Set<string>();
  const add = (items: string[]) => items.filter(Boolean).forEach((item) => deps.add(item));
  const hasPackageJson = files.includes("package.json");

  if (/^(package\.json|pom\.xml|cargo\.toml|readme\.md|\.env(?:\..+)?)$/i.test(normalized)) {
    return [];
  }

  if (/^(tsconfig\.json|jest\.config\.[^.]+|vitest\.config\.[^.]+|eslint\.config\.[^.]+)$/i.test(normalized)) {
    return hasPackageJson ? ["package.json"] : [];
  }

  if (/^dockerfile$/i.test(normalized)) {
    return hasPackageJson ? ["package.json"] : [];
  }

  if (/^docker-compose\.ya?ml$/i.test(normalized)) {
    if (files.includes("Dockerfile")) return ["Dockerfile"];
    return hasPackageJson ? ["package.json"] : [];
  }

  if (/^\.dockerignore$/i.test(normalized)) {
    return [];
  }

  if (/^prisma\/schema\.prisma$/i.test(normalized)) {
    return hasPackageJson ? ["package.json"] : [];
  }

  if (/^prisma\/.+/i.test(normalized)) {
    return files.includes("prisma/schema.prisma") ? ["prisma/schema.prisma"] : hasPackageJson ? ["package.json"] : [];
  }

  if (/^src\/models\//i.test(normalized)) {
    return [];
  }

  if (/^src\/repositories\//i.test(normalized)) {
    add(pickFallbackDependencyByPattern(files, normalized, [/^src\/models\//i], stem));
    return Array.from(deps);
  }

  if (/^src\/services\//i.test(normalized)) {
    add(pickSplitFallbackServiceDependencies(files, normalized, stem));
    add(pickFallbackDependencyByPattern(files, normalized, [/^src\/repositories\//i], stem, true));
    add(pickFallbackDependencyByPattern(files, normalized, [/^src\/models\//i], stem, true));
    return Array.from(deps);
  }

  if (/^src\/controllers\//i.test(normalized)) {
    add(pickPreferredFallbackServiceDependency(files, normalized, stem));
    add(pickFallbackDependencyByPattern(files, normalized, [/^src\/models\//i], stem, true));
    return Array.from(deps);
  }

  if (/^src\/middlewares?\//i.test(normalized)) {
    add(pickPreferredFallbackServiceDependency(files, normalized, stem));
    add(pickFallbackDependencyByPattern(files, normalized, [/^src\/models\//i], stem, true));
    add(pickFallbackDependencyByPattern(files, normalized, [/^src\/config\//i, /^src\/utils\//i, /^src\/logging\//i]));
    return Array.from(deps);
  }

  if (/^src\/routes\//i.test(normalized)) {
    add(pickPreferredFallbackControllerDependency(files, normalized, stem));
    add(pickPreferredFallbackMiddlewareDependencies(files, normalized, stem));
    return Array.from(deps);
  }

  if (/^src\/(app|index)\./i.test(normalized) || lower === "src/main.rs" || /^src\/main\/java\//i.test(normalized)) {
    add(pickFallbackDependencyByPattern(files, normalized, [/^src\/routes\//i]));
    add(pickFallbackDependencyByPattern(files, normalized, [/^src\/middlewares?\//i]));
    if (deps.size === 0 && hasPackageJson && runtime === "node") deps.add("package.json");
    return Array.from(deps);
  }

  if (/^public\/.+|\.html$/i.test(normalized)) {
    if (files.includes("src/index.ts")) return ["src/index.ts"];
    if (files.includes("src/index.js")) return ["src/index.js"];
    return [];
  }

  if (/^tests?\//i.test(normalized) || /\.test\.[^.]+$/i.test(normalized) || /\.spec\.[^.]+$/i.test(normalized)) {
    if (/setup\.test\.[^.]+$/i.test(normalized)) {
      add(hasPackageJson ? ["package.json"] : []);
      add(pickFallbackDependencyByPattern(files, normalized, [/^jest\.config\.[^.]+$/i, /^vitest\.config\.[^.]+$/i]));
      return Array.from(deps);
    }

    add(pickFallbackDependencyByPattern(files, normalized, [/^src\/(app|index)\./i, /^src\/main\.rs$/i, /^src\/main\/java\//i]));
    add(pickFallbackDependencyByPattern(files, normalized, [/^src\/routes\//i], stem));
    return Array.from(deps);
  }

  if (/^scripts\//i.test(normalized)) {
    return hasPackageJson ? ["package.json"] : [];
  }

  if (runtime === "node" && /^src\/.+\.(ts|js|tsx|jsx)$/i.test(normalized) && hasPackageJson) {
    return ["package.json"];
  }

  return [];
}

/**
 * Fallback 子任务生成:当模型拆解失败时,基于 TechSpec 的 filesToCreate 动态生成任务链
 */
export function generateFallbackSubTasks(spec: any, apiContract: any): any[] {
  const language = spec?.language || "TypeScript";
  const runtime = detectLanguageFamily(language);
  const filesToCreate = (spec?.filesToCreate || [])
    .map((file: string) => String(file).replace(/\\/g, "/"))
    .filter((file: string) => !isInfraOwnedArtifactFile(file))
    .sort((left: string, right: string) => {
      const priorityDelta = getFallbackTaskPriority(left) - getFallbackTaskPriority(right);
      return priorityDelta !== 0 ? priorityDelta : left.localeCompare(right);
    });
  const tasks: any[] = [];

  // 1. 识别必需的基础文件(如果是 TS/JS 项目且没有在 filesToCreate 中显式包含 package.json)
  const isJS = language.toLowerCase().includes("typescript") || language.toLowerCase().includes("ts") || language.toLowerCase().includes("javascript");
  const hasPackageJson = filesToCreate.some((f: string) => f.includes("package.json"));

  if (isJS && !hasPackageJson) {
    tasks.push({
      id: "fallback_task_pkg",
      description: "生成基础 package.json 配置文件",
      fileTarget: "package.json",
      dependencies: [],
      contextRequirement: "包含必需的依赖和脚本配置"
    });
  }

  const taskFiles = tasks.map((task) => task.fileTarget).concat(filesToCreate);

  // 2. 遍历 filesToCreate 动态生成任务
  filesToCreate.forEach((file: string, index: number) => {
    // 跳过重复的 package.json
    if (file.includes("package.json") && tasks.some(t => t.fileTarget === "package.json")) return;
    const dependencies = inferFallbackDependencies(file, taskFiles, runtime);

    const contextRequirement = /^public\/|^frontend\//i.test(file)
      ? "基于 API 契约实现前端交互，只调用已声明端点；未声明写接口时保持只读，使用相对路径 fetch('/api/...') 调用后端。"
      : `根据技术规范实现 ${file} 的核心逻辑`;
    tasks.push({
      id: `fallback_task_${index}`,
      description: `实现文件: ${file}`,
      fileTarget: file,
      dependencies,
      contextRequirement
    });
  });

  // 3. 兜底逻辑:如果没有任何文件定义,至少生成一个入口
  if (tasks.length === 0) {
    const isPython = language.toLowerCase().includes("python");
    const serverFile = isPython ? "main.py" : `server.${isJS ? (language.toLowerCase().includes("ts") ? "ts" : "js") : "js"}`;
    tasks.push({
      id: "fallback_task_entry",
      description: `实现入口文件 ${serverFile}`,
      fileTarget: serverFile,
      dependencies: [],
      contextRequirement: `实现 API 核心逻辑`
    });
  }

  return tasks;
}

function detectNodeTestFramework(spec: any): "vitest" | "jest" | "unknown" {
  const files = (spec?.filesToCreate || []).map((file: string) => String(file).replace(/\\/g, "/").toLowerCase());
  const testCommand = String(spec?.testCommand || "").toLowerCase();
  const dependencies = {
    ...(spec?.dependencies || {}),
    ...(spec?.devDependencies || {}),
  } as Record<string, string>;
  const depNames = Object.keys(dependencies).map((name) => name.toLowerCase());
  const hasVitestSignal =
    /vitest/.test(testCommand) ||
    files.some((file: string) => /^vitest\.config\./.test(path.posix.basename(file))) ||
    depNames.includes("vitest");
  if (hasVitestSignal) return "vitest";

  const hasJestSignal =
    /jest|ts-jest/.test(testCommand) ||
    files.some((file: string) => /^jest\.config\./.test(path.posix.basename(file))) ||
    depNames.includes("jest") ||
    depNames.includes("ts-jest") ||
    depNames.includes("@types/jest");
  if (hasJestSignal) return "jest";

  return "unknown";
}

export function ensureTypeScriptTestBaseline(spec: any): any {
  const language = String(spec?.language || "").toLowerCase();
  const testCommand = String(spec?.testCommand || "").toLowerCase();
  if (!language.includes("typescript")) return spec;
  if (detectNodeTestFramework(spec) === "vitest") return spec;
  if (!/(npm test|jest|ts-jest)/.test(testCommand)) return spec;

  const filesToCreate = new Set(
    (spec?.filesToCreate || []).map((file: string) => normalizeNodeJestTestFilePath(file))
  );
  filesToCreate.add("jest.config.cjs");
  filesToCreate.add("tests/setup.test.ts");

  const devDependencies = { ...(spec?.devDependencies || {}) } as Record<string, string>;
  if (!devDependencies.jest) devDependencies.jest = "^29.7.0";
  if (!devDependencies["ts-jest"]) devDependencies["ts-jest"] = "^29.1.1";
  if (!devDependencies["@types/jest"]) devDependencies["@types/jest"] = "^29.5.11";

  return {
    ...spec,
    filesToCreate: Array.from(filesToCreate),
    devDependencies,
  };
}

export function isNodeJestProject(spec: any): boolean {
  const language = String(spec?.language || "").toLowerCase();
  const testCommand = String(spec?.testCommand || "").toLowerCase();
  return /typescript|javascript|node/.test(language) && /(npm test|jest|ts-jest|vitest)/.test(testCommand);
}

export function normalizeNodeJestTestFilePath(fileTarget: string): string {
  const normalized = String(fileTarget || "").replace(/\\/g, "/");
  if (/^src\/tests\//i.test(normalized)) {
    return normalized.replace(/^src\/tests\//i, "tests/");
  }
  if (/^src\/__tests__\//i.test(normalized)) {
    return normalized.replace(/^src\/__tests__\//i, "tests/");
  }
  return normalized;
}

export function normalizeNodeProjectFileLayout(spec: any): any {
  if (!isNodeJestProject(spec)) return spec;

  const filesToCreate = Array.from(
    new Set((spec?.filesToCreate || []).map((file: string) => normalizeNodeJestTestFilePath(file)))
  );

  return {
    ...spec,
    filesToCreate,
  };
}

function canonicalizeExecutionFilePath(fileTarget: string, requirementProtocol: RequirementProtocol | null | undefined, spec?: any): string {
  const normalized = normalizeNodeJestTestFilePath(String(fileTarget || "").replace(/\\/g, "/"));
  const ext = path.posix.extname(normalized) || (/typescript/i.test(String(spec?.language || "")) ? ".ts" : ".js");
  const stem = ext ? normalized.slice(0, -ext.length) : normalized;
  const { singular, plural } = getPrimaryEntityStems(requirementProtocol);
  const camelSingular = toCamelCase(singular) || singular || "item";

  if (/^src\/public\//i.test(normalized)) {
    return normalized.replace(/^src\/public\//i, "public/");
  }

  if (/^src\/scripts\//i.test(normalized)) {
    return normalized.replace(/^src\/scripts\//i, "scripts/");
  }

  if (
    new RegExp(`^src/routes/${singular}(?:s)?(?:[-_]?routes?)?$`, "i").test(stem) ||
    new RegExp(`^src/routes/${plural}(?:[-_]?routes?)?$`, "i").test(stem)
  ) {
    return `src/routes/${plural}${ext}`;
  }

  if (
    new RegExp(`^src/controllers/${singular}(?:[-_]?controller)?$`, "i").test(stem) ||
    new RegExp(`^src/controllers/${camelSingular}controller$`, "i").test(stem)
  ) {
    return `src/controllers/${camelSingular}Controller${ext}`;
  }

  if (
    new RegExp(`^src/services/${singular}(?:[-_]?service)?$`, "i").test(stem) ||
    new RegExp(`^src/services/${camelSingular}service$`, "i").test(stem)
  ) {
    return `src/services/${camelSingular}Service${ext}`;
  }

  if (
    new RegExp(`^src/repositories/${singular}(?:[-_]?repository)?$`, "i").test(stem) ||
    new RegExp(`^src/repositories/${camelSingular}repository$`, "i").test(stem)
  ) {
    return `src/repositories/${camelSingular}Repository${ext}`;
  }

  if (/^src\/middleware\/authenticate$/i.test(stem) || /^src\/middleware\/require[-_]?admin$/i.test(stem)) {
    return `src/middleware/auth${ext}`;
  }

  if (/^scripts\/verify\.(ps1|sh)$/i.test(normalized)) {
    return `scripts/verify${/typescript/i.test(String(spec?.language || "")) ? ".ts" : ".js"}`;
  }

  return normalized;
}

function orderFilesByPreferredSequence(files: string[]): string[] {
  const preferredOrder = [
    "package.json",
    "tsconfig.json",
    "Dockerfile",
    "docker-compose.yml",
    ".dockerignore",
  ];
  return [...files].sort((left, right) => {
    const leftIndex = preferredOrder.indexOf(left);
    const rightIndex = preferredOrder.indexOf(right);
    if (leftIndex !== -1 || rightIndex !== -1) {
      return (leftIndex === -1 ? preferredOrder.length : leftIndex) - (rightIndex === -1 ? preferredOrder.length : rightIndex);
    }
    return left.localeCompare(right);
  });
}

function removeConflictingNodeTestFiles(spec: any): any {
  const framework = detectNodeTestFramework(spec);
  const filesToCreate = (spec?.filesToCreate || []).map((file: string) => String(file).replace(/\\/g, "/"));
  const devDependencies = { ...(spec?.devDependencies || {}) } as Record<string, string>;

  // Jest config 变体去重:只保留 .cjs(Coder 和 Verifier 都假定 .cjs 为标准)
  // 如果同时有 jest.config.cjs 和 jest.config.js/.ts/.mjs,去掉非 .cjs 变体
  const hasCjs = filesToCreate.some((file: string) => /^jest\.config\.cjs$/i.test(file));
  if (hasCjs) {
    const altConfigs = filesToCreate.filter((file: string) =>
      /^jest\.config\.(js|ts|mjs)$/i.test(file)
    );
    if (altConfigs.length > 0) {
      const filtered = filesToCreate.filter((file: string) => !/^jest\.config\.(js|ts|mjs)$/i.test(file));
      return {
        ...spec,
        filesToCreate: filtered,
        devDependencies,
      };
    }
  }

  if (framework === "vitest") {
    const filteredFiles = filesToCreate.filter((file: string) => !/^jest\.config\./i.test(file) && file !== "tests/setup.test.ts");
    delete devDependencies.jest;
    delete devDependencies["ts-jest"];
    delete devDependencies["@types/jest"];
    return {
      ...spec,
      filesToCreate: filteredFiles,
      devDependencies,
    };
  }

  if (framework === "jest") {
    const filteredFiles = filesToCreate.filter((file: string) => !/^vitest\.config\./i.test(file));
    delete devDependencies.vitest;
    return {
      ...spec,
      filesToCreate: filteredFiles,
      devDependencies,
    };
  }

  return spec;
}

function isSimpleCrudExecutionTarget(spec: any, requirementProtocol: RequirementProtocol | null | undefined): boolean {
  const language = String(spec?.language || "").toLowerCase();
  if (!/typescript|javascript|node/.test(language)) return false;
  if (!requirementProtocol?.capabilities?.backendRequired) return false;
  const entities = (requirementProtocol?.capabilities?.crudEntities || requirementProtocol?.capabilities?.entities || [])
    .filter((entity) => !["log", "permission"].includes(String(entity || "").toLowerCase()));
  return entities.length <= 2;
}

function requiresDomainQuerySplit(requirementProtocol: RequirementProtocol | null | undefined): boolean {
  const requirementText = joinedRequirementText(requirementProtocol);
  return (
    (requirementProtocol?.capabilities?.crudEntities?.length || 0) > 0 &&
    (
      /(查询|检索|搜索|筛选|过滤|排序|分页|query|search|filter|sort|page)/i.test(requirementText) ||
      (requirementProtocol?.capabilities?.uiCapabilities?.length || 0) >= 2
    )
  );
}

function requiresDomainLifecycleSplit(requirementProtocol: RequirementProtocol | null | undefined): boolean {
  const requirementText = joinedRequirementText(requirementProtocol);
  return /(库存|馆藏|借阅|归还|预约|上下架|状态|inventory|stock|borrow|return|reserve|status)/i.test(requirementText);
}

function shouldUseBoundedCrudPlan(spec: any, requirementProtocol: RequirementProtocol | null | undefined): boolean {
  if (!isSimpleCrudExecutionTarget(spec, requirementProtocol)) return false;
  // 如果 spec.filesToCreate 已经明确且较小(<=15),说明 Architect 已精简规划,不覆盖
  if ((spec?.filesToCreate?.length || 0) <= 15) return false;
  if ((spec?.filesToCreate?.length || 0) > 24) return true;
  if (requirementProtocol?.capabilities?.authRequired) return true;
  if (requiresDomainQuerySplit(requirementProtocol)) return true;
  if (requiresDomainLifecycleSplit(requirementProtocol)) return true;
  return false;
}

function pickFirstExisting(files: string[], patterns: RegExp[], fallback?: string): string | null {
  for (const pattern of patterns) {
    const match = files.find((file) => pattern.test(file));
    if (match) return match;
  }
  return fallback || null;
}

function buildBoundedCrudFilePlan(spec: any, requirementProtocol: RequirementProtocol | null | undefined): string[] {
  const normalizedFiles = (spec?.filesToCreate || []).map((file: string) => String(file).replace(/\\/g, "/"));
  const language = String(spec?.language || "").toLowerCase();
  const ext = /typescript/.test(language) ? ".ts" : ".js";
  const framework = detectNodeTestFramework(spec);
  const authScaffoldMode = spec?.authScaffoldMode === "compact" ? "compact" : "split";
  const { singular, plural } = getPrimaryEntityStems(requirementProtocol);
  const camelSingular = toCamelCase(singular) || singular || "item";
  const auditRequired = Boolean(requirementProtocol?.capabilities?.auditLogRequired || requiresStructuredLogging(requirementProtocol));
  const hasVerifyScript =
    normalizedFiles.some((file: string) => /(^|\/)verify\./i.test(path.posix.basename(file))) ||
    requiresVerifyScript(requirementProtocol);
  const boundedFiles = new Set<string>();
  const push = (value: string | null | undefined) => {
    if (value) boundedFiles.add(value);
  };

  push("package.json");
  if (/typescript/.test(language)) push("tsconfig.json");
  push(".env.example");
  push("README.md");

  if (requirementProtocol?.capabilities?.dockerRequired) {
    push("Dockerfile");
    push("docker-compose.yml");
    push(".dockerignore");
  }

  if (framework === "vitest") {
    push(pickFirstExisting(normalizedFiles, [/^vitest\.config\./i], `vitest.config${ext}`));
  } else if (framework === "jest") {
    push(pickFirstExisting(normalizedFiles, [/^jest\.config\./i], "jest.config.cjs"));
  }

  push(pickFirstExisting(normalizedFiles, [/^src\/index\./i], `src/index${ext}`));
  push(pickFirstExisting(normalizedFiles, [/^src\/config\/env\./i]));
  push(`src/routes/${plural}${ext}`);
  push(`src/controllers/${camelSingular}Controller${ext}`);
  push(`src/models/${singular}${ext}`);
  if (requiresDomainQuerySplit(requirementProtocol)) {
    push(`src/services/${camelSingular}QueryService${ext}`);
    push(`src/services/${camelSingular}MutationService${ext}`);
  }
  if (requiresDomainLifecycleSplit(requirementProtocol)) {
    push(`src/services/${camelSingular}InventoryService${ext}`);
  }
  push(`src/services/${camelSingular}Service${ext}`);

  if (requirementProtocol?.capabilities?.authRequired) {
    push(`src/middleware/auth${ext}`);
    push(`src/routes/auth${ext}`);
    push(`src/controllers/authController${ext}`);
    if (authScaffoldMode !== "compact") {
      push(`src/services/authSessionService${ext}`);
      push(`src/services/authCredentialService${ext}`);
      push(`src/services/authAccountPolicyService${ext}`);
    }
    push(`src/services/authService${ext}`);
  }

  if (requirementProtocol?.capabilities?.authRequired || auditRequired) {
    push(`src/errors${ext}`);
  }
  if (auditRequired) {
    push(`src/logging/logger${ext}`);
  }

  if (requirementProtocol?.capabilities?.frontendRequired) {
    push("public/index.html");
  }

  push(`tests/health.test${ext}`);
  push(`tests/${plural}.test${ext}`);
  if (requirementProtocol?.capabilities?.authRequired) {
    push(`tests/auth.test${ext}`);
  }

  // scripts/verify.* 不再生成--测试由 jest/pytest 覆盖,验证脚本是冗余文件
  // 100% 的 run 都包含它,增加 Coder 负担但不增加测试覆盖率

  return orderFilesByPreferredSequence(Array.from(boundedFiles));
}

export function stabilizeSpecForExecution(
  spec: any,
  requirementProtocol: RequirementProtocol | null | undefined
): any {
  const requirementDrivenSpec = ensureRequirementDrivenFiles(spec, requirementProtocol);
  const normalizedFiles = Array.from<string>(
    new Set(
      (requirementDrivenSpec?.filesToCreate || [])
        .map((file: string) => canonicalizeExecutionFilePath(file, requirementProtocol, requirementDrivenSpec))
        .filter((file: string) => !isInfraOwnedArtifactFile(file))
    )
  );
  let nextSpec = {
    ...(requirementDrivenSpec || {}),
    filesToCreate: orderFilesByPreferredSequence(normalizedFiles),
  };
  // ── 非 Node/JS/TS 项目跳过 Node 特有处理 ──
  const isNode = isNodeJestProject(nextSpec);
  if (isNode) {
    nextSpec = removeConflictingNodeTestFiles(nextSpec);
    nextSpec = ensureTypeScriptTestBaseline(nextSpec);
    nextSpec = normalizeNodeProjectFileLayout(nextSpec);

    if (shouldUseBoundedCrudPlan(nextSpec, requirementProtocol)) {
      nextSpec = {
        ...nextSpec,
        filesToCreate: buildBoundedCrudFilePlan(nextSpec, requirementProtocol),
      };
    }
  }

  // ── 最终归一化:去重、排序、过滤冗余文件 ──
  nextSpec.filesToCreate = orderFilesByPreferredSequence(
    Array.from<string>(
      new Set(
        (nextSpec.filesToCreate || []).map((file: string) => canonicalizeExecutionFilePath(file, requirementProtocol, nextSpec))
          .filter((file: string) => !isInfraOwnedArtifactFile(file))
      )
    )
  );
  // ── 非 Node 项目不再执行 Node 冲突消解 ──
  if (isNode) {
    return removeConflictingNodeTestFiles(nextSpec);
  }
  return nextSpec;
}

export function getExpectedJestRoots(spec: any): string[] {
  if (!isNodeJestProject(spec)) return [];

  const roots = new Set<string>();
  for (const rawFile of spec?.filesToCreate || []) {
    const file = normalizeNodeJestTestFilePath(rawFile);
    if (!/test|spec/i.test(path.basename(file))) continue;
    const root = file.startsWith("tests/") ? "tests" : path.posix.dirname(file) || ".";
    roots.add(root === "." ? "tests" : root);
  }

  if (roots.size === 0) roots.add("tests");
  return Array.from(roots);
}

export function getDeclaredBusinessTestFiles(spec: any): string[] {
  return (spec?.filesToCreate || [])
    .map((file: string) => normalizeNodeJestTestFilePath(file))
    .filter((file: string) => /test|spec/i.test(path.basename(file)))
    .filter((file: string) => path.posix.basename(file) !== "setup.test.ts");
}

function normalizeRouteContractPath(rawPath: string): string {
  const normalized = String(rawPath || "").trim().replace(/\\/g, "/");
  if (!normalized) return "/";
  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const compact = withLeadingSlash.replace(/\/{2,}/g, "/");
  if (compact !== "/" && compact.endsWith("/")) {
    return compact.slice(0, -1);
  }
  return compact;
}

/**
 * 从 contract 路径列表推断挂载前缀。
 * 例如 ["/api/todos", "/api/todos/:id", "/api/health"] → ["/api/todos"]
 * 逻辑：找出所有路径的最长公共资源前缀（不含参数段），
 * 但每个 "资源集合" 单独提取（如 /api/todos 和 /api/health 是不同的集合）。
 */
function inferMountPrefixes(paths: string[]): string[] {
  const prefixes = new Set<string>();
  for (const p of paths) {
    // 将路径按 / 分段，去掉参数段（:xxx），保留静态段
    const segments = p.split("/").filter(s => s.length > 0 && !s.startsWith(":"));
    if (segments.length >= 2) {
      // 取前两个静态段作为 mount prefix：/api/todos
      // 这覆盖了最常见的 /api/<resource> 模式
      prefixes.add("/" + segments.slice(0, 2).join("/"));
    }
  }
  return Array.from(prefixes);
}

function mergeMountPathWithRoutePath(mountPath: string, routePath: string): string {
  const normalizedMount = normalizeRouteContractPath(mountPath);
  const normalizedRoute = normalizeRouteContractPath(routePath);
  if (normalizedRoute === "/") return normalizedMount;
  return normalizeRouteContractPath(`${normalizedMount}/${normalizedRoute.replace(/^\/+/, "")}`);
}

export function findContractRouteDrift(
  routeContent: string,
  contract: { endpoints?: Array<{ path: string; method: string }> } | null | undefined,
  options?: { ownedEndpoints?: string[] | null },
): string[] {
  const endpoints = contract?.endpoints || [];
  if (endpoints.length === 0) return [];

  const scopedOwnedEndpoints = (options?.ownedEndpoints || []).filter(Boolean);
  const allowedEndpointEntries = scopedOwnedEndpoints.length > 0
    ? scopedOwnedEndpoints
    : endpoints.map((ep) => `${String(ep.method || "").toUpperCase()} ${String(ep.path || "").trim()}`);
  const allowed = new Set(
    allowedEndpointEntries.map((entry) => {
      const [method, ...pathParts] = String(entry || "").trim().split(/\s+/);
      return `${String(method || "").toUpperCase()} ${normalizeRouteContractPath(pathParts.join(" "))}`;
    })
  );
  const mountPath = scopedOwnedEndpoints.length > 0 ? deriveRouteMountPath(scopedOwnedEndpoints, "") : "";

  // 构建"无前缀版本"集合：将 /api/users/:id 也视为允许 /users/:id，
  // 容忍 coder 注册两种路径格式（带/不带 /api 前缀）
  // 同时生成相对路由版本（路由文件内 router.get('/:id') 写法）：
  //   GET /api/todos/:id → GET /:id, GET /todos/:id
  //   POST /api/todos → POST /, POST /todos
  const allowedStripped = new Set<string>();

  // 推断挂载基础路径：从所有 contract 路径中提取公共前缀
  // 例如 ["/api/todos", "/api/todos/:id"] → ["/api/todos"]
  const contractPaths = endpoints.map(ep => String(ep.path || "").trim());
  const mountPrefixes = inferMountPrefixes(contractPaths);

  for (const entry of allowed) {
    allowedStripped.add(entry);
    // 去掉常见前缀 /api /api/v1 等：GET /api/todos/:id → GET /todos/:id
    const stripped = entry.replace(/^(\w+) \/api(?:\/v\d+)?\b/, "$1");
    if (stripped !== entry) allowedStripped.add(stripped);
    // 去掉 mount 前缀，生成路由文件内的相对路径：
    // GET /api/todos/:id → GET /:id  (去掉 /api/todos)
    for (const prefix of mountPrefixes) {
      if (prefix && prefix !== "/") {
        const spaceIdx = entry.indexOf(" ");
        if (spaceIdx > 0) {
          const method = entry.slice(0, spaceIdx);
          const path = entry.slice(spaceIdx + 1);
          if (path.startsWith(prefix)) {
            const remainder = path.slice(prefix.length) || "/";
            const normalized = method + " " + remainder;
            if (normalized !== entry) allowedStripped.add(normalized);
          }
        }
      }
    }
  }

  const routeRegex = /router\.(get|post|put|delete|patch)\s*\(\s*["'`](.+?)["'`]/gi;
  const drifts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = routeRegex.exec(routeContent)) !== null) {
    const method = match[1].toUpperCase();
    const directPath = normalizeRouteContractPath(match[2]);
    const actual = `${method} ${directPath}`;
    const mounted = mountPath ? `${method} ${mergeMountPathWithRoutePath(mountPath, directPath)}` : actual;
    if (!allowed.has(actual) && !allowed.has(mounted) && !allowedStripped.has(actual)) {
      drifts.push(`路由 ${actual} 未在 ApiContract 中声明`);
    }
  }

  return drifts;
}

/**
 * 构建结构化三层共识上下文,供所有节点注入 system prompt
 */
export function buildSystemContext(state: JimClawState): string[] {
  const core = state.consensusCore;
  const progress = state.consensusProgress;
  const notes = state.meetingNotes || [];
  const protocol = state.executionProtocol;
  const requirementProtocol = state.requirementProtocol || protocol?.requirements || null;
  const technologyDecision = state.technologyDecision || null;
// ═══════════════════════════════════════════════════════════════════════
// §9  共识上下文 (buildSystemContext / buildCoderExecutionContext)
// ═══════════════════════════════════════════════════════════════════════
  const solutionProtocol = state.solutionProtocol || protocol?.solution || null;
  const validationReport = state.validationReport || null;
  const repairPlan = state.repairPlan || null;
  const openRepairContracts = (state.repairContracts || []).filter((contract) => contract.status !== "closed");
  const customerApprovalState = state.customerApprovalState || null;

  if (!core) {
    return consensusToStringArray(state.projectBrief);
  }

  const lines: string[] = [];

  // 第一层:核心信息
  lines.push("[项目核心]");
  lines.push(`• 项目:${core.projectTitle}`);
  if (core.requirements.length > 0) {
    lines.push(`• 需求:${core.requirements.map((r, i) => `${i + 1}. ${r}`).join("  ")}`);
  }
  if (core.architectureSummary) {
    lines.push(`• 架构:${core.architectureSummary}`);
  }
  if (core.techStack) {
    lines.push(`• 技术栈:${core.techStack},端口:${core.port}`);
  }
  if (core.framework) {
    lines.push(`• 主框架:${core.framework}`);
  }
  if (core.coreDependencies && Object.keys(core.coreDependencies).length > 0) {
    const deps = Object.entries(core.coreDependencies).map(([k, v]) => `${k}@${v}`).join(", ");
    lines.push(`• 运行时依赖:${deps}`);
  }
  if (core.coreDevDependencies && Object.keys(core.coreDevDependencies).length > 0) {
    const devDeps = Object.entries(core.coreDevDependencies).map(([k, v]) => `${k}@${v}`).join(", ");
    lines.push(`• 开发依赖:${devDeps}`);
  }
  if (core.criticalDecisions.length > 0) {
    lines.push(`• 关键决策:${core.criticalDecisions.map(d => `• ${d}`).join("  ")}`);
  }

  // 第二层:进度快照
  if (progress) {
    const total = progress.completedFiles.length + progress.pendingFiles.length;
    lines.push("");
    lines.push(`[当前进度(第 ${progress.currentRound} 轮)]`);
    lines.push(`• 已完成(${progress.completedFiles.length}/${total} 个文件):${progress.completedFiles.join(", ") || "无"}`);
    lines.push(`• 待完成:${progress.pendingFiles.join(", ") || "无"}`);
    if (progress.openIssues.length > 0) {
      lines.push(`• 未解决问题:${progress.openIssues.join("; ")}`);
    }
  }

  if (requirementProtocol) {
    lines.push("");
    lines.push("[需求协议]");
    lines.push(`• frontendRequired:${requirementProtocol.capabilities.frontendRequired ? "是" : "否"}`);
    lines.push(`• backendRequired:${requirementProtocol.capabilities.backendRequired ? "是" : "否"}`);
    lines.push(`• authRequired:${requirementProtocol.capabilities.authRequired ? "是" : "否"}`);
    lines.push(`• auditLogRequired:${requirementProtocol.capabilities.auditLogRequired ? "是" : "否"}`);
    if (requirementProtocol.capabilities.entities.length > 0) {
      lines.push(`• entities:${requirementProtocol.capabilities.entities.join(", ")}`);
    }
    if (requirementProtocol.capabilities.uiCapabilities.length > 0) {
      lines.push(`• uiCapabilities:${requirementProtocol.capabilities.uiCapabilities.join(", ")}`);
    }
  }

  if (solutionProtocol) {
    lines.push("");
    lines.push("[方案覆盖]");
    lines.push(`• frontendPlanned:${solutionProtocol.coverage.frontendPlanned ? "是" : "否"}`);
    lines.push(`• backendPlanned:${solutionProtocol.coverage.backendPlanned ? "是" : "否"}`);
    if (solutionProtocol.coverage.uncoveredRequirements.length > 0) {
      lines.push(`• 未覆盖需求:${solutionProtocol.coverage.uncoveredRequirements.join(";")}`);
    }
    if (solutionProtocol.coverage.uncoveredAcceptanceCriteria.length > 0) {
      lines.push(`• 未覆盖验收:${solutionProtocol.coverage.uncoveredAcceptanceCriteria.join(";")}`);
    }
  }

  if (technologyDecision) {
    lines.push("");
    lines.push("[技术决策]");
    lines.push(`• frontend: ${technologyDecision.frontend.required ? technologyDecision.frontend.framework : "none"}`);
    lines.push(`• backend: ${technologyDecision.backend.required ? technologyDecision.backend.framework : "none"}`);
    lines.push(`• database: ${technologyDecision.database.kind}`);
    lines.push(`• testing.unit: ${technologyDecision.testing.unit || "未定义"}`);
    lines.push(`• deploy: docker=${technologyDecision.deploy.docker ? "是" : "否"} / compose=${technologyDecision.deploy.compose ? "是" : "否"}`);
  }

  // 第三层:会议纪要摘要
  if (protocol) {
    lines.push("");
    lines.push("[执行协议]");
    lines.push(`• 版本:${protocol.version}`);
    lines.push(`• runtime:${protocol.project.runtime}`);
    lines.push(`• sourceRoots:${(protocol.project.workspaceLayout.sourceRoots || []).join(", ") || "无"}`);
    lines.push(`• testRoots:${(protocol.project.workspaceLayout.testRoots || []).join(", ") || "无"}`);
    lines.push(`• frontendRoots:${(protocol.project.workspaceLayout.frontendRoots || []).join(", ") || "无"}`);
    lines.push(`• entryFiles:${(protocol.project.workspaceLayout.entryFiles || []).join(", ") || "无"}`);
    lines.push(`• healthCheckPath:${protocol.runtime.healthCheckPath || "无"}`);
  }

  if (validationReport) {
    lines.push("");
    lines.push("[验证报告]");
    lines.push(`• status: ${validationReport.status}`);
    lines.push(`• blocking: ${validationReport.blocking ? "是" : "否"}`);
    if (validationReport.failureType) {
      lines.push(`• failureType: ${validationReport.failureType}`);
    }
    if (validationReport.findings.length > 0) {
      lines.push(`• findings: ${validationReport.findings.map((finding) => finding.summary).join("; ")}`);
    }
  }

  if (repairPlan) {
    lines.push("");
    lines.push("[修复计划]");
    lines.push(`• repairType: ${repairPlan.repairType}`);
    lines.push(`• targets: ${repairPlan.targets.join(", ") || "无"}`);
  }

  if (openRepairContracts.length > 0) {
    lines.push("");
    lines.push("[修复契约]");
    for (const contract of openRepairContracts.slice(0, 3)) {
      lines.push(`• sprintId: ${contract.sprintId}`);
      lines.push(`  failedChecks: ${contract.failedChecks.join(", ") || "无"}`);
      if (contract.reproSteps?.length) {
        lines.push(`  reproSteps: ${contract.reproSteps.join(" | ")}`);
      }
      if (contract.allowedRepairFiles?.length) {
        lines.push(`  allowedRepairFiles: ${contract.allowedRepairFiles.join(", ")}`);
      } else if (contract.repairScope.length) {
        lines.push(`  repairScope: ${contract.repairScope.join(", ")}`);
      }
      if (contract.rerunChecks?.length) {
        lines.push(`  rerunChecks: ${contract.rerunChecks.join(", ")}`);
      }
    }
  }

  if (customerApprovalState) {
    lines.push("");
    lines.push("[客户确认]");
    lines.push(`• 默认授权: requirements=${customerApprovalState.autoApprove.requirements ? "是" : "否"}, solution=${customerApprovalState.autoApprove.solution ? "是" : "否"}, deploy=${customerApprovalState.autoApprove.deploy ? "是" : "否"}`);
    const pendingStages = customerApprovalState.checkpoints
      .filter((checkpoint) => checkpoint.required && !checkpoint.approved)
      .map((checkpoint) => checkpoint.stage);
    lines.push(`• 待确认阶段: ${pendingStages.join(", ") || "无"}`);
  }

  if (notes.length > 0) {
    lines.push("");
    lines.push("[沟通纪要]");
    for (const note of notes) {
      lines.push(`• [${note.id}] ${note.summary}`);
    }
    lines.push("(需要详情?调用 read_meeting_note(note_id))");
  }

  return lines;
}

export function getActiveSprintContract(
  state: Pick<JimClawState, "activeSprintId" | "sprintContracts">
): SprintContract | null {
  const id = state.activeSprintId || "";
  const contracts = state.sprintContracts || [];
  return contracts.find((item) => item.sprintId === id && item.status === "agreed") || null;
}

export function getPassedSprintIds(
  state: Pick<JimClawState, "evaluationResults">
): Set<string> {
  return new Set(
    (state.evaluationResults || [])
      .filter((result) => result.status === "pass")
      .map((result) => result.sprintId)
  );
}

export function getNextRunnableSprintPlan(
  state: Pick<JimClawState, "activeSprintId" | "sprintPlans" | "evaluationResults">
): SprintPlan | null {
  const sprintPlans = state.sprintPlans || [];
  if (!sprintPlans.length) return null;

  const passedSprintIds = getPassedSprintIds(state);
  const activeSprint = sprintPlans.find((plan) => plan.id === state.activeSprintId);
  if (activeSprint && !passedSprintIds.has(activeSprint.id)) return activeSprint;

  return sprintPlans.find((plan) =>
    !passedSprintIds.has(plan.id) &&
    (plan.dependencies || []).every((dependency) => passedSprintIds.has(dependency))
  ) || sprintPlans.find((plan) => !passedSprintIds.has(plan.id)) || activeSprint || sprintPlans[0];
}

export function hasUnpassedSprintPlans(
  state: Pick<JimClawState, "sprintPlans" | "evaluationResults">
): boolean {
  const sprintPlans = state.sprintPlans || [];
  if (!sprintPlans.length) return false;
  const passedSprintIds = getPassedSprintIds(state);
  return sprintPlans.some((plan) => !passedSprintIds.has(plan.id));
}

export function buildSprintContractContext(state: JimClawState): string {
  const contract = getActiveSprintContract(state);
  if (!contract) return "";
  return [
    "## 当前 SprintContract（必须遵守）",
    `Sprint: ${contract.sprintId}`,
    `目标: ${contract.builderPlan.intent}`,
    `允许文件: ${contract.agreedScope.allowedFiles.join(", ")}`,
    `禁止文件: ${contract.agreedScope.forbiddenFiles.join(", ")}`,
    "Evaluator 检查:",
    ...contract.evaluatorPlan.checks.map((check) => `- ${check.id}: ${check.description}`),
  ].join("\n");
}

function normalizeSprintScopePath(value: string): string {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function isFileAllowedBySprintContract(fileTarget: string, contract: SprintContract): boolean {
  const target = normalizeSprintScopePath(fileTarget);
  const forbidden = contract.agreedScope.forbiddenFiles || [];
  if (forbidden.some((entry) => {
    const scope = normalizeSprintScopePath(entry);
    return scope.endsWith("/") ? target.startsWith(scope) : target === scope;
  })) {
    return false;
  }

  const allowed = contract.agreedScope.allowedFiles || [];
  if (allowed.length === 0) return true;
  return allowed.some((entry) => {
    const scope = normalizeSprintScopePath(entry);
    if (!scope) return false;
    return scope.endsWith("/") ? target.startsWith(scope) : target === scope;
  });
}

export function isTaskInActiveSprintScope(
  state: Pick<JimClawState, "activeSprintId" | "sprintContracts">,
  fileTarget: string
): boolean {
  const contract = getActiveSprintContract(state);
  if (!contract) return true;
  return isFileAllowedBySprintContract(fileTarget, contract);
}

export function hasPendingTasksInActiveSprintScope(
  state: Pick<JimClawState, "activeSprintId" | "sprintContracts" | "subTasks">
): boolean {
  return (state.subTasks || []).some((task) =>
    task.status !== "completed" &&
    isTaskInActiveSprintScope(state, task.fileTarget)
  );
}

export function buildCoderExecutionContext(
  state: JimClawState,
  currentTask?: { fileTarget?: string; dependencies?: string[]; contextRequirement?: string } | null
): string[] {
  const core = state.consensusCore;
  const protocol = state.executionProtocol;
  const requirementProtocol = state.requirementProtocol || protocol?.requirements || null;
  const lines: string[] = [];

  lines.push("[Coder 执行上下文]");
  if (core?.projectTitle) {
    lines.push(`• 项目:${core.projectTitle}`);
  }
  if (core?.techStack) {
    lines.push(`• 技术栈:${core.techStack}`);
  } else if (state.spec?.language || state.spec?.framework) {
    lines.push(`• 技术栈:${[state.spec?.language, state.spec?.framework].filter(Boolean).join(" + ")}`);
  }
  if (core?.framework || state.spec?.framework) {
    lines.push(`• 主框架:${core?.framework || state.spec?.framework}`);
  }
  if (core?.port || protocol?.runtime?.listenPort) {
    lines.push(`• 统一端口:${core?.port || protocol?.runtime?.listenPort}`);
  }
  lines.push(
    `• 执行阶段：${state.validationCheckpointCompleted ? "阶段验证后补齐外围文件" : "首轮核心骨架"}`
  );

  const sprintContractContext = buildSprintContractContext(state);
  if (sprintContractContext) {
    lines.push("");
    lines.push(...sprintContractContext.split("\n"));
  }

  // ── 增量修改模式标记 ──
  if (state.existingFiles && Object.keys(state.existingFiles).length > 0) {
    const existingCount = Object.keys(state.existingFiles).length;
    lines.push(`• 修改模式:增量（保留 ${existingCount} 个已有文件，只新增/修改用户要求的功能）`);
  }

  if (requirementProtocol) {
    const flags = [
      requirementProtocol.capabilities.frontendRequired ? "frontend" : "",
      requirementProtocol.capabilities.backendRequired ? "backend" : "",
      requirementProtocol.capabilities.authRequired ? "auth" : "",
      requirementProtocol.capabilities.auditLogRequired ? "audit" : "",
    ].filter(Boolean);
    if (flags.length > 0) {
      lines.push(`• 需求能力:${flags.join(", ")}`);
    }
  }

  if (protocol) {
    lines.push(`• runtime:${protocol.project.runtime}`);
    lines.push(`• entry:${(protocol.project.workspaceLayout.entryFiles || []).join(", ") || "无"}`);
    lines.push(`• testRoots:${(protocol.project.workspaceLayout.testRoots || []).join(", ") || "无"}`);
    lines.push(`• healthCheckPath:${protocol.runtime.healthCheckPath || "无"}`);
  }

  if (currentTask?.fileTarget) {
    const fileTarget = String(currentTask.fileTarget || "").replace(/\\/g, "/");
    const fileContract = protocol?.contracts?.files?.[fileTarget];
    const dependencyLabels = (currentTask.dependencies || [])
      .map((dependency) => {
        const normalizedDependency = String(dependency || "").replace(/\\/g, "/");
        const dependencyTask = (state.subTasks || []).find((task) => task.id === normalizedDependency || task.fileTarget === normalizedDependency);
        return dependencyTask?.fileTarget || (/[/\\.]/.test(normalizedDependency) ? normalizedDependency : "");
      })
      .filter(Boolean);
    lines.push("");
    lines.push("[当前任务]");
    lines.push(`• file:${fileTarget}`);
    lines.push(`• role:${fileContract?.role || "other"}`);
    if (dependencyLabels.length > 0) {
      lines.push(`• directDependencies：${dependencyLabels.join(", ")}`);
    }
    if (currentTask.contextRequirement) {
      lines.push(`• contextRequirement:${currentTask.contextRequirement}`);
    }
    if (fileContract?.ownedEndpoints?.length) {
      lines.push(`• ownedEndpoints:${fileContract.ownedEndpoints.join(", ")}`);
    }
  }

  return lines;
}

/**
 * 写入会议纪要文件并返回 MeetingNote 对象
 */
export async function writeMeetingNote(
  workspace: string,
  id: string,
  phase: string,
  round: number,
  summary: string,
  fullContent: string
// ═══════════════════════════════════════════════════════════════════════
// §10 持久化与恢复 (MeetingNote / TraceIndex / Checkpoint / Recovery)
// ═══════════════════════════════════════════════════════════════════════
): Promise<MeetingNote> {
  const nodesDir = path.join(workspace, "nodes");
  await fs.mkdir(nodesDir, { recursive: true });
  await fs.writeFile(path.join(nodesDir, `${id}.md`), fullContent, "utf-8");
  return { id, phase, round, summary, contentFile: `nodes/${id}.md` };
}

type WriteRecoveryIntent = {
  taskId: string;
  fileTarget: string;
  expectedContent: string;
  nodeName: string;
  traceId?: string;
  snapshotState: Partial<JimClawState>;
};

export async function persistWriteRecoveryIntent(workspace: string, intent: WriteRecoveryIntent): Promise<void> {
  const recoveryDir = path.join(workspace, "recovery");
  await fs.mkdir(recoveryDir, { recursive: true });
  await fs.writeFile(
    path.join(recoveryDir, `${intent.taskId}.json`),
    JSON.stringify(intent, null, 2),
    "utf-8"
  );
}

export async function clearWriteRecoveryIntent(workspace: string, taskId: string): Promise<void> {
  await fs.rm(path.join(workspace, "recovery", `${taskId}.json`), { force: true }).catch(() => undefined);
}

function trimFailureText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export async function recordNodeFailure(
  workspace: string,
  state: Pick<JimClawState, "retryCount" | "meetingNotes">,
  nodeName: string,
  error: unknown
): Promise<{ failure: ExecutionFailureInfo; meetingNotes: MeetingNote[] }> {
  const round = state.retryCount || 0;
  const noteId = `note-${nodeName}-r${round}`;
  const rawMessage = error instanceof Error ? (error.stack || error.message) : String(error);
  const firstLine = rawMessage.split(/\r?\n/).find((line) => line.trim()) || rawMessage;
  const summary = `${nodeName} 节点异常:${trimFailureText(firstLine, 60)}`;
  const fullContent = [
    `# ${nodeName} 节点异常`,
    "",
    `- 轮次:${round}`,
    `- 摘要:${summary}`,
    "",
    "## 原始错误",
    "```text",
    rawMessage || "未知错误",
    "```",
    "",
  ].join("\n");

  const note = await writeMeetingNote(workspace, noteId, nodeName, round, summary, fullContent);
  const existingNotes = state.meetingNotes || [];
  const meetingNotes = existingNotes.some((item) => item.id === note.id)
    ? existingNotes.map((item) => item.id === note.id ? note : item)
    : [...existingNotes, note];

  return {
    failure: { node: nodeName, round, summary, noteId },
    meetingNotes,
  };
}

export function buildTraceIndex(
  state: Pick<
    JimClawState,
    "retryCount" | "meetingNotes" | "codeLog" | "lastFailedNode" | "lastFailureSummary" | "protocolFailures" | "protocolPatches"
  >,
  nodeName: string,
  traceId: string,
  timestamp: string,
  checkpoints: TraceCheckpoint[] = [],
  tokenUsage?: TokenUsageSummary
): TraceIndex {
  const meetingNotes = [...(state.meetingNotes || [])].sort((a, b) => {
    if (a.round !== b.round) return a.round - b.round;
    return a.phase.localeCompare(b.phase);
  });
  const fileChanges = [...(state.codeLog || [])];
  const files = fileChanges.reduce<Record<string, TraceFileSummary>>((acc, entry) => {
    acc[entry.file] = {
      file: entry.file,
      lastRound: entry.round,
      lastStatus: entry.status,
      taskTitle: entry.taskTitle,
      lastError: entry.error,
      generationSource: entry.generationSource,
    };
    return acc;
  }, {});

  const timeline: TraceTimelineEntry[] = meetingNotes.map((note) => ({
    node: note.phase,
    round: note.round,
    summary: note.summary,
  }));

  const currentRound = state.retryCount || 0;
  const shouldAppendLastNode = timeline.length === 0 || timeline[timeline.length - 1].node !== nodeName;
  if (shouldAppendLastNode) {
    timeline.push({
      node: nodeName,
      round: currentRound,
      timestamp,
      summary: state.lastFailureSummary || undefined,
    });
  } else if (!timeline[timeline.length - 1].timestamp) {
    timeline[timeline.length - 1] = {
      ...timeline[timeline.length - 1],
      timestamp,
    };
  }

  return {
    traceId,
    lastNode: nodeName,
    retryCount: currentRound,
    timestamp,
    meetingNotes,
    fileChanges,
    files,
    timeline,
    checkpoints,
    tokenUsage: tokenUsage || {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      byAgent: {},
    },
    protocolFailures: [...(state.protocolFailures || [])],
    protocolPatches: [...(state.protocolPatches || [])],
    lastFailure: {
      node: state.lastFailedNode || undefined,
      summary: state.lastFailureSummary || undefined,
    },
  };
}

const CHECKPOINT_NODES = new Set([
  "orchestrator",
  "coder_final",
  "verifier",
  "qa",
  "deploy",
]);

export function shouldPersistCheckpoint(nodeName: string): boolean {
  return CHECKPOINT_NODES.has(nodeName);
}

export function buildCheckpointMeta(
  nodeName: string,
  round: number,
  timestamp: string
): TraceCheckpoint {
  const safeNode = nodeName.replace(/[^a-z0-9_-]/gi, "_");
  return {
    id: `${safeNode}-r${round}`,
    node: nodeName,
    round,
    timestamp,
    file: `checkpoints/${safeNode}-r${round}.json`,
  };
}

export async function loadTraceIndex(workspace: string): Promise<TraceIndex | null> {
  try {
    const raw = await fs.readFile(path.join(workspace, "trace-index.json"), "utf-8");
    return JSON.parse(raw) as TraceIndex;
  } catch {
    return null;
  }
}

export async function recoverWorkspaceFromWriteIntents(workspace: string): Promise<{ recovered: number; recoveredFiles: string[] }> {
  const recoveryDir = path.join(workspace, "recovery");
  let files: string[] = [];
  try {
    files = (await fs.readdir(recoveryDir)).filter((file) => file.endsWith(".json"));
  } catch {
    return { recovered: 0, recoveredFiles: [] };
  }

  if (files.length === 0) {
    return { recovered: 0, recoveredFiles: [] };
  }

  let boulder: any = null;
  try {
    const raw = await fs.readFile(path.join(workspace, "boulder.json"), "utf-8");
    boulder = JSON.parse(raw);
  } catch {}

  let traceIndex = await loadTraceIndex(workspace);
  let checkpoints = traceIndex?.checkpoints || [];
  let activeTraceId = boulder?.traceId || traceIndex?.traceId || `trace_recovered_${Date.now()}`;
  const recoveredFiles: string[] = [];

  for (const file of files.sort()) {
    const recoveryPath = path.join(recoveryDir, file);
    let intent: WriteRecoveryIntent | null = null;
    try {
      intent = JSON.parse(await fs.readFile(recoveryPath, "utf-8")) as WriteRecoveryIntent;
    } catch {
      continue;
    }

    const targetPath = path.join(workspace, intent.fileTarget);
    let actualContent = "";
    try {
      actualContent = await fs.readFile(targetPath, "utf-8");
    } catch {
      continue;
    }

    if (actualContent !== intent.expectedContent) {
      continue;
    }

    const timestamp = getBeijingTime();
    activeTraceId = intent.traceId || activeTraceId;
    const snapshot = {
      node: intent.nodeName,
      timestamp,
      traceId: activeTraceId,
      state: {
        ...intent.snapshotState,
        messages: [],
      },
    };

    await fs.writeFile(path.join(workspace, "boulder.json"), JSON.stringify(snapshot, null, 2), "utf-8");
    const tokenUsage = await AuditLogger.loadTokenUsageSummary(workspace);
    traceIndex = buildTraceIndex(snapshot.state as any, intent.nodeName, activeTraceId, timestamp, checkpoints, tokenUsage);
    checkpoints = traceIndex.checkpoints || checkpoints;
    await fs.writeFile(path.join(workspace, "trace-index.json"), JSON.stringify(traceIndex, null, 2), "utf-8");
    await fs.rm(recoveryPath, { force: true }).catch(() => undefined);
    boulder = snapshot;
    recoveredFiles.push(intent.fileTarget);
  }

  return {
    recovered: recoveredFiles.length,
    recoveredFiles,
  };
}

export async function loadCheckpointSnapshot(workspace: string, checkpointId: string): Promise<any> {
  const traceIndex = await loadTraceIndex(workspace);
  const checkpoint = traceIndex?.checkpoints?.find((item) => item.id === checkpointId);
  if (!checkpoint) {
    throw new Error(`未找到 checkpoint: ${checkpointId}`);
  }
  const raw = await fs.readFile(path.join(workspace, checkpoint.file), "utf-8");
  return JSON.parse(raw);
}

export async function validateWorkspaceArtifacts(workspace: string): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  let boulder: any = null;
  let traceIndex: TraceIndex | null = null;
  const noteFiles = new Map<string, string>();

  try {
    const raw = await fs.readFile(path.join(workspace, "boulder.json"), "utf-8");
    boulder = JSON.parse(raw);
  } catch {
    errors.push("缂哄皯鎴栨棤娉曡鍙?boulder.json");
  }

  traceIndex = await loadTraceIndex(workspace);
  if (!traceIndex) {
    errors.push("缂哄皯鎴栨棤娉曡鍙?trace-index.json");
  }

  if (boulder && traceIndex) {
    if (boulder.traceId !== traceIndex.traceId) {
      errors.push("boulder.json 涓?traceId 涓?trace-index.json 涓嶄竴鑷?");
    }
    if (boulder.node !== traceIndex.lastNode) {
      errors.push("boulder.json 鏈€鍚庤妭鐐逛笌 trace-index.json.lastNode 涓嶄竴鑷?");
    }
    if ((boulder.state?.retryCount || 0) !== traceIndex.retryCount) {
      errors.push("boulder.json.state.retryCount 涓?trace-index.json.retryCount 涓嶄竴鑷?");
    }
    if ((boulder.state?.lastFailedNode || "") !== (traceIndex.lastFailure?.node || "")) {
      errors.push("boulder.json.state.lastFailedNode 涓?trace-index.json.lastFailure.node 涓嶄竴鑷?");
    }
    if ((boulder.state?.lastFailureSummary || "") !== (traceIndex.lastFailure?.summary || "")) {
      errors.push("boulder.json.state.lastFailureSummary 涓?trace-index.json.lastFailure.summary 涓嶄竴鑷?");
    }
  }

  const checkpoints = traceIndex?.checkpoints || [];
  for (const checkpoint of checkpoints) {
    const checkpointPath = path.join(workspace, checkpoint.file);
    try {
      const raw = await fs.readFile(checkpointPath, "utf-8");
      const snapshot = JSON.parse(raw);
      if (traceIndex && snapshot.traceId !== traceIndex.traceId) {
        errors.push(`checkpoint ${checkpoint.id} 鐨?traceId 涓?trace-index.json 涓嶄竴鑷?`);
      }
      if (snapshot.node !== checkpoint.node) {
        errors.push(`checkpoint ${checkpoint.id} 鐨?node 涓庣储寮曞厓鏁版嵁涓嶄竴鑷?`);
      }
      if ((snapshot.state?.retryCount || 0) !== checkpoint.round) {
        errors.push(`checkpoint ${checkpoint.id} 鐨?retryCount 涓庣储寮曞厓鏁版嵁 round 涓嶄竴鑷?`);
      }
    } catch {
      errors.push(`checkpoint 鏂囦欢缂哄け鎴栨棤娉曡鍙? ${checkpoint.file}`);
    }
  }

  const meetingNotes = traceIndex?.meetingNotes || [];
  for (const note of meetingNotes) {
    if (!note?.contentFile) {
      errors.push(`meetingNote ${note?.id || "unknown"} 缺少 contentFile`);
      continue;
    }
    const notePath = path.join(workspace, note.contentFile);
    try {
      const content = await fs.readFile(notePath, "utf-8");
      noteFiles.set(note.id, content);
    } catch {
      errors.push(`meetingNote 文件缺失或无法读取: ${note.contentFile}`);
    }
  }

  const lastFailureNode = traceIndex?.lastFailure?.node || boulder?.state?.lastFailedNode || "";
  const lastFailureSummary = traceIndex?.lastFailure?.summary || boulder?.state?.lastFailureSummary || "";
  if (lastFailureNode) {
    const matchingFailureNote = [...(traceIndex?.meetingNotes || [])]
      .reverse()
      .find((note) => note.phase === lastFailureNode || note.id.startsWith(`note-${lastFailureNode}-`));

    if (!matchingFailureNote) {
      errors.push(`lastFailure.node=${lastFailureNode} 但缺少对应 meetingNote`);
    } else {
      const noteContent = noteFiles.get(matchingFailureNote.id) || "";
      if (lastFailureSummary && noteContent && !noteContent.includes(lastFailureSummary)) {
        errors.push(`lastFailure.summary 未出现在对应纪要 ${matchingFailureNote.id} 中`);
      }
    }

    const auditMap: Record<string, { file: string; patterns: RegExp[] }> = {
      infra_setup: { file: "Infrastructure.md", patterns: [/基础设施|infra/i, /失败|成功|容器|端口/i] },
      terminal: { file: "Terminal.md", patterns: [/Test Output|Skipped|测试/i] },
      verifier: { file: "Terminal.md", patterns: [/\[Verifier 预检失败\]|预检/i] },
      qa: { file: "清扬.md", patterns: [/QA|缺陷工单|阻塞/i] },
      deploy: { file: "Infrastructure.md", patterns: [/Deployment/i, /部署验证失败|Deployment Failed Verification/i] },
    };
    const auditRule = auditMap[lastFailureNode];
    if (auditRule) {
      try {
        const auditContent = await fs.readFile(path.join(workspace, "audit", auditRule.file), "utf-8");
        const matched = auditRule.patterns.some((pattern) => pattern.test(auditContent));
        if (!matched) {
          errors.push(`lastFailure.node=${lastFailureNode} 但 audit/${auditRule.file} 缺少对应证据`);
        }
      } catch {
        errors.push(`lastFailure.node=${lastFailureNode} 但缺少 audit/${auditRule.file}`);
      }
    }
  }

  const subTasks = Array.isArray(boulder?.state?.subTasks) ? boulder.state.subTasks : [];
  const fileSummaries = traceIndex?.files || {};
  for (const task of subTasks) {
    if (!task?.fileTarget) continue;
    const summary = fileSummaries[task.fileTarget];
    if (task.status === "completed") {
      if (!summary) {
        errors.push(`subTask ${task.fileTarget} 宸叉爣璁?completed锛屼絾 trace-index.files 涓己灏戝搴旀枃浠舵眹鎬?`);
        continue;
      }
      if (summary.lastStatus !== "written") {
        errors.push(`subTask ${task.fileTarget} 宸叉爣璁?completed锛屼絾 trace-index.files.lastStatus=${summary.lastStatus}`);
      }
    }
    if (task.status === "failed" && summary?.lastStatus === "written") {
      errors.push(`subTask ${task.fileTarget} 宸叉爣璁?failed锛屼絾 trace-index.files.lastStatus=written`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function buildReplayStateFromSnapshot(
  snapshotState: Partial<JimClawState>,
  options: { preserveFailureEvidence?: boolean } = {}
): Partial<JimClawState> {
  const preserveFailureEvidence = Boolean(options.preserveFailureEvidence);
  return {
    ...snapshotState,
    messages: [],
    teamChatLog: [],
    requiresApproval: false,
    deploymentStatus: preserveFailureEvidence ? (snapshotState.deploymentStatus || { status: "none" }) : { status: "none" },
    qaFailures: preserveFailureEvidence ? (snapshotState.qaFailures || null) : null,
    testResults: preserveFailureEvidence ? (snapshotState.testResults || "") : "",
    lastFailedNode: preserveFailureEvidence ? (snapshotState.lastFailedNode || "") : "",
    lastFailureSummary: preserveFailureEvidence ? (snapshotState.lastFailureSummary || "") : "",
    blockedReason: preserveFailureEvidence ? (snapshotState.blockedReason || "") : "",
    agentRecoveryPending: false,
    agentRecoveryNode: "",
    agentRecoveryReason: "",
    recoveredEnvironment: false,
    envReady: null,
    resumeFromNode: "",
    containerId: preserveFailureEvidence ? (snapshotState.containerId || "") : "",
    allocatedHostPort: preserveFailureEvidence ? (snapshotState.allocatedHostPort ?? null) : null,
    failureFingerprint: preserveFailureEvidence ? (snapshotState.failureFingerprint || "") : "",
    sameFailureCount: preserveFailureEvidence ? (snapshotState.sameFailureCount || 0) : 0,
  };
}

function shouldPreserveFailureEvidenceForNode(nodeName: string): boolean {
  const rawNode = String(nodeName || "").trim();
  if (!rawNode) return false;
  if ([
    "qa",
    "approval",
    "approval_pending",
    "deploy",
    "agent_pending",
    "infra_setup",
    "terminal",
    "verifier",
    "fix_plan",
    "architect_mediation",
    "coder",
  ].includes(rawNode)) return true;
  if (/^env_guard/i.test(rawNode)) return true;
  return false;
}

export function getResumeNodeFromCheckpoint(nodeName: string): string {
  if (/^coder_task_/i.test(String(nodeName || ""))) {
    return "coder";
  }
  switch (nodeName) {
    case "approval":
    case "approval_pending":
      return "approval";
    case "orchestrator":
      return "coder";
    case "coder_final":
      return "env_guard";
    case "verifier":
      return "qa";
    case "qa":
      return "qa_resume_router";
    case "deploy":
      return "post_mortem";
    default:
      return "pm";
  }
}

export function buildResumeStateFromCurrentSnapshot(snapshot: { node: string; state?: Partial<JimClawState> }): Partial<JimClawState> {
  const snapshotState = snapshot.state || {};
  const rawNode = String(snapshot.node || "").trim();
  const preserveFailureEvidence = shouldPreserveFailureEvidenceForNode(rawNode);
  const replayState = buildReplayStateFromSnapshot(snapshotState, { preserveFailureEvidence });
  const strippedCrashNode = rawNode.replace(/_crash$/i, "");
  const graphNodes = new Set([
    "pm",
    "architect",
    "contract_sync",
    "approval",
    "approval_pending",
    "orchestrator",
    "coder",
    "env_guard",
    "infra_setup",
    "terminal",
    "verifier",
    "qa",
    "deploy",
    "post_mortem",
    "persistence",
    "architect_mediation",
    "fix_plan",
    "agent_pending",
  ]);

  function normalizeResumeNode(nodeName: string): string {
    const normalized = String(nodeName || "").trim();
    if (!normalized) return "";
    if (/^coder_task_/i.test(normalized)) return "coder";
    if (normalized === "approval_pending") return "approval";
    if (normalized === "qa") return "qa_resume_router";
    if (normalized === "qa_checkpoint_resume" || normalized === "qa_env_fix") return "qa";
    if (/^env_guard/i.test(normalized)) return "env_guard";
    if (graphNodes.has(normalized)) return normalized;
    return "";
  }

  const resumeFromNode =
    rawNode === "agent_pending"
      ? String(
          normalizeResumeNode(String(snapshotState.agentRecoveryNode || "")) ||
          normalizeResumeNode(String(snapshotState.lastFailedNode || "")) ||
          getResumeNodeFromCheckpoint(String(snapshotState.lastFailedNode || "")) ||
          normalizeResumeNode(String(snapshotState.resumeFromNode || "")) ||
          "pm"
        )
      : rawNode === "approval_pending"
        ? "approval"
        : normalizeResumeNode(rawNode) ||
          (/_crash$/i.test(rawNode) ? (normalizeResumeNode(strippedCrashNode) || strippedCrashNode || "pm") : "") ||
          getResumeNodeFromCheckpoint(rawNode);

  return {
    ...replayState,
    resumeFromNode: resumeFromNode || "pm",
  };
}

export function prepareReplayStateFromCheckpoint(snapshot: { node: string; state?: Partial<JimClawState> }): Partial<JimClawState> {
  const preserveFailureEvidence = shouldPreserveFailureEvidenceForNode(snapshot.node);
  const replayState = buildReplayStateFromSnapshot(snapshot.state || {}, { preserveFailureEvidence });
  replayState.resumeFromNode = getResumeNodeFromCheckpoint(snapshot.node);
  return replayState;
}

/**
 * Docker 容器执行辅助
 */
export function buildDockerExecArgs(
  containerId: string,
  command: string,
  opts: { background?: boolean } = {}
): string[] {
  return [
    "exec",
    ...(opts.background ? ["-d"] : []),
    "-w",
    "/app",
    containerId,
    "sh",
    "-c",
    command,
  ];
}

async function execDockerCliArgs(
  args: string[],
  opts: { timeout?: number } = {}
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn("docker", args, { env: process.env });
    const finish = (result: { ok: boolean; stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = opts.timeout
      ? setTimeout(() => {
          child.kill("SIGTERM");
          finish({ ok: false, stdout, stderr, exitCode: null, timedOut: true });
        }, opts.timeout)
      : undefined;

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      finish({ ok: false, stdout, stderr: stderr + error.message, exitCode: null, timedOut: false });
    });
    child.on("close", (code) => {
      finish({ ok: code === 0, stdout, stderr, exitCode: code, timedOut: false });
    });
  });
}

export async function execInContainer(containerId: string, command: string, opts: { timeout?: number; background?: boolean } = {}): Promise<string> {
  if (opts.background) {
    const bgResult = await execDockerCliArgs(
      buildDockerExecArgs(containerId, command, { background: true }),
      { timeout: 10000 }
    );
    return bgResult.stdout + bgResult.stderr;
  }
// ═══════════════════════════════════════════════════════════════════════
// §11 容器执行 (execInContainer)
// ═══════════════════════════════════════════════════════════════════════
  const result = await execDockerCliArgs(
    buildDockerExecArgs(containerId, command),
    { timeout: opts.timeout ?? 90000 }
  );
  if (result.timedOut) {
    // 保持与旧 ShellExecuteSkill 格式兼容，让调用方的 isTimeoutOutput() 能正确匹配
    return `Command timed out after ${opts.timeout ?? 90000}ms\nOutput:\n${result.stdout}\nErrors:\n${result.stderr}`;
  }
  if (!result.ok) {
    // 保持与旧 ShellExecuteSkill 格式兼容，让调用方的 isCommandFailureOutput() 能正确匹配
    return `Command failed with exit code ${result.exitCode}\nOutput:\n${result.stdout}\nErrors:\n${result.stderr}`;
  }
  return result.stdout;
}
