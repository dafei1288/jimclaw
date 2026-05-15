import { EvaluationAssertion, EvaluationCheck, JimClawState, SprintContract, SprintPlan } from "../graph_types";
import { getNextRunnableSprintPlan, writeMeetingNote } from "../logic_utils";
import { appendSessionEvent } from "../../utils/session_events";

function findActiveSprint(state: JimClawState): SprintPlan | null {
  return getNextRunnableSprintPlan(state);
}

function normalizeScopePath(value: string): string {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function scopeAllowsFile(fileTarget: string, scopeEntry: string): boolean {
  const file = normalizeScopePath(fileTarget);
  const scope = normalizeScopePath(scopeEntry);
  if (!scope) return false;
  return scope.endsWith("/") ? file.startsWith(scope) : file === scope;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean).map(normalizeScopePath)));
}

function normalizeEndpointUrl(value: string): string {
  const raw = String(value || "").trim().replace(/[，。；;、)）\]]+$/g, "");
  if (!raw) return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function endpointPathOnly(value: string): string {
  return normalizeEndpointUrl(value).split("#")[0].split("?")[0].replace(/\/+$/, "") || "/";
}

function extractGetUrls(text: string): string[] {
  const urls: string[] = [];
  for (const match of String(text || "").matchAll(/\bGET\s+(\/[^\s，。；;、)）\]]+)/gi)) {
    const url = normalizeEndpointUrl(match[1]);
    if (url) urls.push(url);
  }
  return Array.from(new Set(urls));
}

function extractPathMentions(text: string): string[] {
  const urls: string[] = [];
  for (const match of String(text || "").matchAll(/\/[A-Za-z0-9_./?=&%-]+/g)) {
    const url = normalizeEndpointUrl(match[0]);
    if (url) urls.push(url);
  }
  return Array.from(new Set(urls));
}

function collectSprintValidationTexts(state: JimClawState, sprint: SprintPlan): string[] {
  const criteria = state.productSpec?.acceptanceCriteria || [];
  const sprintCriteria = criteria
    .filter((criterion) => (sprint.acceptanceCriteriaIds || []).includes(criterion.id))
    .map((criterion) => criterion.description);
  return Array.from(new Set([...(sprint.doneWhen || []), ...sprintCriteria].filter(Boolean)));
}

function textTargetsUrl(text: string, url: string): boolean {
  const extractedUrls = extractGetUrls(text);
  const normalizedUrl = normalizeEndpointUrl(url);
  if (extractedUrls.length > 0) {
    return extractedUrls.some((candidate) => normalizeEndpointUrl(candidate) === normalizedUrl);
  }
  const pathMentions = extractPathMentions(text);
  if (pathMentions.length > 0) {
    const targetPath = endpointPathOnly(normalizedUrl);
    return pathMentions.some((candidate) => endpointPathOnly(candidate) === targetPath);
  }
  return true;
}

function buildSemanticAssertionTemplates(url: string, text: string): Omit<EvaluationAssertion, "id">[] {
  const normalizedText = String(text || "");
  const normalizedUrl = normalizeEndpointUrl(url);
  const isApi = endpointPathOnly(normalizedUrl).startsWith("/api/");
  const isLowStockUrl = /[?&]lowStock=true/i.test(normalizedUrl);
  const isLowStockText = /低库存|lowStock|筛选|过滤/i.test(normalizedText);
  const templates: Omit<EvaluationAssertion, "id">[] = [];

  if (isApi && /json|数组|列表|每条|字段|数据|低库存|lowStock/i.test(normalizedText)) {
    templates.push({ type: "jsonArray" });
  }

  if (isApi) {
    const fields = new Set<string>();
    const hasExplicitQuantity = /\bquantity\b/i.test(normalizedText);
    const hasExplicitStock = /\bstock\b/i.test(normalizedText);
    if (/\bid\b|编号/i.test(normalizedText)) fields.add("id");
    if (/\bname\b|名称|商品名称/i.test(normalizedText)) fields.add("name");
    if (hasExplicitQuantity) fields.add("quantity");
    if (hasExplicitStock || (!hasExplicitQuantity && /库存/i.test(normalizedText))) fields.add("stock");
    if (/\bstatus\b|库存状态|状态文本/i.test(normalizedText)) fields.add("status");
    if (/lowStock\s*(字段|field|布尔字段)|字段[^。；;]*lowStock/i.test(normalizedText)) fields.add("lowStock");
    for (const field of fields) {
      templates.push({ type: "jsonFieldExists", field, scope: "each" });
    }
  }

  if (isApi && isLowStockUrl && isLowStockText) {
    const quantityField = /\bquantity\b/i.test(normalizedText) ? "quantity" : "stock";
    templates.push({ type: "jsonNonEmpty" });
    templates.push({ type: "jsonEvery", field: quantityField, operator: "lt", value: 10 });
  }

  if (!isApi && /页面|html|展示|显示/i.test(normalizedText)) {
    if (/商品/i.test(normalizedText)) templates.push({ type: "bodyContains", text: "商品" });
    if (/库存/i.test(normalizedText)) templates.push({ type: "bodyContains", text: "库存" });
  }

  return templates;
}

