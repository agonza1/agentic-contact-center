import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { compareTimestamps, getAttentionMetadata } from "../core/attention";
import { InMemoryTelephonyIngress } from "../core/inMemoryTelephonyIngress";
import { getPipecatPrototypeHealth } from "../core/pipecatFlowPrototype";
import { runtimeSeams } from "../core/seams";
import type {
  AttentionSource,
  CallSnapshot,
  FallbackMode,
  FlowState,
  OperatorSteerAction,
  PocConfig,
  StartCallOptions,
  TranscriptTurn,
} from "../core/types";

const flowStates = new Set<FlowState>([
  "call_started",
  "greet",
  "diagnose",
  "policy_hold",
  "operator_steer",
  "steered_response",
  "wrap",
]);

const maxEventTrailPageLimit = 100;
const maxTranscriptPageLimit = 100;

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

function isAttentionSource(value: string): value is AttentionSource {
  return value === "operator_steer" || value === "fallback" || value === "operator_steer+fallback";
}

function isTranscriptSpeaker(value: string): value is TranscriptTurn["speaker"] {
  return value === "caller" || value === "agent" || value === "operator" || value === "system";
}

function buildCallPayload(snapshot: CallSnapshot) {
  return {
    ...snapshot,
    attention: getAttentionMetadata(snapshot),
  };
}

function buildEventTrailPayload(
  snapshot: CallSnapshot,
  eventType?: string,
  source?: string,
  since?: string,
  offset = 0,
  limit?: number,
  order: "asc" | "desc" = "asc",
) {
  const filteredEvents = snapshot.events.filter((event) => {
    const matchesType = eventType === undefined || event.type === eventType;
    const matchesSource = source === undefined || event.detail.source === source;
    const matchesSince = since === undefined || compareTimestamps(event.at, since) >= 0;
    return matchesType && matchesSource && matchesSince;
  });
  const orderedEvents = order === "asc" ? filteredEvents : [...filteredEvents].reverse();
  const events = orderedEvents.slice(offset, limit === undefined ? undefined : offset + limit);
  const latestFilteredEvent = filteredEvents.at(-1);
  const lastReturnedEvent = events.at(-1);

  return {
    callId: snapshot.session.callId,
    providerCallId: snapshot.session.providerCallId,
    openclawSession: snapshot.session.openclawSession,
    events,
    summary: {
      totalEvents: snapshot.events.length,
      returnedEvents: events.length,
      filteredType: eventType ?? null,
      filteredSource: source ?? null,
      filteredSince: since ?? null,
      order,
      page: {
        offset,
        limit: limit ?? null,
        totalFilteredEvents: filteredEvents.length,
        hasMore: limit === undefined ? false : offset + events.length < filteredEvents.length,
        nextOffset: limit !== undefined && offset + events.length < filteredEvents.length ? offset + events.length : null,
      },
      latestEventType: latestFilteredEvent?.type ?? null,
      latestEventAt: latestFilteredEvent?.at ?? null,
      lastReturnedEventType: lastReturnedEvent?.type ?? null,
      lastReturnedEventAt: lastReturnedEvent?.at ?? null,
    },
  };
}

