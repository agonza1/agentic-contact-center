import { randomUUID } from "node:crypto";

import { buildToolPolicyDecisionEvent, type ToolPolicyReasonCode } from "./toolGatewayDecision";
import type { ToolGatewayMode } from "./toolGatewayReadiness";
import {
  isAccToolCallableByPrincipal,
  validateAccToolArguments,
  type AccToolName,
  type ToolGatewayPrincipalType,
} from "./toolGatewayTools";
import type { EventTrailEntry } from "./types";

export type ToolExecutionStatus = "allowed" | "denied" | "error";

export interface ToolExecutionRequest {
  requestId?: string;
  callId: string;
  principalType: ToolGatewayPrincipalType;
  tool: AccToolName;
  arguments: Record<string, unknown>;
  policyVersion?: string | null;
  policyHash?: string | null;
  timeoutMs?: number;
  idempotencyKey?: string | null;
  requestedAt?: string;
}

export interface ToolExecutionResult {
  status: ToolExecutionStatus;
  requestId: string;
  callId: string;
  gatewayMode: ToolGatewayMode;
  tool: AccToolName;
  principalType: ToolGatewayPrincipalType;
  reasonCode: ToolPolicyReasonCode;
  backendInvoked: boolean;
  normalizedArguments: Record<string, string | number>;
  errors: Array<{ argumentName: string; reason: string }>;
  decisionEvent: EventTrailEntry;
}

export interface ToolExecutionGateway {
  readonly mode: ToolGatewayMode;
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
}

export class DirectToolExecutionGateway implements ToolExecutionGateway {
  readonly mode = "direct" as const;

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    const requestId = request.requestId ?? randomUUID();
    const timestamp = request.requestedAt ?? new Date(startedAt).toISOString();
    const validation = validateAccToolArguments(request.tool, request.arguments);
    const callableByPrincipal = isAccToolCallableByPrincipal(request.tool, request.principalType);
    const allowed = callableByPrincipal && validation.valid;
    const reasonCode: ToolPolicyReasonCode = allowed
      ? "cedar_allowed"
      : validation.valid
        ? "cedar_denied"
        : "invalid_request";

    return {
      status: allowed ? "allowed" : "denied",
      requestId,
      callId: request.callId,
      gatewayMode: this.mode,
      tool: request.tool,
      principalType: request.principalType,
      reasonCode,
      backendInvoked: allowed,
      normalizedArguments: validation.normalizedArguments,
      errors: validation.errors,
      decisionEvent: buildToolPolicyDecisionEvent({
        requestId,
        callId: request.callId,
        gatewayMode: this.mode,
        principalType: request.principalType,
        tool: request.tool,
        policyVersion: request.policyVersion ?? null,
        policyHash: request.policyHash ?? null,
        decision: allowed ? "allow" : "deny",
        reasonCode,
        backendInvoked: allowed,
        durationMs: Date.now() - startedAt,
        timestamp,
        arguments: request.arguments,
      }),
    };
  }
}
