import { createHash } from "node:crypto";

import type { EventTrailEntry } from "./types";
import type { AccToolName, ToolGatewayPrincipalType } from "./toolGatewayTools";
import type { ToolGatewayMode } from "./toolGatewayReadiness";

export type ToolPolicyDecision = "allow" | "deny" | "error";

export type ToolPolicyReasonCode =
  | "cedar_allowed"
  | "cedar_denied"
  | "toolhive_unavailable"
  | "toolhive_timeout"
  | "webhook_denied"
  | "webhook_timeout"
  | "invalid_approval"
  | "backend_failure"
  | "invalid_request";

export interface ToolPolicyDecisionInput {
  requestId: string;
  callId: string;
  gatewayMode: ToolGatewayMode;
  principalType: ToolGatewayPrincipalType;
  tool: AccToolName;
  policyVersion: string | null;
  policyHash: string | null;
  decision: ToolPolicyDecision;
  reasonCode: ToolPolicyReasonCode;
  backendInvoked: boolean;
  durationMs: number;
  timestamp: string;
  arguments?: Record<string, unknown>;
}

const sensitiveArgumentNames = new Set([
  "approval_id",
  "authorization",
  "idempotency_key",
  "jwt",
  "password",
  "secret",
  "token",
]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sortedArgumentKeys(args: Record<string, unknown>): string[] {
  return Object.keys(args).sort((left, right) => left.localeCompare(right));
}

function redactedArgumentFingerprint(args: Record<string, unknown> | undefined): {
  argumentKeys: string;
  argumentHash: string | null;
  discountPercent: number | null;
} {
  if (!args) {
    return { argumentKeys: "", argumentHash: null, discountPercent: null };
  }

  const keys = sortedArgumentKeys(args);
  const publicShape: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    const value = args[key];
    if (sensitiveArgumentNames.has(key.toLowerCase())) {
      publicShape[key] = "[redacted]";
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      publicShape[key] = value;
    } else {
      publicShape[key] = "[non_primitive]";
    }
  }

  const discountPercent = typeof args.discount_percent === "number" && Number.isFinite(args.discount_percent)
    ? args.discount_percent
    : null;

  return {
    argumentKeys: keys.join(","),
    argumentHash: sha256(JSON.stringify(publicShape)),
    discountPercent,
  };
}

export function buildToolPolicyDecisionEvent(input: ToolPolicyDecisionInput): EventTrailEntry {
  const fingerprint = redactedArgumentFingerprint(input.arguments);
  const durationMs = Math.max(0, Math.trunc(input.durationMs));

  return {
    type: "tool_policy_decision",
    at: input.timestamp,
    detail: {
      requestId: input.requestId,
      callId: input.callId,
      gatewayMode: input.gatewayMode,
      principalType: input.principalType,
      tool: input.tool,
      policyVersion: input.policyVersion,
      policyHash: input.policyHash,
      decision: input.decision,
      reasonCode: input.reasonCode,
      backendInvoked: input.backendInvoked,
      durationMs,
      argumentKeys: fingerprint.argumentKeys,
      argumentHash: fingerprint.argumentHash,
      discountPercent: fingerprint.discountPercent,
    },
  };
}
