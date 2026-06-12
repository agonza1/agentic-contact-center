import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { InMemoryTelephonyIngress } from "../core/inMemoryTelephonyIngress";
import { getPipecatPrototypeHealth } from "../core/pipecatFlowPrototype";
import { runtimeSeams } from "../core/seams";
import type { FallbackMode, OperatorSteerAction, PocConfig, StartCallOptions, TranscriptTurn } from "../core/types";

function writeJson(response: ServerResponse, statusCode: number, payload: object): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload, null, 2));
}

function writeNotFound(response: ServerResponse): void {
  writeJson(response, 404, {
    ok: false,
    error: "not_found",
  });
}

function writeBadRequest(response: ServerResponse, error: string): void {
  writeJson(response, 400, {
    ok: false,
    error,
  });
}

class InvalidJsonBodyError extends Error {
  constructor() {
    super("invalid_json_body");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getOptionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function normalizeTimestamp(timestamp: unknown, error: string): string | { error: string } {
  if (timestamp === undefined) {
    return new Date().toISOString();
  }

  if (typeof timestamp !== "string" || !timestamp.trim() || Number.isNaN(Date.parse(timestamp))) {
    return { error };
  }

  return timestamp;
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");

  if (!rawBody) {
    return {} as T;
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new InvalidJsonBodyError();
  }
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: PocConfig,
  ingress: InMemoryTelephonyIngress,
): Promise<void> {
  const url = request.url ?? "/";

  if (request.method === "GET" && url === "/health") {
    writeJson(response, 200, {
      ok: true,
      demoName: config.demoName,
      mode: config.mode,
      provider: config.provider.name,
      operatorChannel: config.operator.channel,
      fallbackMode: config.policy.fallbackMode,
      latencyBudgetsMs: config.latencyBudgetsMs,
      runtimeSeams,
      pipecatFlow: getPipecatPrototypeHealth(),
    });
    return;
  }

  if (request.method === "POST" && url === "/api/demo/start") {
    const body = await readJsonBody<unknown>(request);

    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    const openclawSessionId = body.openclawSessionId;
    if (openclawSessionId !== undefined && (typeof openclawSessionId !== "string" || !openclawSessionId.trim())) {
      writeBadRequest(response, "openclaw_session_id_invalid");
      return;
    }

    const openclawSessionLabel = body.openclawSessionLabel;
    if (
      openclawSessionLabel !== undefined &&
      (typeof openclawSessionLabel !== "string" || !openclawSessionLabel.trim())
    ) {
      writeBadRequest(response, "openclaw_session_label_invalid");
      return;
    }

    const snapshot = await ingress.startCall(config, {
      openclawSessionId: openclawSessionId?.trim(),
      openclawSessionLabel: openclawSessionLabel?.trim(),
    } satisfies StartCallOptions);
    writeJson(response, 201, snapshot);
    return;
  }

  const callerTurnMatch = request.method === "POST" ? url.match(/^\/api\/calls\/([^/]+)\/caller-turn$/) : null;
  if (callerTurnMatch) {
    const body = await readJsonBody<unknown>(request);

    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    const text = getOptionalTrimmedString(body.text);

    if (!text) {
      writeBadRequest(response, "caller_turn_text_required");
      return;
    }

    const timestamp = normalizeTimestamp(body.timestamp, "caller_turn_timestamp_invalid");
    if (typeof timestamp !== "string") {
      writeBadRequest(response, timestamp.error);
      return;
    }

    const turn: TranscriptTurn = {
      speaker: "caller",
      text,
      timestamp,
    };

    try {
      const snapshot = await ingress.appendCallerTurn(callerTurnMatch[1], turn, config);
      writeJson(response, 200, snapshot);
    } catch {
      writeNotFound(response);
    }
    return;
  }

  const fallbackMatch = request.method === "POST" ? url.match(/^\/api\/calls\/([^/]+)\/fallback$/) : null;
  if (fallbackMatch) {
    const body = await readJsonBody<unknown>(request);

    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    const mode = body.mode;
    if (!mode) {
      writeBadRequest(response, "fallback_mode_required");
      return;
    }

    if (mode !== "tool_timeout") {
      writeBadRequest(response, "fallback_mode_invalid");
      return;
    }

    const timestamp = normalizeTimestamp(body.timestamp, "fallback_timestamp_invalid");
    if (typeof timestamp !== "string") {
      writeBadRequest(response, timestamp.error);
      return;
    }

    try {
      const reason = typeof body.reason === "string" ? body.reason : undefined;
      const snapshot = await ingress.triggerFallback(fallbackMatch[1], mode, timestamp, reason);
      writeJson(response, 200, snapshot);
    } catch {
      writeNotFound(response);
    }
    return;
  }

  const operatorSteerMatch = request.method === "POST" ? url.match(/^\/api\/calls\/([^/]+)\/operator-steer$/) : null;
  if (operatorSteerMatch) {
    const body = await readJsonBody<unknown>(request);

    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    const allowedActions: OperatorSteerAction[] = [
      "approve_offer",
      "escalate_to_human",
      "pause",
      "resume",
      "goto_slide",
      "ask_operator",
      "arm_fallback",
      "disarm_fallback",
    ];
    const action = body.action;
    if (!action || !allowedActions.includes(action as OperatorSteerAction)) {
      writeBadRequest(response, "operator_steer_action_required");
      return;
    }

    const reason = getOptionalTrimmedString(body.reason);
    if (action === "arm_fallback" && !reason) {
      writeBadRequest(response, "operator_fallback_reason_required");
      return;
    }

    const timestamp = normalizeTimestamp(body.timestamp, "operator_steer_timestamp_invalid");
    if (typeof timestamp !== "string") {
      writeBadRequest(response, timestamp.error);
      return;
    }

    try {
      const snapshot = await ingress.applyOperatorSteer(operatorSteerMatch[1], action as OperatorSteerAction, timestamp, reason);
      writeJson(response, 200, snapshot);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Call is not awaiting operator steer")) {
        writeBadRequest(response, "operator_steer_not_pending");
        return;
      }
      writeNotFound(response);
    }
    return;
  }

  const callSnapshotMatch = request.method === "GET" ? url.match(/^\/api\/calls\/([^/]+)$/) : null;
  if (callSnapshotMatch) {
    const snapshot = await ingress.getSnapshot(callSnapshotMatch[1]);
    if (!snapshot) {
      writeNotFound(response);
      return;
    }

    writeJson(response, 200, snapshot);
    return;
  }

  writeNotFound(response);
}

export function buildHttpServer(config: PocConfig) {
  const ingress = new InMemoryTelephonyIngress();

  return createServer((request, response) => {
    void routeRequest(request, response, config, ingress).catch((error: unknown) => {
      if (error instanceof InvalidJsonBodyError) {
        writeBadRequest(response, "invalid_json");
        return;
      }

      console.error(error);
      writeJson(response, 500, { ok: false, error: "internal_error" });
    });
  });
}
