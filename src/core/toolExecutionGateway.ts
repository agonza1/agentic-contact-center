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

function isToolPolicyReasonCode(value: unknown): value is ToolPolicyReasonCode {
  return typeof value === "string" && [
    "cedar_allowed",
    "cedar_denied",
    "toolhive_unavailable",
    "toolhive_timeout",
    "webhook_denied",
    "webhook_timeout",
    "invalid_approval",
    "backend_failure",
    "invalid_request",
  ].includes(value);
}

function isMcpCallToolResult(value: unknown): value is { content: unknown[]; isError?: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const result = value as { content?: unknown; isError?: unknown };
  return Array.isArray(result.content) && (result.isError === undefined || typeof result.isError === "boolean");
}

function buildGatewayResult(
  request: ToolExecutionRequest,
  input: {
    mode: ToolGatewayMode;
    requestId: string;
    startedAt: number;
    timestamp: string;
    status: ToolExecutionStatus;
    reasonCode: ToolPolicyReasonCode;
    backendInvoked: boolean;
    normalizedArguments: Record<string, string | number>;
    errors?: Array<{ argumentName: string; reason: string }>;
  },
): ToolExecutionResult {
  return {
    status: input.status,
    requestId: input.requestId,
    callId: request.callId,
    gatewayMode: input.mode,
    tool: request.tool,
    principalType: request.principalType,
    reasonCode: input.reasonCode,
    backendInvoked: input.backendInvoked,
    normalizedArguments: input.normalizedArguments,
    errors: input.errors ?? [],
    decisionEvent: buildToolPolicyDecisionEvent({
      requestId: input.requestId,
      callId: request.callId,
      gatewayMode: input.mode,
      principalType: request.principalType,
      tool: request.tool,
      policyVersion: request.policyVersion ?? null,
      policyHash: request.policyHash ?? null,
      decision: input.status === "allowed" ? "allow" : input.status === "denied" ? "deny" : "error",
      reasonCode: input.reasonCode,
      backendInvoked: input.backendInvoked,
      durationMs: Date.now() - input.startedAt,
      timestamp: input.timestamp,
      arguments: request.arguments,
    }),
  };
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

    return buildGatewayResult(request, {
      mode: this.mode,
      requestId,
      startedAt,
      timestamp,
      status: allowed ? "allowed" : "denied",
      reasonCode,
      backendInvoked: allowed,
      normalizedArguments: validation.normalizedArguments,
      errors: validation.errors,
    });
  }
}

export interface ToolHiveToolExecutionGatewayOptions {
  mcpUrl: string;
  timeoutMs: number;
}

export class ToolHiveToolExecutionGateway implements ToolExecutionGateway {
  readonly mode = "toolhive" as const;
  private readonly mcpUrl: string;
  private readonly timeoutMs: number;
  private readonly sessionsByPrincipal = new Map<ToolGatewayPrincipalType, { sessionId?: string; protocolVersion: string }>();
  private readonly sessionInitializationsByPrincipal = new Map<
    ToolGatewayPrincipalType,
    Promise<{ sessionId?: string; protocolVersion: string } | null>
  >();

