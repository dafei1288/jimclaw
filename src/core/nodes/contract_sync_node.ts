import * as fs from "fs/promises";
import * as path from "path";
import { JimClawState, ApiEndpointSchema } from "../graph_types";
import { BaseAgent } from "../agent";
import {
  buildSystemContext
} from "../logic_utils";
import { extractText, parseJsonFromResponse } from "../../utils/common";

/**
 * ContractSync 节点：负责同步和校验 API 契约
 * P2-A：由架构师（独孤）从接口一致性角度审查，而非 QA（测试视角）
 */
export async function contractSyncNode(
  state: JimClawState,
  agents: { architect: BaseAgent },
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("contract_sync");
  emit("phase-change", "System", "sync");
  if (!state.apiContract?.endpoints?.length) return { teamChatLog: [] };

  // 静态 Zod 校验（路径格式、HTTP 方法、去重）
  const validationErrors: string[] = [];
  for (const ep of state.apiContract.endpoints) {
    const result = ApiEndpointSchema.safeParse(ep);
    if (!result.success) validationErrors.push(`端点 [${ep.method} ${ep.path}]: ${result.error.message}`);
  }

  const contractReviewPrompt = `请作为软件架构师，从接口一致性和设计合理性角度审查以下 API 契约。

[当前 API 契约]：
${JSON.stringify(state.apiContract, null, 2)}

[静态校验发现的问题]：
${validationErrors.length > 0 ? validationErrors.join("\n") : "无"}

[审查要点]：
1. 端点路径格式是否规范（应以 / 开头，使用 RESTful 风格）
2. HTTP 方法是否与操作语义匹配（GET 查询、POST 创建、PUT/PATCH 更新、DELETE 删除）
3. 是否存在重复或冲突的端点
4. 请求/响应字段命名是否一致（驼峰或下划线统一）
5. 是否覆盖了项目需求中的所有核心功能

请直接输出修正后的完整 API 契约 JSON（保持原有格式），如无需修改则原样返回。`;

  const response = await agents.architect.chat([{ role: "user", content: contractReviewPrompt }], (ev: any) => emit(ev.type, ev.sender, "正在审查契约", ev), { brief: buildSystemContext(state), workspaceDir: WORKSPACE });
  const validatedContract = parseJsonFromResponse(extractText(response.content), state.apiContract);

  await fs.writeFile(path.join(WORKSPACE, "api_contract_validated.json"), JSON.stringify(validatedContract, null, 2));
  return { apiContract: validatedContract };
}
