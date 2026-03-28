import * as fs from "fs/promises";
import * as path from "path";
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
  ExecutionPlan,
  ExecutionPlanFile,
  ExecutionPlanTask,
  ExecutionProtocolFileContract,
  ProtocolFileRole,
  ProtocolPatch,
  RequirementProtocol,
  RuntimeStateSnapshot,
  RepairPlan,
  SolutionProtocol,
  TaskContract,
  TechnologyDecision,
  ValidationFailureType,
  ValidationReport,
} from "./graph_types";
import { ShellExecuteSkill } from "../skills/shell_exec";
import { AuditLogger } from "../utils/audit";

export function extractFailureEvidence(
  testOutput: string = "",
  deploymentStatus?: { status?: string } | null,
  blockedReason?: string
) {
  const normalized = String(testOutput || "");
  const verifierFailed = normalized.includes("[Verifier 预检失败]");
  const deploymentFailed = normalized.includes("[部署验证失败]") || deploymentStatus?.status === "failed";
  const coderBlocked = normalized.startsWith("[Coder 阻塞失败]") || Boolean(blockedReason);
  const commandFailed = /command failed with exit code\s+[1-9]/i.test(normalized);
  const jestFail = /^FAIL\s+/m.test(normalized) || /Test suite failed to run/i.test(normalized);
  const tapFail = /^not ok\s+/m.test(normalized);
  const typeScriptCompileFailed = /\bTS\d{4}\b/.test(normalized);
  const hasBlockingFailure =
    verifierFailed ||
    deploymentFailed ||
    coderBlocked ||
    commandFailed ||
    jestFail ||
    tapFail ||
    typeScriptCompileFailed;

  return {
    verifierFailed,
    deploymentFailed,
    coderBlocked,
    commandFailed,
    jestFail,
    tapFail,
    typeScriptCompileFailed,
    hasBlockingFailure,
  };
}