function buildTranscriptPayload(
  snapshot: CallSnapshot,
  speaker?: TranscriptTurn["speaker"],
  since?: string,
  until?: string,
  text?: string,
  offset = 0,
  limit?: number,
  order: "asc" | "desc" = "asc",
) {
  const normalizedText = text?.toLocaleLowerCase();
  const filteredTurns = snapshot.transcript.filter((turn) => {
    const matchesSpeaker = speaker === undefined || turn.speaker === speaker;
    const matchesSince = since === undefined || compareTimestamps(turn.timestamp, since) >= 0;
    const matchesUntil = until === undefined || compareTimestamps(turn.timestamp, until) <= 0;
    const matchesText = normalizedText === undefined || turn.text.toLocaleLowerCase().includes(normalizedText);
    return matchesSpeaker && matchesSince && matchesUntil && matchesText;
  });
  const orderedTurns = order === "asc" ? filteredTurns : [...filteredTurns].reverse();
  const transcript = orderedTurns.slice(offset, limit === undefined ? undefined : offset + limit);
  const latestFilteredTurn = filteredTurns.at(-1);
  const lastReturnedTurn = transcript.at(-1);

  return {
    callId: snapshot.session.callId,
    providerCallId: snapshot.session.providerCallId,
    openclawSession: snapshot.session.openclawSession,
    transcript,
    summary: {
      totalTurns: snapshot.transcript.length,
      returnedTurns: transcript.length,
      filteredSpeaker: speaker ?? null,
      filteredSince: since ?? null,
      filteredUntil: until ?? null,
      filteredText: text ?? null,
      order,
      page: {
        offset,
        limit: limit ?? null,
        totalFilteredTurns: filteredTurns.length,
        hasMore: limit === undefined ? false : offset + transcript.length < filteredTurns.length,
        nextOffset: limit !== undefined && offset + transcript.length < filteredTurns.length ? offset + transcript.length : null,
      },
      latestSpeaker: latestFilteredTurn?.speaker ?? null,
      latestTurnAt: latestFilteredTurn?.timestamp ?? null,
      lastReturnedSpeaker: lastReturnedTurn?.speaker ?? null,
      lastReturnedTurnAt: lastReturnedTurn?.timestamp ?? null,
    },
  };
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

function parseOptionalPositiveIntegerFilter(
  value: string | null,
  error: string,
): number | { error: string } | undefined {
  if (value === null) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    return { error };
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return { error };
  }

  return parsed;
}

function parseOptionalNonNegativeIntegerFilter(
  value: string | null,
  error: string,
): number | { error: string } | undefined {
  if (value === null) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    return { error };
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return { error };
  }

  return parsed;
}

function parseCallListSort(value: string | null): CallListSort | { error: string } {
  if (value === null || value === "startedAt") {
    return "startedAt";
  }

  if (value === "attentionStartedAt") {
    return "attentionStartedAt";
  }

  return { error: "call_list_sort_invalid" };
}

function parseCallListOrder(value: string | null): CallListOrder | { error: string } {
  if (value === null || value === "asc") {
    return "asc";
  }

  if (value === "desc") {
    return "desc";
  }

  return { error: "call_list_order_invalid" };
}

function compareAttentionQueueOrder(left: CallSnapshot, right: CallSnapshot): number {
  const leftAttention = getAttentionMetadata(left);
  const rightAttention = getAttentionMetadata(right);

  if (leftAttention.startedAt && rightAttention.startedAt) {
    const attentionOrder = compareTimestamps(leftAttention.startedAt, rightAttention.startedAt);
    return attentionOrder === 0 ? compareTimestamps(left.session.startedAt, right.session.startedAt) : attentionOrder;
  }

  if (leftAttention.startedAt) {
    return -1;
  }

  if (rightAttention.startedAt) {
    return 1;
  }

  return compareTimestamps(left.session.startedAt, right.session.startedAt);
}

interface CallListFilters {
  flowState?: FlowState;
  pendingOperatorSteer?: boolean;
  fallbackArmed?: boolean;
  attentionRequired?: boolean;
  attentionSource?: AttentionSource;
  attentionReason?: string;
  openclawSessionId?: string;
  openclawSessionLabel?: string;
  openclawSessionRef?: string;
  callId?: string;
  providerCallId?: string;
  minAttentionAgeMs?: number;
}