  constructor(options: ToolHiveToolExecutionGatewayOptions) {
    this.mcpUrl = options.mcpUrl;
    this.timeoutMs = options.timeoutMs;
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    const requestId = request.requestId ?? randomUUID();
    const timestamp = request.requestedAt ?? new Date(startedAt).toISOString();
    const validation = validateAccToolArguments(request.tool, request.arguments);
    const callableByPrincipal = isAccToolCallableByPrincipal(request.tool, request.principalType);

    if (!validation.valid || !callableByPrincipal) {
      return buildGatewayResult(request, {
        mode: this.mode,
        requestId,
        startedAt,
        timestamp,
        status: "denied",
        reasonCode: validation.valid ? "cedar_denied" : "invalid_request",
        backendInvoked: false,
        normalizedArguments: validation.normalizedArguments,
        errors: validation.errors,
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? this.timeoutMs);

    try {
      const session = await this.ensureMcpSession(request.principalType, controller.signal);
      if (!session) {
        return buildGatewayResult(request, {
          mode: this.mode,
          requestId,
          startedAt,
          timestamp,
          status: "error",
          reasonCode: "toolhive_unavailable",
          backendInvoked: false,
          normalizedArguments: validation.normalizedArguments,
        });
      }

      let response = await this.postMcpToolCall(request, requestId, validation.normalizedArguments, session, controller.signal);

      if (!response.ok) {
        if (response.status === 404 || response.status === 428) {
          this.sessionsByPrincipal.delete(request.principalType);
          const refreshedSession = await this.ensureMcpSession(request.principalType, controller.signal);
          if (refreshedSession) {
            response = await this.postMcpToolCall(
              request,
              requestId,
              validation.normalizedArguments,
              refreshedSession,
              controller.signal,
            );
          }
        }

        if (!response.ok) {
          return buildGatewayResult(request, {
            mode: this.mode,
            requestId,
            startedAt,
            timestamp,
            status: "error",
            reasonCode: response.status === 408 || response.status === 504 ? "toolhive_timeout" : "toolhive_unavailable",
            backendInvoked: false,
            normalizedArguments: validation.normalizedArguments,
          });
        }
      }

      const payload = await response.json() as {
        jsonrpc?: unknown;
        id?: unknown;
        error?: { data?: { reasonCode?: unknown } };
        result?: unknown;
      };

      if (payload.jsonrpc !== "2.0" || payload.id !== requestId) {
        return buildGatewayResult(request, {
          mode: this.mode,
          requestId,
          startedAt,
          timestamp,
          status: "error",
          reasonCode: "toolhive_unavailable",
          backendInvoked: false,
          normalizedArguments: validation.normalizedArguments,
        });
      }

      const errorReasonCode = payload.error?.data?.reasonCode;
      if (isToolPolicyReasonCode(errorReasonCode)) {
        return buildGatewayResult(request, {
          mode: this.mode,
          requestId,
          startedAt,
          timestamp,
          status: errorReasonCode === "backend_failure" ? "error" : "denied",
          reasonCode: errorReasonCode,
          backendInvoked: false,
          normalizedArguments: validation.normalizedArguments,
        });
      }

      if (payload.error) {
        return buildGatewayResult(request, {
          mode: this.mode,
          requestId,
          startedAt,
          timestamp,
          status: "denied",
          reasonCode: "cedar_denied",
          backendInvoked: false,
          normalizedArguments: validation.normalizedArguments,
        });
      }

      if (!isMcpCallToolResult(payload.result) || payload.result.isError === true) {
        return buildGatewayResult(request, {
          mode: this.mode,
          requestId,
          startedAt,
          timestamp,
          status: "error",
          reasonCode: "toolhive_unavailable",
          backendInvoked: false,
          normalizedArguments: validation.normalizedArguments,
        });
      }

      return buildGatewayResult(request, {
        mode: this.mode,
        requestId,
        startedAt,
        timestamp,
        status: "allowed",
        reasonCode: "cedar_allowed",
        backendInvoked: true,
        normalizedArguments: validation.normalizedArguments,
      });
    } catch (error) {
      return buildGatewayResult(request, {
        mode: this.mode,
        requestId,
        startedAt,
        timestamp,
        status: "error",
        reasonCode: error instanceof Error && error.name === "AbortError" ? "toolhive_timeout" : "toolhive_unavailable",
        backendInvoked: false,
        normalizedArguments: validation.normalizedArguments,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async ensureMcpSession(
    principalType: ToolGatewayPrincipalType,
    signal: AbortSignal,
  ): Promise<{ sessionId?: string; protocolVersion: string } | null> {
    const cachedSession = this.sessionsByPrincipal.get(principalType);
    if (cachedSession) {
      return cachedSession;
    }

    const inFlightInitialization = this.sessionInitializationsByPrincipal.get(principalType);
    if (inFlightInitialization) {
      return await inFlightInitialization;
    }

    const initialization = this.initializeMcpSession(principalType, signal);
    this.sessionInitializationsByPrincipal.set(principalType, initialization);
    try {
      return await initialization;
    } finally {
      if (this.sessionInitializationsByPrincipal.get(principalType) === initialization) {
        this.sessionInitializationsByPrincipal.delete(principalType);
      }
    }
  }

  private async initializeMcpSession(
    principalType: ToolGatewayPrincipalType,
    signal: AbortSignal,
  ): Promise<{ sessionId?: string; protocolVersion: string } | null> {
    const initializeId = `initialize-${randomUUID()}`;
    const initializeResponse = await fetch(this.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-acc-principal-type": principalType,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: initializeId,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: {
            name: "agentic-contact-center-toolhive-gateway",
            version: "0.1.0",
          },
        },
      }),
      signal,
    });

    if (!initializeResponse.ok) {
      return null;
    }

    const sessionId = initializeResponse.headers.get("mcp-session-id");
    const initializePayload = await initializeResponse.json() as {
      jsonrpc?: unknown;
      id?: unknown;
      result?: { protocolVersion?: unknown } | unknown;
    };
    if (initializePayload.jsonrpc !== "2.0" || initializePayload.id !== initializeId || !initializePayload.result) {
      return null;
    }
    const protocolVersion = typeof initializePayload.result === "object"
      && initializePayload.result !== null
      && !Array.isArray(initializePayload.result)
      && typeof (initializePayload.result as { protocolVersion?: unknown }).protocolVersion === "string"
      ? (initializePayload.result as { protocolVersion: string }).protocolVersion
      : "2025-06-18";

    const initializedResponse = await fetch(this.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-acc-principal-type": principalType,
        "mcp-protocol-version": protocolVersion,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      signal,
    });

    if (!initializedResponse.ok) {
      return null;
    }

    const session = {
      ...(sessionId ? { sessionId } : {}),
      protocolVersion,
    };
    this.sessionsByPrincipal.set(principalType, session);
    return session;
  }

  private async postMcpToolCall(
    request: ToolExecutionRequest,
    requestId: string,
    normalizedArguments: Record<string, string | number>,
    session: { sessionId?: string; protocolVersion: string },
    signal: AbortSignal,
  ): Promise<Response> {
    return await fetch(this.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-acc-principal-type": request.principalType,
        "mcp-protocol-version": session.protocolVersion,
        ...(session.sessionId ? { "mcp-session-id": session.sessionId } : {}),
        ...(request.idempotencyKey ? { "idempotency-key": request.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/call",
        params: {
          name: request.tool,
          arguments: normalizedArguments,
          _meta: {
            callId: request.callId,
            principalType: request.principalType,
            policyVersion: request.policyVersion ?? null,
          },
        },
      }),
      signal,
    });
  }
}
