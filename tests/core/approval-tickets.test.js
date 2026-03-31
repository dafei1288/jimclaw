require("ts-node/register/transpile-only");

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createApprovalTicket,
  approveTicket,
  rejectTicket,
  autoApproveTicket,
  findOpenApprovalTicket,
} = require("../../src/executor/approval_tickets");

test("creates a pending approval ticket", () => {
  const ticket = createApprovalTicket({
    stage: "network_install",
    reason: "需要联网安装依赖",
  });

  assert.equal(ticket.status, "pending");
  assert.equal(ticket.required, true);
  assert.equal(ticket.stage, "network_install");
  assert.match(ticket.id, /^ticket-/);
});

test("approves a pending ticket and records resolver metadata", () => {
  const ticket = createApprovalTicket({
    stage: "docker_start",
    reason: "需要启动 Docker",
  });

  const approved = approveTicket(ticket, "customer");

  assert.equal(approved.status, "approved");
  assert.equal(approved.resolvedBy, "customer");
  assert.equal(typeof approved.resolvedAt, "string");
});

test("rejects a pending ticket", () => {
  const ticket = createApprovalTicket({
    stage: "deployment_publish",
    reason: "需要发布部署",
  });

  const rejected = rejectTicket(ticket, "customer");

  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.resolvedBy, "customer");
  assert.equal(typeof rejected.resolvedAt, "string");
});

test("auto approves a ticket using default authorization", () => {
  const ticket = createApprovalTicket({
    stage: "background_runtime",
    reason: "需要启动后台进程",
  });

  const autoApproved = autoApproveTicket(ticket);

  assert.equal(autoApproved.status, "auto_approved");
  assert.equal(autoApproved.resolvedBy, "default-authorization");
});

test("terminal tickets cannot be resolved twice", () => {
  const ticket = createApprovalTicket({
    stage: "network_install",
    reason: "需要联网安装依赖",
  });
  const approved = approveTicket(ticket, "customer");

  assert.throws(() => rejectTicket(approved, "customer"), /terminal/i);
  assert.throws(() => autoApproveTicket(approved), /terminal/i);
});

test("findOpenApprovalTicket returns the latest pending ticket", () => {
  const approved = approveTicket(
    createApprovalTicket({ stage: "network_install", reason: "需要联网" }),
    "customer"
  );
  const pending1 = createApprovalTicket({ stage: "docker_start", reason: "需要 Docker" });
  const pending2 = createApprovalTicket({ stage: "deployment_publish", reason: "需要部署" });

  const found = findOpenApprovalTicket([approved, pending1, pending2]);

  assert.equal(found.id, pending2.id);
});