function buildSemanticAssertionsForCheck(checkId: string, url: string, texts: string[]): EvaluationAssertion[] {
  const deduped = new Map<string, Omit<EvaluationAssertion, "id">>();
  const targetedTexts: string[] = [];
  for (const text of texts) {
    if (!textTargetsUrl(text, url)) continue;
    targetedTexts.push(text);
    for (const assertion of buildSemanticAssertionTemplates(url, text)) {
      const key = JSON.stringify(assertion);
      if (!deduped.has(key)) deduped.set(key, assertion);
    }
  }
  const hasExplicitQuantity = targetedTexts.some((text) => /\bquantity\b/i.test(text));
  const hasExplicitStock = targetedTexts.some((text) => /\bstock\b/i.test(text));
  const assertions = Array.from(deduped.values()).filter((assertion) => {
    if (!hasExplicitQuantity || hasExplicitStock) return true;
    return assertion.field !== "stock";
  });
  return assertions.map((assertion, index) => ({
    id: `${checkId}-A${index + 1}`,
    ...assertion,
  }));
}

function normalizeAllowedFiles(state: JimClawState, sprint: SprintPlan): string[] {
  const subTasks = state.subTasks || [];
  const filesToCreate = state.spec?.filesToCreate || [];
  const candidateFiles = unique([
    ...filesToCreate,
    ...subTasks.map((task) => task.fileTarget),
  ]);
  const sprintScope = sprint.allowedScope || [];
  const taskByFile = new Map(subTasks.map((task) => [normalizeScopePath(task.fileTarget), task]));
  const allowed = new Set(
    candidateFiles.filter((file) => sprintScope.some((scope) => scopeAllowsFile(file, scope)))
  );

  const queue = Array.from(allowed);
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const task = taskByFile.get(file);
    for (const dependency of task?.dependencies || []) {
      const normalized = normalizeScopePath(dependency);
      if (!normalized || allowed.has(normalized)) continue;
      if (candidateFiles.includes(normalized) || taskByFile.has(normalized)) {
        allowed.add(normalized);
        queue.push(normalized);
      }
    }
  }

  if (allowed.size > 0) return Array.from(allowed);
  if (filesToCreate.length > 0) return unique(filesToCreate);
  return unique(sprint.allowedScope || []);
}

