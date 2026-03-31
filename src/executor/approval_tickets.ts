import { ApprovalStage, ApprovalTicket, ApprovalTicketStatus } from "./types";

type CreateApprovalTicketInput = {
  stage: ApprovalStage;
  reason: string;
  required?: boolean;
};

function buildTicketId() {
  return `ticket-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function assertPending(ticket: ApprovalTicket) {
  if (ticket.status !== "pending") {
    throw new Error(`cannot transition terminal approval ticket: ${ticket.status}`);
  }
}

function resolveTicket(
  ticket: ApprovalTicket,
  status: Exclude<ApprovalTicketStatus, "pending">,
  resolvedBy: "customer" | "default-authorization"
): ApprovalTicket {
  assertPending(ticket);
  return {
    ...ticket,
    status,
    resolvedBy,
    resolvedAt: new Date().toISOString(),
  };
}

export function createApprovalTicket(input: CreateApprovalTicketInput): ApprovalTicket {
  return {
    id: buildTicketId(),
    stage: input.stage,
    required: input.required ?? true,
    status: "pending",
    reason: input.reason,
    requestedAt: new Date().toISOString(),
  };
}

export function approveTicket(
  ticket: ApprovalTicket,
  resolvedBy: "customer" | "default-authorization" = "customer"
): ApprovalTicket {
  return resolveTicket(ticket, "approved", resolvedBy);
}

export function rejectTicket(
  ticket: ApprovalTicket,
  resolvedBy: "customer" | "default-authorization" = "customer"
): ApprovalTicket {
  return resolveTicket(ticket, "rejected", resolvedBy);
}

export function autoApproveTicket(ticket: ApprovalTicket): ApprovalTicket {
  return resolveTicket(ticket, "auto_approved", "default-authorization");
}

export function findOpenApprovalTicket(tickets: ApprovalTicket[]): ApprovalTicket | null {
  for (let index = tickets.length - 1; index >= 0; index -= 1) {
    if (tickets[index]?.status === "pending") {
      return tickets[index];
    }
  }
  return null;
}