/**
 * 获取北京时间（东八区）字符串
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

  const lang = state.spec?.language?.toLowerCase() || "javascript";
  if (lang.includes("python")) return "main.py";
  if (lang.includes("go")) return "main.go";
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

function detectProtocolRuntime(language: string): "node" | "python" | "go" | "unknown" {
  const normalized = String(language || "").toLowerCase();
  if (/typescript|javascript|node/.test(normalized)) return "node";
  if (/python/.test(normalized)) return "python";
  if (/\bgo\b|golang/.test(normalized)) return "go";
  return "unknown";
}

function inferProtocolFileRole(fileTarget: string): ProtocolFileRole {
  const normalized = String(fileTarget || "").replace(/\\/g, "/").toLowerCase();
  if (/^package\.json$|^tsconfig\.json$|jest\.config\./.test(normalized)) return "config";
  if (normalized.endsWith("/dockerfile") || normalized === "dockerfile" || normalized.endsWith("docker-compose.yml")) return "infra";
  if (normalized.includes("/tests/") || normalized.includes("/__tests__/") || /\.test\.[^.]+$/.test(normalized) || /\.spec\.[^.]+$/.test(normalized)) return "test";
  if (normalized.includes("/routes/")) return "route";
  if (normalized.includes("/controllers/")) return "controller";
  if (normalized.includes("/services/")) return "service";
  if (normalized.includes("/models/")) return "model";
  if (normalized.includes("/middleware/")) return "middleware";
  if (normalized.endsWith("/index.ts") || normalized.endsWith("/index.js") || normalized === "src/index.ts" || normalized === "src/index.js") return "entry";
  return "other";
}

function allowedRolesForProtocolFile(role: ProtocolFileRole): ProtocolFileRole[] {
  switch (role) {
    case "entry":
      return ["route", "controller", "service", "model", "middleware", "config", "other"];
    case "route":
      return ["controller", "service", "middleware", "model", "other"];
    case "controller":
      return ["service", "model", "middleware", "other"];
    case "service":
      return ["model", "other"];
    case "middleware":
      return ["service", "model", "other"];
    case "test":
      return ["entry", "route", "controller", "service", "model", "middleware", "other"];
    case "infra":
      return ["config", "entry", "other"];
    case "config":
    case "model":
    case "other":
    default:
      return ["other"];
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
      : singularStem === "log"
        ? "日志"
        : singularStem === "permission"
          ? "权限"
          : "数据项";
  return { pluralStem, singularStem, resourcePath, label, title };
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
    [/商品|产品|电器|product|appliance/gi, "product"],
    [/图书|book/gi, "book"],
    [/用户|user/gi, "user"],
    [/日志|log/gi, "log"],
    [/权限|permission/gi, "permission"],
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
  const primary =
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

export function buildRequirementProtocol(contract: TaskContract | null | undefined): RequirementProtocol {
  const requirements = contract?.requirements || [];
  const acceptanceCriteria = contract?.acceptanceCriteria || [];
  const allLines = [...requirements, ...acceptanceCriteria, contract?.title || ""];
  const joined = allLines.join("\n");
  const entities = inferEntities(allLines);
  const uiCapabilities = inferUiCapabilities(allLines);
  const frontendRequired = /前端|页面|界面|ui|web|浏览器/i.test(joined);
  const backendRequired = /后端|api|接口|服务|express|fastapi|node/i.test(joined) || !frontendRequired;
  const authRequired = /权限|授权|认证|登录|jwt/i.test(joined);
  const auditLogRequired = /日志|审计|追踪/i.test(joined);
  const dockerRequired = /docker|容器|compose/i.test(joined);

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
      authRequired,
      auditLogRequired,
      dockerRequired,
      entities,
      crudEntities: entities.filter((entity) => /(list|create|edit|delete)/.test(uiCapabilities.join(",")) || /book|user|log|permission/.test(entity)),
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
  const backendFramework =
    /express/.test(framework) || /typescript|javascript/.test(language) ? "express-typescript" :
    /fastapi|python/.test(framework) || /python/.test(language) ? "fastapi-python" :
    /gin|go/.test(framework) || /\bgo\b/.test(language) ? "gin-go" :
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
  spec: { filesToCreate?: string[] } | null | undefined,
  requirementProtocol: RequirementProtocol | null | undefined
) {
  const nextSpec = { ...(spec || {}) } as Record<string, any>;
  const files = Array.isArray(nextSpec.filesToCreate) ? [...nextSpec.filesToCreate] : [];
  const fileSet = new Set(files.map((file) => String(file).replace(/\\/g, "/")));
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

  if (frontendRequired) {
    ensureFile("public/index.html");
  }

  if (backendRequired) {
    ensureFile("package.json");
    ensureFile("tsconfig.json");
    ensureFile("src/index.ts");
    ensureFile(`src/routes/${plural}.ts`);
    ensureFile(`src/controllers/${camelSingular}Controller.ts`);
    ensureFile(`src/services/${camelSingular}Service.ts`);
    ensureFile(`src/models/${singular}.ts`);
    ensureFile(`tests/${plural}.test.ts`);
  }

  if (authRequired) {
    ensureFile("src/middleware/auth.ts");
    ensureFile("src/routes/auth.ts");
    ensureFile("tests/auth.test.ts");
  }

  if (auditLogRequired) {
    ensureFile("src/logging/logger.ts");
    ensureFile("src/errors.ts");
  }

  if (dockerRequired) {
    ensureFile("Dockerfile");
    ensureFile("docker-compose.yml");
  }

  if (verifyScriptRequired) {
    ensureFile("scripts/verify.ps1");
  }

  if (backendRequired && pascalSingular) {
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

  if ((requirementProtocol?.capabilities?.crudEntities || []).length > 0) {
    ensureEndpoint("GET", basePath, `${resourceLabel}列表`);
    ensureEndpoint("POST", basePath, `创建${resourceLabel}`);
    ensureEndpoint("PUT", `${basePath}/:id`, `更新${resourceLabel}`);
    ensureEndpoint("DELETE", `${basePath}/:id`, `删除${resourceLabel}`);
  }

  if (requirementProtocol?.capabilities?.authRequired) {
    ensureEndpoint("POST", "/api/auth/login", "登录认证");
    ensureEndpoint("GET", "/api/auth/me", "当前用户信息");
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
    if (/前端|页面|界面|ui|web/i.test(requirement)) return !frontendPlanned;
    if (/后端|api|接口|服务/i.test(requirement)) return !backendPlanned;
    if (/权限|授权|认证|登录|jwt/i.test(requirement)) return !authPlanned;
    if (/日志|审计|追踪/i.test(requirement)) return !auditLogPlanned;
    return false;
  });
  const uncoveredAcceptanceCriteria = (requirementProtocol?.userIntent?.acceptanceCriteria || []).filter((criteria) => {
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

export function buildExecutionProtocol(
  spec: { language?: string; framework?: string; filesToCreate?: string[]; runCommand?: string; testCommand?: string; entryPoint?: string } | null | undefined,
  manifest: { services?: Array<{ port?: number }> } | null | undefined,
  apiContract: { endpoints?: Array<{ path: string; method: string }> } | null | undefined,
  requirementProtocol?: RequirementProtocol | null | undefined
): ExecutionProtocol {
  const requirementDrivenSpec = ensureRequirementDrivenFiles(spec, requirementProtocol);
  const normalizedSpec = normalizeNodeProjectFileLayout(ensureTypeScriptTestBaseline(requirementDrivenSpec || {}));
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
        frontendRoots: hasFrontendFiles(files) ? ["public"] : [],
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
        "test_discovery_gap 优先修复测试目录与配置，而不是继续部署",
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
        "用户明确要求前端时，必须存在前端页面文件与可访问入口",
        "用户明确要求前后端时，不得只交付 API 或只交付静态页面",
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
    for (const role of ["entry", "route", "controller", "service", "model"] as const) {
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
  } = {}
) {
  const autoApprove = {
    requirements: Boolean(opts.autoApprove?.requirements),
    solution: Boolean(opts.autoApprove?.solution),
    deploy: Boolean(opts.autoApprove?.deploy),
  };
  return {
    version: "v1" as const,
    autoApprove,
    checkpoints: (["requirements", "solution", "deploy"] as const).map((stage) => ({
      stage,
      required: true,
      approved: autoApprove[stage],
      approvedBy: autoApprove[stage] ? ("default-authorization" as const) : undefined,
      summary: opts.summaries?.[stage] || "",
      timestamp: autoApprove[stage] ? getBeijingTime() : undefined,
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
          reason: `${file} 是路由文件，修复时必须严格绑定到协议端点所有权`,
        });
      }
    }

    if (fileContract.role === "test") {
      patches.push({
        target: "validation",
        action: "append",
        path: "acceptanceRules",
        value: `测试文件 ${file} 必须被 testRoots/testMatch 实际发现`,
        reason: `${file} 是失败测试文件，修复时必须确认测试发现链路有效`,
      });
    }

    if (fileContract.role === "entry") {
      patches.push({
        target: "runtime",
        action: "replace",
        path: "entryPoint",
        value: file,
        reason: `${file} 是入口文件，修复时必须作为运行时唯一入口`,
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

export function getDeterministicTemplateScaffold(
  state: JimClawState,
  fileTarget: string
): string | null {
  if (state.templateId !== "express-typescript") return null;

  const normalizedTarget = fileTarget.replace(/\\/g, "/");
  const port = state.manifest?.services?.[0]?.port || state.consensusCore?.port || 10000;
  const declaredFiles = new Set((state.spec?.filesToCreate || []).map((file) => String(file).replace(/\\/g, "/")));
  const loggerModulePath = declaredFiles.has("src/middleware/logger.ts")
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

  if (normalizedTarget === "package.json") {
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
      dependencies: runtimeDeps,
      devDependencies: {
        ...devDeps,
        "@types/cors": devDeps["@types/cors"] || "^2.8.17",
        supertest: devDeps.supertest || "^7.1.1",
        "@types/supertest": devDeps["@types/supertest"] || "^6.0.3",
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
        strict: true,
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
  preset: "ts-jest",
  testEnvironment: "node",
  roots: [${jestRoots.join(", ")}],
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\\\\.ts$": "ts-jest",
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

  if (normalizedTarget === "src/errorHandler.ts" || normalizedTarget === "src/utils/errorHandler.ts") {
    return `import { NextFunction, Request, Response } from "express";

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error("[ErrorHandler]", err.message);
  res.status(500).json({
    success: false,
    error: "Internal Server Error",
    message: err.message,
  });
}
`;
  }

  if (normalizedTarget === "src/logger.ts" || normalizedTarget === "src/middleware/logger.ts") {
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
      res.status(401).json({ success: false, message: "未提供认证令牌，访问被拒绝" });
      return;
    }

    const [scheme, token] = authHeader.split(" ");
    if (scheme !== "Bearer" || !token) {
      res.status(401).json({ success: false, message: "认证令牌格式错误，应为 Bearer <token>" });
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
      res.status(403).json({ success: false, message: "权限不足，无法访问此资源" });
      return;
    }
    next();
  };
}
`;
  }

  const crudRouteMatch = normalizedTarget.match(/^src\/routes\/([^/]+)\.(ts|js)$/);
  if (crudRouteMatch && !/health$/i.test(crudRouteMatch[1])) {
    const ownedEndpoints = inferOwnedEndpoints(normalizedTarget, state.apiContract);
    const methodSet = new Set(ownedEndpoints.map((item) => item.split(/\s+/, 1)[0]));
    const resourceStem = crudRouteMatch[1].replace(/routes?$/i, "").replace(/route$/i, "");
    const singularStem = singularizeStem(resourceStem);
    const singularPascal = toPascalCase(singularStem);
    const pluralPascal = toPascalCase(resourceStem.endsWith("s") ? resourceStem : `${resourceStem}s`);
    const resourcePath = deriveRouteMountPath(ownedEndpoints, `/api/${resourceStem}`);
    const hasCrudShape =
      ownedEndpoints.length > 0 &&
      methodSet.has("GET") &&
      methodSet.has("POST") &&
      (methodSet.has("PUT") || methodSet.has("PATCH")) &&
      methodSet.has("DELETE");

    if (hasCrudShape) {
      const hasLoggerMiddleware = declaredFiles.has("src/middleware/logMiddleware.ts");
      return `import { Router } from "express";
import { get${pluralPascal}, add${singularPascal}, edit${singularPascal}, delete${singularPascal} } from "../controllers/${singularStem}Controller";
import { authMiddleware } from "../middleware/authMiddleware";
${hasLoggerMiddleware ? 'import { logMiddleware } from "../middleware/logMiddleware";\n' : ""}

const router = Router();

${hasLoggerMiddleware ? "router.use(logMiddleware);\n\n" : ""}router.get("/", get${pluralPascal});
router.post("/", authMiddleware, add${singularPascal});
router.put("/:id", authMiddleware, edit${singularPascal});
router.delete("/:id", authMiddleware, delete${singularPascal});

export const ${toIdentifier(resourceStem)}RouteBase = "${resourcePath}";
export default router;
`;
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
  res.status(200).json({ success: true });
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
          <p>前后端一体页面，直接调用后端 API 完成${primaryResource.label}列表、添加、编辑、删除。</p>
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
          els.list.innerHTML = "<div class='card'><p>暂无${primaryResource.label}，请先添加。</p></div>";
          return;
        }
        els.list.innerHTML = state.records.map((record) => {
          const id = record._id || record.id;
          return \`<article class="card">
            <h3>\${record.title || "未命名${primaryResource.label}"}</h3>
            <p>负责人：\${record.author || "-"}</p>
            <p>日期：\${(record.publishedDate || "").slice(0, 10) || "-"}</p>
            <p>分类：\${record.genre || "-"}</p>
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
    const loggerImportPath = declaredFiles.has("src/middleware/logger.ts")
      ? "../src/middleware/logger"
      : "../src/logger";
    const hasAuthMiddleware = declaredFiles.has("src/middleware/auth.ts");
    return `import request from "supertest";
import app from "../src/index";
import { clearLogs, getLogs } from "${loggerImportPath}";

describe("Health API", () => {
  beforeEach(() => {
    clearLogs();
  });

  it("GET /api/health ${hasAuthMiddleware ? "在无授权时返回 401" : "返回 200"}", async () => {
    const response = await request(app).get("/api/health");

    expect(response.status).toBe(${hasAuthMiddleware ? 401 : 200});
    expect(response.body).toHaveProperty("success", ${hasAuthMiddleware ? "false" : "true"});
  });

  it("GET /api/health 在有效请求下返回健康状态", async () => {
    const response = await request(app)
      .get("/api/health")${hasAuthMiddleware ? '\n      .set("X-API-Key", "test-api-key-12345")' : ""};

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("success", true);
    expect(response.body).toHaveProperty("status", "ok");
    expect(response.body).toHaveProperty("timestamp");
    expect(response.body).toHaveProperty("uptime");
    expect(response.body).toHaveProperty("version", "1.0.0");
  });

  it("GET /api/health 会记录完整访问路径", async () => {
    await request(app)
      .get("/api/health")${hasAuthMiddleware ? '\n      .set("X-API-Key", "test-api-key-12345")' : ""};

    const logs = getLogs();
    const lastLog = logs[logs.length - 1];
    expect(lastLog).toHaveProperty("method", "GET");
    expect(lastLog).toHaveProperty("path", "/api/health");
    expect(lastLog).toHaveProperty("statusCode", 200);
  });

  it("GET /api/health/ping 返回 pong 且记录完整路径", async () => {
    const response = await request(app).get("/api/health/ping");

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("success", true);
    expect(response.body).toHaveProperty("message", "pong");

    const logs = getLogs();
    const lastLog = logs[logs.length - 1];
    expect(lastLog).toHaveProperty("path", "/api/health/ping");
    expect(lastLog).toHaveProperty("statusCode", 200);
  });
});
`;
  }

  const crudTestMatch = normalizedTarget.match(/^tests\/([^/]+)\.test\.(ts|js)$/);
  if (crudTestMatch && !/^(health|user)$/i.test(crudTestMatch[1])) {
    const resourceStem = crudTestMatch[1];
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
RUN npm ci

COPY . .
RUN npm run build

# 运行阶段
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

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
      reason: '检测到环境相关的错误（端口占用、依赖缺失等）',
      suggestedAction: '检查并修复环境问题'
    };
  }

  const isCrossFileError = /not exported|is not a function|undefined is not|cannot read property.*of undefined/i.test(testOutput);
  if ((retryCount >= 1 && isCrossFileError && !hasMediation) || (retryCount >= 2 && !hasMediation)) {
    return {
      type: 'architecture_problem',
      confidence: 0.8,
      reason: isCrossFileError ? '检测到明显的跨文件接口不匹配' : `经过 ${retryCount} 次重试仍未解决，怀疑存在架构冲突`,
      suggestedAction: '触发架构师仲裁'
    };
  }

  return {
    type: 'code_problem',
    confidence: 0.6,
    reason: '检测到明确的测试失败',
    suggestedAction: '返回 failedFiles，让 coder 修复代码'
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
      await ShellExecuteSkill.config.run({ command: `cd ${workspacePath} && ${cmd}`, timeout });
    }
  };

  // npm ETARGET: 常见于无效版本（例如 @types/mongoose@^7.0.0）
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
      await ShellExecuteSkill.config.run({
        command: `fuser -k ${port}/tcp 2>/dev/null || lsof -ti:${port} | xargs kill -9 2>/dev/null || true`,
        timeout: 5000
      });
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
            return { fixed: true, action: `安装 ${moduleName} 时发现 @types/mongoose 版本无效，已自动修复并重装依赖` };
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
 * 将原始错误输出归一化为“失败指纹”，用于识别自旋
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
• 【dependencies】运行时必需的包：express, cors, sqlite3, pg, mongoose, axios 等
• 【devDependencies】仅开发时需要的工具：typescript, ts-node, jest, eslint, prettier 等${needsCors ? `\n• 【本项目特别要求】cors 必须放在 dependencies 中` : ""}${needsExpress ? `\n• 【本项目特别要求】express 必须放在 dependencies 中` : ""}`;
  }
  
  if (lang.includes("python")) {
    return `\n\n[requirements.txt 依赖规则]
• 【运行时依赖】fastapi, uvicorn, sqlalchemy, requests, pydantic 等
• 【开发依赖】pytest, mypy, black 等`;
  }
  return "";
}

/**
 * Fallback 子任务生成：当模型拆解失败时，基于 TechSpec 的 filesToCreate 动态生成任务链
 */