function buildDefaultEvaluationChecks(state: JimClawState, sprint: SprintPlan): EvaluationCheck[] {
  const checks: EvaluationCheck[] = [];
  const validationTexts = collectSprintValidationTexts(state, sprint);
  const getEndpointPaths = new Set<string>();

  for (const endpoint of state.apiContract?.endpoints || []) {
    const method = String(endpoint.method || "").toUpperCase();
    if (method !== "GET") continue;
    const url = normalizeEndpointUrl(endpoint.path);
    getEndpointPaths.add(endpointPathOnly(url));
    const check: EvaluationCheck = {
      id: `CHK-HTTP-${checks.length + 1}`,
      kind: "http",
      description: `验证 ${method} ${url}`,
      method,
      url,
      expectedStatus: [200, 201, 204],
    };
    const assertions = buildSemanticAssertionsForCheck(check.id, url, [
      String((endpoint as any).description || ""),
      ...validationTexts,
    ]);
    if (assertions.length > 0) check.assertions = assertions;
    checks.push(check);
  }

  for (const text of validationTexts) {
    for (const url of extractGetUrls(text)) {
      if (!url.includes("?")) continue;
      if (!getEndpointPaths.has(endpointPathOnly(url))) continue;
      if (checks.some((check) => normalizeEndpointUrl(check.url || "") === url)) continue;
      const check: EvaluationCheck = {
        id: `CHK-HTTP-${checks.length + 1}`,
        kind: "http",
        description: `验证 GET ${url}：${text}`,
        method: "GET",
        url,
        expectedStatus: [200, 201, 204],
      };
      const assertions = buildSemanticAssertionsForCheck(check.id, url, [text]);
      if (assertions.length > 0) check.assertions = assertions;
      checks.push(check);
    }
  }

  if (!checks.length && state.spec?.testCommand) {
    checks.push({
      id: "CHK-CMD-1",
      kind: "command",
      description: "运行项目测试命令",
      command: state.spec.testCommand,
    });
  }

  if (!checks.length) {
    for (const item of sprint.doneWhen || []) {
      checks.push({
        id: `CHK-MANUAL-${checks.length + 1}`,
        kind: "file",
        description: item,
      });
    }
  }

  return checks;
}

function buildSprintContract(state: JimClawState, sprint: SprintPlan): SprintContract {
  const checks = buildDefaultEvaluationChecks(state, sprint);
  const selfChecks = [state.spec?.testCommand || ""].filter(Boolean);
  const allowedFiles = normalizeAllowedFiles(state, sprint);

  return {
    version: "v1",
    sprintId: sprint.id,
    builderPlan: {
      intent: sprint.goal,
      filesLikelyTouched: allowedFiles,
      implementationSteps: sprint.deliverables,
      selfChecks,
      assumptions: [],
    },
    evaluatorPlan: {
      checks,
      requiredEvidence: checks.map((check) => check.description),
      passThreshold: "all",
      concerns: [],
    },
    agreedScope: {
      allowedFiles,
      forbiddenFiles: ["node_modules/", "dist/", ".git/"],
      maxNewFiles: 8,
    },
    status: checks.length > 0 ? "agreed" : "rejected",
  };
}

export async function sprintContractNode(
  state: JimClawState,
  agents: any,
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("sprint_contract");
  emit("phase-change", "System", "sprint_contract");

  const sprint = findActiveSprint(state);
  const existingContracts = state.sprintContracts || [];
  if (!sprint) {
    const note = await writeMeetingNote(
      WORKSPACE,
      `note-sprint-contract-r${state.retryCount || 0}`,
      "sprint_contract",
      state.retryCount || 0,
      "未找到可用 Sprint，无法生成契约",
      "# Sprint Contract\n\n未找到可用 Sprint，保持现有状态。\n"
    );
    const result = {
      sprintContracts: existingContracts,
      meetingNotes: [note],
    };
    await saveBoulder({ ...state, ...result }, "sprint_contract");
    return result;
  }

  const contract = buildSprintContract(state, sprint);
  const sprintContracts = [
    ...existingContracts.filter((item) => item.sprintId !== contract.sprintId),
    contract,
  ];

  const note = await writeMeetingNote(
    WORKSPACE,
    `note-sprint-contract-r${state.retryCount || 0}`,
    "sprint_contract",
    state.retryCount || 0,
    `${sprint.id} 契约${contract.status === "agreed" ? "已确认" : "未通过"}`,
    `# Sprint Contract

## 当前 Sprint
- ${sprint.id}: ${sprint.title}

## 契约
\`\`\`json
${JSON.stringify(contract, null, 2)}
\`\`\`
`
  );

  emit("thinking", "System", `[SprintContract] ${sprint.id} 生成 ${contract.evaluatorPlan.checks.length} 个验收检查，状态：${contract.status}`, {});
  await appendSessionEvent(WORKSPACE, {
    type: "sprint_contract_agreed",
    node: "sprint_contract",
    summary: `${sprint.id} 契约${contract.status === "agreed" ? "已确认" : "未通过"}`,
    payload: { contract },
  });

  const result = {
    activeSprintId: sprint.id,
    sprintContracts,
    meetingNotes: [note],
  };
  await saveBoulder({ ...state, ...result }, "sprint_contract");
  return result;
}