type CallListSort = "startedAt" | "attentionStartedAt";
type CallListOrder = "asc" | "desc";

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

  const attentionSource = requestUrl.searchParams.get("attentionSource");
  if (attentionSource !== null && !isAttentionSource(attentionSource)) {
    return { error: `${invalidPrefix}_attention_source_invalid` };
  }

  const attentionReason = requestUrl.searchParams.get("attentionReason");
  if (attentionReason !== null && !attentionReason.trim()) {
    return { error: `${invalidPrefix}_attention_reason_invalid` };
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

  const callId = requestUrl.searchParams.get("callId");
  if (callId !== null && !callId.trim()) {
    return { error: `${invalidPrefix}_call_id_invalid` };
  }

  const providerCallId = requestUrl.searchParams.get("providerCallId");
  if (providerCallId !== null && !providerCallId.trim()) {
    return { error: `${invalidPrefix}_provider_call_id_invalid` };
  }

  const minAttentionAgeMs = parseOptionalNonNegativeIntegerFilter(
    requestUrl.searchParams.get("minAttentionAgeMs"),
    `${invalidPrefix}_min_attention_age_ms_invalid`,
  );
  if (minAttentionAgeMs !== undefined && typeof minAttentionAgeMs !== "number") {
    return minAttentionAgeMs;
  }

  return {
    flowState: flowState ?? undefined,
    pendingOperatorSteer,
    fallbackArmed,
    attentionRequired,
    attentionSource: attentionSource ?? undefined,
    attentionReason: attentionReason?.trim() || undefined,
    openclawSessionId: openclawSessionId?.trim() || undefined,
    openclawSessionLabel: openclawSessionLabel?.trim() || undefined,
    openclawSessionRef: openclawSessionRef?.trim() || undefined,
    callId: callId?.trim() || undefined,
    providerCallId: providerCallId?.trim() || undefined,
    minAttentionAgeMs,
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
      policyProfile: config.policy.profile,
      policyToolScope: config.policy.toolScope,
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
    writeJson(response, 201, buildCallPayload(snapshot));
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
      writeJson(response, 200, buildCallPayload(snapshot));
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
      writeJson(response, 200, buildCallPayload(snapshot));
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
      writeJson(response, 200, buildCallPayload(snapshot));
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

    const limit = parseOptionalPositiveIntegerFilter(requestUrl.searchParams.get("limit"), "call_list_limit_invalid");
    if (limit !== undefined && typeof limit !== "number") {
      writeBadRequest(response, limit.error);
      return;
    }

    const offset = parseOptionalNonNegativeIntegerFilter(requestUrl.searchParams.get("offset"), "call_list_offset_invalid");
    if (offset !== undefined && typeof offset !== "number") {
      writeBadRequest(response, offset.error);
      return;
    }

    const sort = parseCallListSort(requestUrl.searchParams.get("sort"));
    if (typeof sort !== "string") {
      writeBadRequest(response, sort.error);
      return;
    }

    const order = parseCallListOrder(requestUrl.searchParams.get("order"));
    if (typeof order !== "string") {
      writeBadRequest(response, order.error);
      return;
    }

    const orderedSnapshots = await ingress.listSnapshots(filters);
    if (sort === "attentionStartedAt") {
      orderedSnapshots.sort(compareAttentionQueueOrder);
    }

    if (order === "desc") {
      orderedSnapshots.reverse();
    }

    const calls = orderedSnapshots
      .slice(offset ?? 0, limit === undefined ? undefined : (offset ?? 0) + limit)
      .map((snapshot) => buildCallPayload(snapshot));
    const summary = await ingress.getQueueSummary();
    const filteredSummary = await ingress.getQueueSummary(filters);

    writeJson(response, 200, {
      calls,
      summary: {
        ...summary,
        filteredCalls: orderedSnapshots.length,
        returnedCalls: calls.length,
        sort,
        order,
        page: {
          offset: offset ?? 0,
          limit: limit ?? null,
          totalFilteredCalls: orderedSnapshots.length,
          hasMore: limit === undefined ? false : (offset ?? 0) + calls.length < orderedSnapshots.length,
          nextOffset: limit !== undefined && (offset ?? 0) + calls.length < orderedSnapshots.length ? (offset ?? 0) + calls.length : null,
        },
        filteredSummary,
      },
    });
    return;
  }

  const callTranscriptMatch = request.method === "GET" ? pathname.match(/^\/api\/calls\/([^/]+)\/transcript$/) : null;
  if (callTranscriptMatch) {
    const speakerParam = requestUrl.searchParams.get("speaker");
    if (speakerParam !== null && (!speakerParam.trim() || !isTranscriptSpeaker(speakerParam))) {
      writeBadRequest(response, "transcript_speaker_invalid");
      return;
    }

    const offset = parseOptionalNonNegativeIntegerFilter(requestUrl.searchParams.get("offset"), "transcript_offset_invalid");
    if (offset !== undefined && typeof offset !== "number") {
      writeBadRequest(response, offset.error);
      return;
    }

    const limit = parseOptionalPositiveIntegerFilter(requestUrl.searchParams.get("limit"), "transcript_limit_invalid");
    if (limit !== undefined && typeof limit !== "number") {
      writeBadRequest(response, limit.error);
      return;
    }

    if (limit !== undefined && limit > maxTranscriptPageLimit) {
      writeBadRequest(response, "transcript_limit_invalid");
      return;
    }

    const sinceParam = requestUrl.searchParams.get("since");
    const since = sinceParam === null ? undefined : normalizeTimestamp(sinceParam, "transcript_since_invalid");
    if (since !== undefined && typeof since !== "string") {
      writeBadRequest(response, since.error);
      return;
    }

    const untilParam = requestUrl.searchParams.get("until");
    const until = untilParam === null ? undefined : normalizeTimestamp(untilParam, "transcript_until_invalid");
    if (until !== undefined && typeof until !== "string") {
      writeBadRequest(response, until.error);
      return;
    }

    if (since !== undefined && until !== undefined && compareTimestamps(since, until) > 0) {
      writeBadRequest(response, "transcript_window_invalid");
      return;
    }

    const textParam = requestUrl.searchParams.get("text");
    if (textParam !== null && !textParam.trim()) {
      writeBadRequest(response, "transcript_text_invalid");
      return;
    }

    const orderParam = requestUrl.searchParams.get("order");
    if (orderParam !== null && orderParam !== "asc" && orderParam !== "desc") {
      writeBadRequest(response, "transcript_order_invalid");
      return;
    }

    const snapshot = await ingress.getSnapshot(callTranscriptMatch[1]);
    if (!snapshot) {
      writeNotFound(response);
      return;
    }

    writeJson(
      response,
      200,
      buildTranscriptPayload(
        snapshot,
        speakerParam ?? undefined,
        since,
        until,
        textParam?.trim() || undefined,
        offset,
        limit,
        orderParam ?? "asc",
      ),
    );
    return;
  }

  const callEventsMatch = request.method === "GET" ? pathname.match(/^\/api\/calls\/([^/]+)\/events$/) : null;
  if (callEventsMatch) {
    const type = requestUrl.searchParams.get("type");
    if (type !== null && !type.trim()) {
      writeBadRequest(response, "event_type_invalid");
      return;
    }

    const source = requestUrl.searchParams.get("source");
    if (source !== null && !source.trim()) {
      writeBadRequest(response, "event_source_invalid");
      return;
    }

    const sinceParam = requestUrl.searchParams.get("since");
    const since = sinceParam === null ? undefined : normalizeTimestamp(sinceParam, "event_since_invalid");
    if (since !== undefined && typeof since !== "string") {
      writeBadRequest(response, since.error);
      return;
    }

    const offset = parseOptionalNonNegativeIntegerFilter(requestUrl.searchParams.get("offset"), "event_offset_invalid");
    if (offset !== undefined && typeof offset !== "number") {
      writeBadRequest(response, offset.error);
      return;
    }

    const limit = parseOptionalPositiveIntegerFilter(requestUrl.searchParams.get("limit"), "event_limit_invalid");
    if (limit !== undefined && typeof limit !== "number") {
      writeBadRequest(response, limit.error);
      return;
    }

    if (limit !== undefined && limit > maxEventTrailPageLimit) {
      writeBadRequest(response, "event_limit_invalid");
      return;
    }

    const orderParam = requestUrl.searchParams.get("order");
    if (orderParam !== null && orderParam !== "asc" && orderParam !== "desc") {
      writeBadRequest(response, "event_order_invalid");
      return;
    }

    const snapshot = await ingress.getSnapshot(callEventsMatch[1]);
    if (!snapshot) {
      writeNotFound(response);
      return;
    }

    writeJson(
      response,
      200,
      buildEventTrailPayload(
        snapshot,
        type?.trim() || undefined,
        source?.trim() || undefined,
        since,
        offset,
        limit,
        orderParam ?? "asc",
      ),
    );
    return;
  }

  const callSnapshotMatch = request.method === "GET" ? pathname.match(/^\/api\/calls\/([^/]+)$/) : null;
  if (callSnapshotMatch) {
    const snapshot = await ingress.getSnapshot(callSnapshotMatch[1]);
    if (!snapshot) {
      writeNotFound(response);
      return;
    }

    writeJson(response, 200, buildCallPayload(snapshot));
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
