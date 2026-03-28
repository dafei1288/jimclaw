import { ApprovalStage, CustomerApprovalState, JimClawState } from "../graph_types";
import { getBeijingTime, writeMeetingNote } from "../logic_utils";

function resolveApprovalStage(state: JimClawState): ApprovalStage | null {
  if (state.pendingApprovalStage) return state.pendingApprovalStage;
  if (state.isDone) return "deploy";
  if (state.spec) return "solution";
  if (state.contract) return "requirements";
  return null;
}

function markCheckpointApproved(
  customerApprovalState: CustomerApprovalState | null | undefined,
  stage: ApprovalStage,
  approvedBy: "customer" | "default-authorization"
): CustomerApprovalState | null {
  if (!customerApprovalState) return customerApprovalState || null;
  return {
    ...customerApprovalState,
    checkpoints: customerApprovalState.checkpoints.map((checkpoint) =>
      checkpoint.stage === stage
        ? {
            ...checkpoint,
            approved: true,
            approvedBy,
            timestamp: getBeijingTime(),
          }
        : checkpoint
    ),
  };
}

export async function approvalNode(
  state: JimClawState,
  agents: any,
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any,
  requestApproval?: (request: {
    stage: ApprovalStage;
    summary: string;
    nextNode: string;
  }) => Promise<{ approved: boolean; reason?: string; }>
) {
  startSpan("approval");
  emit("phase-change", "System", "approval");

  const stage = resolveApprovalStage(state);
  if (!stage) {
    return { requiresApproval: false, pendingApprovalStage: null, approvalNextNode: "" };
  }

  const customerApprovalState = state.customerApprovalState || null;
  const checkpoint = customerApprovalState?.checkpoints?.find((item) => item.stage === stage);
  const summary = checkpoint?.summary || "";
  const autoApprove = Boolean(customerApprovalState?.autoApprove?.[stage]);
  const nextNode = state.approvalNextNode || (
    stage === "requirements" ? "architect" :
    stage === "solution" ? "contract_sync" :
    "deploy"
  );

  if (autoApprove) {
    const nextApprovalState = markCheckpointApproved(customerApprovalState, stage, "default-authorization");
    const note = await writeMeetingNote(
      WORKSPACE,
      `note-approval-${stage}-r${state.retryCount || 0}`,
      "approval",
      state.retryCount || 0,
      `客户确认：${stage} 默认授权通过`,
      `# 客户确认\n\n- 阶段：${stage}\n- 结果：默认授权通过\n- 下一节点：${nextNode}\n- 摘要：${summary || "（无）"}\n`
    );
    const result = {
      requiresApproval: false,
      pendingApprovalStage: null,
      approvalNextNode: nextNode,
      customerApprovalState: nextApprovalState,
      meetingNotes: [note],
    };
    await saveBoulder({ ...state, ...result }, "approval");
    return result;
  }

  emit("approval_required", "系统", `等待客户确认：${stage}`, {
    stage,
    summary,
    nextNode,
    contract: state.contract,
    spec: state.spec,
    manifest: state.manifest,
    technologyDecision: state.technologyDecision,
    validationReport: state.validationReport,
  });

  const pendingResult = {
    requiresApproval: true,
    pendingApprovalStage: stage,
    approvalNextNode: nextNode,
    customerApprovalState,
  };
  await saveBoulder({ ...state, ...pendingResult }, "approval_pending");

  if (!requestApproval) {
    throw new Error(`审批阶段 ${stage} 需要客户确认，但当前会话未提供审批通道。请启用默认授权或使用支持审批的会话。`);
  }

  const decision = await requestApproval({ stage, summary, nextNode });
  if (!decision?.approved) {
    throw new Error(`客户拒绝了 ${stage} 阶段确认${decision?.reason ? `：${decision.reason}` : ""}`);
  }

  const nextApprovalState = markCheckpointApproved(customerApprovalState, stage, "customer");
  const note = await writeMeetingNote(
    WORKSPACE,
    `note-approval-${stage}-r${state.retryCount || 0}`,
    "approval",
    state.retryCount || 0,
    `客户确认：${stage} 人工批准`,
    `# 客户确认\n\n- 阶段：${stage}\n- 结果：人工批准\n- 下一节点：${nextNode}\n- 摘要：${summary || "（无）"}\n`
  );
  const result = {
    requiresApproval: false,
    pendingApprovalStage: null,
    approvalNextNode: nextNode,
    customerApprovalState: nextApprovalState,
    meetingNotes: [note],
  };
  await saveBoulder({ ...state, ...result }, "approval");
  return result;
}