export function generateFallbackSubTasks(spec: any, apiContract: any): any[] {
  const language = spec?.language || "TypeScript";
  const filesToCreate = spec?.filesToCreate || [];
  const tasks: any[] = [];

  // 1. 识别必需的基础文件（如果是 TS/JS 项目且没有在 filesToCreate 中显式包含 package.json）
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

  // 2. 遍历 filesToCreate 动态生成任务
  filesToCreate.forEach((file: string, index: number) => {
    // 跳过重复的 package.json
    if (file.includes("package.json") && tasks.some(t => t.fileTarget === "package.json")) return;

    // 建立简单的依赖链（后续文件依赖前续文件，虽然不严谨但能保证顺序）
    const dependencies = index > 0 ? [`fallback_task_${index - 1}`] : (tasks.length > 0 ? [tasks[tasks.length - 1].id] : []);

    tasks.push({
      id: `fallback_task_${index}`,
      description: `实现文件: ${file}`,
      fileTarget: file,
      dependencies,
      contextRequirement: `根据技术规范实现 ${file} 的核心逻辑`
    });
  });

  // 3. 兜底逻辑：如果没有任何文件定义，至少生成一个入口
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

export function ensureTypeScriptTestBaseline(spec: any): any {
  const language = String(spec?.language || "").toLowerCase();
  const testCommand = String(spec?.testCommand || "").toLowerCase();
  if (!language.includes("typescript")) return spec;
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
  return /typescript|javascript|node/.test(language) && /(npm test|jest|ts-jest)/.test(testCommand);
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

export function findContractRouteDrift(
  routeContent: string,
  contract: { endpoints?: Array<{ path: string; method: string }> } | null | undefined,
): string[] {
  const endpoints = contract?.endpoints || [];
  if (endpoints.length === 0) return [];

  const allowed = new Set(
    endpoints.map((ep) => `${String(ep.method || "").toUpperCase()} ${String(ep.path || "").trim()}`)
  );

  const routeRegex = /router\.(get|post|put|delete|patch)\s*\(\s*["'`](.+?)["'`]/gi;
  const drifts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = routeRegex.exec(routeContent)) !== null) {
    const actual = `${match[1].toUpperCase()} ${match[2]}`;
    if (!allowed.has(actual)) {
      drifts.push(`路由 ${actual} 未在 ApiContract 中声明`);
    }
  }

  return drifts;
}

/**
 * 构建结构化三层共识上下文，供所有节点注入 system prompt
 */
export function buildSystemContext(state: JimClawState): string[] {
  const core = state.consensusCore;
  const progress = state.consensusProgress;
  const notes = state.meetingNotes || [];
  const protocol = state.executionProtocol;
  const requirementProtocol = state.requirementProtocol || protocol?.requirements || null;
  const technologyDecision = state.technologyDecision || null;
  const solutionProtocol = state.solutionProtocol || protocol?.solution || null;
  const validationReport = state.validationReport || null;
  const repairPlan = state.repairPlan || null;
  const customerApprovalState = state.customerApprovalState || null;

  if (!core) {
    return consensusToStringArray(state.projectBrief);
  }

  const lines: string[] = [];

  // 第一层：核心信息
  lines.push("[项目核心]");
  lines.push(`• 项目：${core.projectTitle}`);
  if (core.requirements.length > 0) {
    lines.push(`• 需求：${core.requirements.map((r, i) => `${i + 1}. ${r}`).join("  ")}`);
  }
  if (core.architectureSummary) {
    lines.push(`• 架构：${core.architectureSummary}`);
  }
  if (core.techStack) {
    lines.push(`• 技术栈：${core.techStack}，端口：${core.port}`);
  }
  if (core.framework) {
    lines.push(`• 主框架：${core.framework}`);
  }
  if (core.coreDependencies && Object.keys(core.coreDependencies).length > 0) {
    const deps = Object.entries(core.coreDependencies).map(([k, v]) => `${k}@${v}`).join(", ");
    lines.push(`• 运行时依赖：${deps}`);
  }
  if (core.coreDevDependencies && Object.keys(core.coreDevDependencies).length > 0) {
    const devDeps = Object.entries(core.coreDevDependencies).map(([k, v]) => `${k}@${v}`).join(", ");
    lines.push(`• 开发依赖：${devDeps}`);
  }
  if (core.criticalDecisions.length > 0) {
    lines.push(`• 关键决策：${core.criticalDecisions.map(d => `• ${d}`).join("  ")}`);
  }

  // 第二层：进度快照
  if (progress) {
    const total = progress.completedFiles.length + progress.pendingFiles.length;
    lines.push("");
    lines.push(`[当前进度（第 ${progress.currentRound} 轮）]`);
    lines.push(`• 已完成（${progress.completedFiles.length}/${total} 个文件）：${progress.completedFiles.join(", ") || "无"}`);
    lines.push(`• 待完成：${progress.pendingFiles.join(", ") || "无"}`);
    if (progress.openIssues.length > 0) {
      lines.push(`• 未解决问题：${progress.openIssues.join("; ")}`);
    }
  }

  if (requirementProtocol) {
    lines.push("");
    lines.push("[需求协议]");
    lines.push(`• frontendRequired：${requirementProtocol.capabilities.frontendRequired ? "是" : "否"}`);
    lines.push(`• backendRequired：${requirementProtocol.capabilities.backendRequired ? "是" : "否"}`);
    lines.push(`• authRequired：${requirementProtocol.capabilities.authRequired ? "是" : "否"}`);
    lines.push(`• auditLogRequired：${requirementProtocol.capabilities.auditLogRequired ? "是" : "否"}`);
    if (requirementProtocol.capabilities.entities.length > 0) {
      lines.push(`• entities：${requirementProtocol.capabilities.entities.join(", ")}`);
    }
    if (requirementProtocol.capabilities.uiCapabilities.length > 0) {
      lines.push(`• uiCapabilities：${requirementProtocol.capabilities.uiCapabilities.join(", ")}`);
    }
  }

  if (solutionProtocol) {
    lines.push("");
    lines.push("[方案覆盖]");
    lines.push(`• frontendPlanned：${solutionProtocol.coverage.frontendPlanned ? "是" : "否"}`);
    lines.push(`• backendPlanned：${solutionProtocol.coverage.backendPlanned ? "是" : "否"}`);
    if (solutionProtocol.coverage.uncoveredRequirements.length > 0) {
      lines.push(`• 未覆盖需求：${solutionProtocol.coverage.uncoveredRequirements.join("；")}`);
    }
    if (solutionProtocol.coverage.uncoveredAcceptanceCriteria.length > 0) {
      lines.push(`• 未覆盖验收：${solutionProtocol.coverage.uncoveredAcceptanceCriteria.join("；")}`);
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

  // 第三层：会议纪要摘要
  if (protocol) {
    lines.push("");
    lines.push("[执行协议]");
    lines.push(`• 版本：${protocol.version}`);
    lines.push(`• runtime：${protocol.project.runtime}`);
    lines.push(`• sourceRoots：${(protocol.project.workspaceLayout.sourceRoots || []).join(", ") || "无"}`);
    lines.push(`• testRoots：${(protocol.project.workspaceLayout.testRoots || []).join(", ") || "无"}`);
    lines.push(`• frontendRoots：${(protocol.project.workspaceLayout.frontendRoots || []).join(", ") || "无"}`);
    lines.push(`• entryFiles：${(protocol.project.workspaceLayout.entryFiles || []).join(", ") || "无"}`);
    lines.push(`• healthCheckPath：${protocol.runtime.healthCheckPath || "无"}`);
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
    lines.push("（需要详情？调用 read_meeting_note(note_id)）");
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
  const summary = `${nodeName} 节点异常：${trimFailureText(firstLine, 60)}`;
  const fullContent = [
    `# ${nodeName} 节点异常`,
    "",
    `- 轮次：${round}`,
    `- 摘要：${summary}`,
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

export function buildReplayStateFromSnapshot(snapshotState: Partial<JimClawState>): Partial<JimClawState> {
  return {
    ...snapshotState,
    messages: [],
    teamChatLog: [],
    requiresApproval: false,
    deploymentStatus: { status: "none" },
    qaFailures: null,
    testResults: "",
    lastFailedNode: "",
    lastFailureSummary: "",
    blockedReason: "",
    recoveredEnvironment: false,
    envReady: null,
    resumeFromNode: "",
    containerId: "",
    allocatedHostPort: null,
    failureFingerprint: "",
    sameFailureCount: 0,
  };
}

export function getResumeNodeFromCheckpoint(nodeName: string): string {
  switch (nodeName) {
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

export function prepareReplayStateFromCheckpoint(snapshot: { node: string; state?: Partial<JimClawState> }): Partial<JimClawState> {
  const replayState = buildReplayStateFromSnapshot(snapshot.state || {});
  replayState.resumeFromNode = getResumeNodeFromCheckpoint(snapshot.node);
  return replayState;
}

/**
 * Docker 容器执行辅助
 */
export async function execInContainer(containerId: string, command: string, opts: { timeout?: number; background?: boolean } = {}): Promise<string> {
  if (opts.background) {
    return ShellExecuteSkill.config.run({
      command: `docker exec -d ${containerId} sh -c ${JSON.stringify(command)}`,
      timeout: 10000,
    });
  }
  return ShellExecuteSkill.config.run({
    command: `docker exec ${containerId} sh -c ${JSON.stringify(command)}`,
    timeout: opts.timeout ?? 90000,
  });
}
