import { CapabilitySnapshot, ExecutionIntent, ExecutorResult } from "./types";

import axios from "axios";

type FetchLike = (input: string, init?: any) => Promise<any>;

type ExternalExecutorOptions = {
  baseUrl?: string;
  token?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

function resolveExternalExecutorConfig(options: ExternalExecutorOptions = {}) {
  const timeoutMs = Number(options.timeoutMs || process.env.JIMCLAW_EXTERNAL_EXECUTOR_TIMEOUT_MS || 900000);
  return {
    baseUrl: String(options.baseUrl || process.env.JIMCLAW_EXTERNAL_EXECUTOR_URL || "").trim().replace(/\/+$/, ""),
    token: String(options.token || process.env.JIMCLAW_EXTERNAL_EXECUTOR_TOKEN || "").trim(),
    fetchImpl: options.fetchImpl || null,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 900000,
  };
}

function buildHeaders(token: string) {
  return {
    "content-type": "application/json",
    accept: "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function normalizeExecutorResult(payload: any): ExecutorResult {
  return {
    ok: Boolean(payload?.ok),
    backend: payload?.backend || "external_executor",
    stdout: String(payload?.stdout || ""),
    stderr: String(payload?.stderr || ""),
    exitCode: typeof payload?.exitCode === "number" ? payload.exitCode : undefined,
    failureType: payload?.failureType,
    retryable: Boolean(payload?.retryable),
    requiresApproval: Boolean(payload?.requiresApproval),
    approvalTicketId: payload?.approvalTicketId,
    blocked: Boolean(payload?.blocked),
    blockedReason: payload?.blockedReason ? String(payload.blockedReason) : undefined,
    artifacts: payload?.artifacts,
  };
}

export function createExternalExecutorAdapter(options: ExternalExecutorOptions = {}) {
  return {
    async execute(
      intent: ExecutionIntent,
      context: { capabilitySnapshot: CapabilitySnapshot }
    ): Promise<ExecutorResult> {
      const config = resolveExternalExecutorConfig(options);
      const baseUrl = config.baseUrl || String(context.capabilitySnapshot.externalExecutor?.baseUrl || "").trim();
      if (!baseUrl) {
        return {
          ok: false,
          backend: "external_executor",
          stdout: "",
          stderr: "",
          retryable: false,
          requiresApproval: false,
          blocked: true,
          blockedReason: "external executor not configured",
          failureType: "executor_unavailable",
        };
      }

      try {
        if (config.fetchImpl) {
          const response = await config.fetchImpl(`${baseUrl}/execute`, {
            method: "POST",
            headers: buildHeaders(config.token),
            body: JSON.stringify({ intent }),
            signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
              ? AbortSignal.timeout(config.timeoutMs)
              : undefined,
          });
          if (!response?.ok) {
            return {
              ok: false,
              backend: "external_executor",
              stdout: "",
              stderr: "",
              retryable: false,
              requiresApproval: false,
              blocked: true,
              blockedReason: `external executor http ${response?.status || "unknown"}`,
              failureType: "executor_unavailable",
            };
          }
          const payload = await response.json();
          return normalizeExecutorResult(payload);
        }
        const response = await axios.post(
          `${baseUrl}/execute`,
          { intent },
          {
            headers: buildHeaders(config.token),
            timeout: config.timeoutMs,
            responseType: "json",
            validateStatus: () => true,
          }
        );
        if (response.status < 200 || response.status >= 300) {
          return {
            ok: false,
            backend: "external_executor",
            stdout: "",
            stderr: "",
            retryable: false,
            requiresApproval: false,
            blocked: true,
            blockedReason: `external executor http ${response.status}`,
            failureType: "executor_unavailable",
          };
        }
        const payload = response.data;
        return normalizeExecutorResult(payload);
      } catch (error) {
        return {
          ok: false,
          backend: "external_executor",
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          retryable: true,
          requiresApproval: false,
          blocked: true,
          blockedReason: error instanceof Error ? error.message : String(error),
          failureType: "executor_unavailable",
        };
      }
    },
  };
}
