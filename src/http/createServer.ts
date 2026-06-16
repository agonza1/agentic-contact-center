import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { InMemoryTelephonyIngress } from "../core/inMemoryTelephonyIngress";
import { getPipecatPrototypeHealth } from "../core/pipecatFlowPrototype";
import { runtimeSeams } from "../core/seams";
import type { FallbackMode, FlowState, OperatorSteerAction, PocConfig, StartCallOptions, TranscriptTurn } from "../core/types";

const flowStates = new Set<FlowState>([
  "call_started",
  "greet",
  "diagnose",
  "policy_hold",
  "operator_steer",
  "steered_response",
  "wrap",
]);

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

function hasInvalidOptionalString(value: unknown): boolean {
  return value !== undefined && typeof value !== "string";
}

function isSlackSlashCommandName(value: string): boolean {
  return /^\/[a-z0-9._-]+$/i.test(value.trim());
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

function isFlowState(value: string): value is FlowState {
  return flowStates.has(value as FlowState);
}

function parseOptionalBooleanFilter(
  value: string | null,
  error: string,
): boolean | { error: string } | undefined {
  if (value === null) {
    return undefined;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return { error };
}

interface CallListFilters {
  flowState?: FlowState;
  pendingOperatorSteer?: boolean;
  fallbackArmed?: boolean;
  attentionRequired?: boolean;
  openclawSessionId?: string;
  openclawSessionLabel?: string;
  openclawSessionRef?: string;
  providerCallId?: string;
}

function parseCallListFilters(
  requestUrl: URL,
  invalidPrefix: "call_list" | "queue",
): CallListFilters | { error: string } {
  const flowState = requestUrl.searchParams.get("flowState");
  if (flowState !== null && !isFlowState(flowState)) {
    return { error: `${invalidPrefix}_flow_state_invalid` };
  }

  const pendingOperatorSteer = parseOptionalBooleanFilter(
    requestUrl.searchParams.get("pendingOperatorSteer"),
    `${invalidPrefix}_pending_operator_steer_invalid`,
  );
  if (typeof pendingOperatorSteer !== "boolean" && pendingOperatorSteer !== undefined) {
    return pendingOperatorSteer;
  }

  const fallbackArmed = parseOptionalBooleanFilter(
    requestUrl.searchParams.get("fallbackArmed"),
    `${invalidPrefix}_fallback_armed_invalid`,
  );
  if (typeof fallbackArmed !== "boolean" && fallbackArmed !== undefined) {
    return fallbackArmed;
  }

  const attentionRequired = parseOptionalBooleanFilter(
    requestUrl.searchParams.get("attentionRequired"),
    `${invalidPrefix}_attention_required_invalid`,
  );
  if (typeof attentionRequired !== "boolean" && attentionRequired !== undefined) {
    return attentionRequired;
  }

  const openclawSessionId = requestUrl.searchParams.get("openclawSessionId");
  if (openclawSessionId !== null && !openclawSessionId.trim()) {
    return { error: `${invalidPrefix}_openclaw_session_id_invalid` };
  }

  const openclawSessionLabel = requestUrl.searchParams.get("openclawSessionLabel");
  if (openclawSessionLabel !== null && !openclawSessionLabel.trim()) {
    return { error: `${invalidPrefix}_openclaw_session_label_invalid` };
  }

  const openclawSessionRef = requestUrl.searchParams.get("openclawSessionRef");
  if (openclawSessionRef !== null && !openclawSessionRef.trim()) {
    return { error: `${invalidPrefix}_openclaw_session_ref_invalid` };
  }

  const providerCallId = requestUrl.searchParams.get("providerCallId");
  if (providerCallId !== null && !providerCallId.trim()) {
    return { error: `${invalidPrefix}_provider_call_id_invalid` };
  }

  return {
    flowState: flowState ?? undefined,
    pendingOperatorSteer,
    fallbackArmed,
    attentionRequired,
    openclawSessionId: openclawSessionId?.trim() || undefined,
    openclawSessionLabel: openclawSessionLabel?.trim() || undefined,
    openclawSessionRef: openclawSessionRef?.trim() || undefined,
    providerCallId: providerCallId?.trim() || undefined,
  };
}

function parseOperatorSteerCommand(
  value: unknown,
): { action: OperatorSteerAction; reason?: string } | { error: string } | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    return { error: "operator_steer_command_invalid" };
  }

  const command = value.trim();
  if (!command) {
    return { error: "operator_steer_command_invalid" };
  }

  const normalizedCommand = command.startsWith("/") ? command.slice(1).trimStart() : command;
  if (!normalizedCommand) {
    return { error: "operator_steer_command_invalid" };
  }

  // Accept Slack-style wrappers like `/operator pause` and `/steer ask verify latency budget`.
  const unwrappedCommand = normalizedCommand.replace(/^(?:operator|steer)\s+/i, "");
  if (!unwrappedCommand) {
    return { error: "operator_steer_command_invalid" };
  }

  const lowerCommand = unwrappedCommand.toLowerCase();

  if (lowerCommand === "pause") {
    return { action: "pause" };
  }

  if (lowerCommand === "resume") {
    return { action: "resume" };
  }

  if (lowerCommand === "approve-offer" || lowerCommand === "approve offer") {
    return { action: "approve_offer" };
  }

  if (lowerCommand === "escalate" || lowerCommand === "escalate-to-human") {
    return { action: "escalate_to_human" };
  }

  if (lowerCommand === "disarm-fallback" || lowerCommand === "disarm fallback") {
    return { action: "disarm_fallback" };
  }

  const commandPrefixes: Array<{
    prefix: string;
    action: OperatorSteerAction;
    requireArgument?: boolean;
  }> = [
    { prefix: "goto-slide", action: "goto_slide", requireArgument: true },
    { prefix: "goto slide", action: "goto_slide", requireArgument: true },
    { prefix: "ask", action: "ask_operator", requireArgument: true },
    { prefix: "arm-fallback", action: "arm_fallback", requireArgument: true },
    { prefix: "arm fallback", action: "arm_fallback", requireArgument: true },
  ];

  for (const entry of commandPrefixes) {
    if (lowerCommand === entry.prefix) {
      return entry.requireArgument ? { error: "operator_steer_command_invalid" } : { action: entry.action };
    }

    if (!lowerCommand.startsWith(`${entry.prefix} `)) {
      continue;
    }

    const reason = unwrappedCommand.slice(entry.prefix.length).trim();
    if (!reason) {
      return { error: "operator_steer_command_invalid" };
    }

    return { action: entry.action, reason };
  }

  return { error: "operator_steer_command_invalid" };
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
  const requestUrl = new URL(url, "http://localhost");
  const pathname = requestUrl.pathname;

  if (request.method === "GET" && pathname === "/health") {
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

  if (request.method === "GET" && pathname === "/api/queue") {
    const filters = parseCallListFilters(requestUrl, "queue");
    if ("error" in filters) {
      writeBadRequest(response, filters.error);
      return;
    }

    const summary = await ingress.getQueueSummary(filters);

    writeJson(response, 200, {
      summary,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/demo/start") {
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

  const callerTurnMatch = request.method === "POST" ? pathname.match(/^\/api\/calls\/([^/]+)\/caller-turn$/) : null;
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

  const fallbackMatch = request.method === "POST" ? pathname.match(/^\/api\/calls\/([^/]+)\/fallback$/) : null;
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

    if (hasInvalidOptionalString(body.reason)) {
      writeBadRequest(response, "fallback_reason_invalid");
      return;
    }

    const timestamp = normalizeTimestamp(body.timestamp, "fallback_timestamp_invalid");
    if (typeof timestamp !== "string") {
      writeBadRequest(response, timestamp.error);
      return;
    }

    try {
      const reason = getOptionalTrimmedString(body.reason);
      const snapshot = await ingress.triggerFallback(fallbackMatch[1], mode, timestamp, reason);
      writeJson(response, 200, snapshot);
    } catch {
      writeNotFound(response);
    }
    return;
  }

  const operatorSteerMatch = request.method === "POST" ? pathname.match(/^\/api\/calls\/([^/]+)\/operator-steer$/) : null;
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
    const commandInput = getOptionalTrimmedString(body.command);
    const textInput = getOptionalTrimmedString(body.text);

    let parsedCommand = parseOperatorSteerCommand(commandInput);
    if (parsedCommand && "error" in parsedCommand && commandInput && textInput && isSlackSlashCommandName(commandInput)) {
      parsedCommand = undefined;
    }

    if (parsedCommand && "error" in parsedCommand) {
      writeBadRequest(response, parsedCommand.error);
      return;
    }

    const parsedText = parsedCommand ? undefined : parseOperatorSteerCommand(textInput);
    if (parsedText && "error" in parsedText) {
      writeBadRequest(response, parsedText.error);
      return;
    }

    const action = body.action;
    if (action !== undefined && !allowedActions.includes(action as OperatorSteerAction)) {
      writeBadRequest(response, "operator_steer_action_required");
      return;
    }

    const parsedSteer = parsedCommand ?? parsedText;

    if (action !== undefined && parsedSteer && action !== parsedSteer.action) {
      writeBadRequest(response, "operator_steer_command_conflict");
      return;
    }

    const resolvedAction = (action as OperatorSteerAction | undefined) ?? parsedSteer?.action;
    if (!resolvedAction) {
      writeBadRequest(response, "operator_steer_action_required");
      return;
    }

    if (hasInvalidOptionalString(body.reason)) {
      writeBadRequest(response, "operator_steer_reason_invalid");
      return;
    }

    const reason = getOptionalTrimmedString(body.reason) ?? parsedSteer?.reason;
    if (resolvedAction === "arm_fallback" && !reason) {
      writeBadRequest(response, "operator_fallback_reason_required");
      return;
    }

    const timestamp = normalizeTimestamp(body.timestamp, "operator_steer_timestamp_invalid");
    if (typeof timestamp !== "string") {
      writeBadRequest(response, timestamp.error);
      return;
    }

    try {
      const snapshot = await ingress.applyOperatorSteer(operatorSteerMatch[1], resolvedAction, timestamp, reason);
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

  if (request.method === "GET" && pathname === "/api/calls") {
    const filters = parseCallListFilters(requestUrl, "call_list");
    if ("error" in filters) {
      writeBadRequest(response, filters.error);
      return;
    }

    const calls = await ingress.listSnapshots(filters);
    const summary = await ingress.getQueueSummary();

    writeJson(response, 200, {
      calls,
      summary: {
        ...summary,
        filteredCalls: calls.length,
      },
    });
    return;
  }

  const callSnapshotMatch = request.method === "GET" ? pathname.match(/^\/api\/calls\/([^/]+)$/) : null;
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
