import type {
  CallSnapshot,
  EventTrailEntry,
  FlowState,
  FallbackMode,
  OperatorSteerAction,
  PipecatFlowPrototypeStatus,
  PocConfig,
  ScriptProgress,
  TranscriptTurn,
} from "./types";

export const SCRIPTED_CALLER_TURNS = [
  "I want to cancel my policy today.",
  "The renewal increase is too high.",
  "Okay, what safe options can you review for me?",
  "Thanks, please note that follow-up and close the call.",
] as const;

export const PIPECAT_TOOL_COVERAGE = [
  "get_current_slide",
  "goto_slide",
  "pause_presentation",
  "ask_operator",
] as const;

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function recordEvent(
  snapshot: CallSnapshot,
  type: string,
  at: string,
  detail: EventTrailEntry["detail"],
): void {
  snapshot.events.push({ type, at, detail });
}

function transitionFlowState(
  snapshot: CallSnapshot,
  nextState: FlowState,
  at: string,
  reason: string,
): void {
  if (snapshot.flowState === nextState) {
    return;
  }

  recordEvent(snapshot, "flow_state_transition", at, {
    from: snapshot.flowState,
    to: nextState,
    reason,
  });
  snapshot.flowState = nextState;
}

function appendTranscriptTurn(snapshot: CallSnapshot, turn: TranscriptTurn): void {
  snapshot.transcript.push(turn);
  recordEvent(snapshot, `${turn.speaker}_turn_appended`, turn.timestamp, {
    flowState: snapshot.flowState,
    text: turn.text,
    transcriptLength: snapshot.transcript.length,
  });
}

function appendAgentTurn(snapshot: CallSnapshot, text: string, timestamp: string): void {
  appendTranscriptTurn(snapshot, {
    speaker: "agent",
    text,
    timestamp,
  });
}

function appendOperatorTurn(snapshot: CallSnapshot, text: string, timestamp: string): void {
  appendTranscriptTurn(snapshot, {
    speaker: "operator",
    text,
    timestamp,
  });
}

function computeScriptProgress(snapshot: CallSnapshot): ScriptProgress {
  const callerTurns = snapshot.transcript.filter((turn) => turn.speaker === "caller");
  let matchedCallerTurns = 0;

  for (const [index, expectedTurn] of SCRIPTED_CALLER_TURNS.entries()) {
    const actualTurn = callerTurns[index];
    if (!actualTurn) {
      break;
    }

    if (normalizeText(actualTurn.text) !== normalizeText(expectedTurn)) {
      break;
    }

    matchedCallerTurns += 1;
  }

  return {
    name: "cancellation_rescue_seeded_script",
    expectedCallerTurns: [...SCRIPTED_CALLER_TURNS],
    matchedCallerTurns,
    completed: matchedCallerTurns === SCRIPTED_CALLER_TURNS.length,
  };
}

function buildSteeredResponse(action: OperatorSteerAction): string {
  if (action === "escalate_to_human") {
    return "Thanks for waiting. I am connecting you to a licensed retention specialist because I cannot make an offer without human review, and I will not promise any billing credit on this call.";
  }

  if (action === "resume") {
    return "Thanks for waiting. I can resume the approved script and review safe next steps without promising any billing credit on this call.";
  }

  if (action === "arm_fallback") {
    return "Manual fallback is now armed. I will hold the scripted path until the operator decides whether to continue the live demo manually.";
  }

  if (action === "disarm_fallback") {
    return "Manual fallback is now disarmed. I can return to the scripted demo path when the operator is ready.";
  }

  return "Thanks for waiting. I can review approved next steps like a coverage fit check or a retention specialist follow-up, and I will not promise any billing credit on this call.";
}

function setDemoFallback(
  snapshot: CallSnapshot,
  armed: boolean,
  timestamp: string,
  reason: string | null,
  mode: FallbackMode | null,
): void {
  snapshot.demoFallback = {
    armed,
    reason,
    mode,
    armedAt: armed ? timestamp : snapshot.demoFallback.armedAt,
    disarmedAt: armed ? snapshot.demoFallback.disarmedAt : timestamp,
    source: "mock_http_route",
  };
}

function setOperatorSteerState(
  snapshot: CallSnapshot,
  pending: boolean,
  timestamp: string,
  action: OperatorSteerAction | null,
  reason: string | null,
): void {
  snapshot.operatorSteer = {
    pending,
    lastAction: action,
    lastReason: reason,
    requestedAt: pending ? timestamp : snapshot.operatorSteer.requestedAt,
    respondedAt: pending ? snapshot.operatorSteer.respondedAt : timestamp,
    source: action ? "mock_http_route" : snapshot.operatorSteer.source,
  };
}

export function buildPipecatFlowPrototypeStatus(): PipecatFlowPrototypeStatus {
  return {
    ready: true,
    prototypeMode: "deterministic_templates",
    transport: "adapter_ready",
    activeTool: "get_current_slide",
    toolCoverage: [...PIPECAT_TOOL_COVERAGE],
    script: {
      name: "cancellation_rescue_seeded_script",
      expectedCallerTurns: [...SCRIPTED_CALLER_TURNS],
      matchedCallerTurns: 0,
      completed: false,
    },
  };
}

export function getPipecatPrototypeHealth(): Pick<
  PipecatFlowPrototypeStatus,
  "ready" | "prototypeMode" | "transport" | "toolCoverage"
> {
  const status = buildPipecatFlowPrototypeStatus();
  return {
    ready: status.ready,
    prototypeMode: status.prototypeMode,
    transport: status.transport,
    toolCoverage: status.toolCoverage,
  };
}

export function triggerFailClosedFallback(
  snapshot: CallSnapshot,
  mode: FallbackMode,
  timestamp: string,
  reason?: string,
): void {
  const fallbackReason = reason?.trim() || mode;

  snapshot.pipecatFlow.activeTool = "pause_presentation";
  setDemoFallback(snapshot, true, timestamp, fallbackReason, mode);
  setOperatorSteerState(snapshot, false, timestamp, "escalate_to_human", `${mode}_fallback`);
  recordEvent(snapshot, "demo_fallback_triggered", timestamp, {
    mode,
    reason: fallbackReason,
    source: "mock_http_route",
  });
  transitionFlowState(snapshot, "policy_hold", timestamp, `${mode}_fallback_triggered`);
  recordEvent(snapshot, "human_handoff_started", timestamp, {
    operatorChannel: snapshot.scenario.operatorChannel,
    reason: fallbackReason,
    mode,
    source: "tool_timeout_fail_closed",
  });
  appendAgentTurn(
    snapshot,
    "A required tool timed out, so I am failing closed and connecting you to a licensed retention specialist instead of improvising an offer or promising any billing credit.",
    timestamp,
  );
  transitionFlowState(snapshot, "wrap", timestamp, `${mode}_fallback_escalated`);
}

export function applyDeterministicPipecatFlow(
  snapshot: CallSnapshot,
  config: PocConfig,
  turn: TranscriptTurn,
): void {
  const callerTurns = snapshot.transcript.filter((entry) => entry.speaker === "caller");
  const callerTurnCount = callerTurns.length;

  snapshot.pipecatFlow.script = computeScriptProgress(snapshot);

  if (snapshot.pipecatFlow.script.matchedCallerTurns !== callerTurnCount) {
    const expectedTurn = SCRIPTED_CALLER_TURNS[snapshot.pipecatFlow.script.matchedCallerTurns] ?? null;

    snapshot.pipecatFlow.activeTool = "ask_operator";
    setOperatorSteerState(snapshot, true, turn.timestamp, "ask_operator", "script_diverged");
    transitionFlowState(snapshot, "policy_hold", turn.timestamp, "script_diverged");
    recordEvent(snapshot, "script_diverged", turn.timestamp, {
      matchedCallerTurns: snapshot.pipecatFlow.script.matchedCallerTurns,
      expectedTurn,
      actualTurn: turn.text,
    });
    appendAgentTurn(
      snapshot,
      "This demo is tuned to the approved cancellation-rescue script. I am pausing here and requesting operator guidance before continuing.",
      turn.timestamp,
    );
    return;
  }

  if (callerTurnCount === 1) {
    snapshot.pipecatFlow.activeTool = "get_current_slide";
    transitionFlowState(snapshot, "greet", turn.timestamp, "caller_connected");
    appendAgentTurn(
      snapshot,
      "I can help with that. Before I review options, what is pushing you to cancel today?",
      turn.timestamp,
    );
    transitionFlowState(snapshot, "diagnose", turn.timestamp, "cancellation_intent_captured");
    return;
  }

  if (callerTurnCount === 2) {
    snapshot.pipecatFlow.activeTool = "goto_slide";
    transitionFlowState(snapshot, "policy_hold", turn.timestamp, "risky_retention_boundary");
    recordEvent(snapshot, "policy_hold_entered", turn.timestamp, {
      reason: "renewal_increase_requires_safe_offer_review",
      toolScope: config.policy.toolScope,
    });
    appendAgentTurn(
      snapshot,
      "I heard the renewal increase concern. I am pausing before I discuss any retention offer so I stay within approved options.",
      turn.timestamp,
    );
    return;
  }

  if (callerTurnCount === 3) {
    snapshot.pipecatFlow.activeTool = "ask_operator";
    setOperatorSteerState(snapshot, true, turn.timestamp, config.policy.defaultSupervisorSteer, "safe_offer_review_requested");
    transitionFlowState(snapshot, "operator_steer", turn.timestamp, "safe_offer_review_requested");
    recordEvent(snapshot, "operator_steer_requested", turn.timestamp, {
      recommendation: config.policy.defaultSupervisorSteer,
      operatorChannel: snapshot.scenario.operatorChannel,
    });
    appendAgentTurn(
      snapshot,
      "I can review safe next steps once an operator approves the guidance path. I am holding here for supervisor steer.",
      turn.timestamp,
    );
    return;
  }

  if (callerTurnCount === 4) {
    snapshot.pipecatFlow.activeTool = "pause_presentation";
    transitionFlowState(snapshot, "wrap", turn.timestamp, "caller_confirmed_next_step");
    appendAgentTurn(
      snapshot,
      "I have documented the follow-up request and closed the demo call safely. Thank you for calling today.",
      turn.timestamp,
    );
    snapshot.pipecatFlow.script = computeScriptProgress(snapshot);
  }
}

export function applyOperatorSteer(
  snapshot: CallSnapshot,
  action: OperatorSteerAction,
  timestamp: string,
  reason?: string,
): void {
  snapshot.pipecatFlow.activeTool = "ask_operator";
  setOperatorSteerState(snapshot, false, timestamp, action, reason ?? null);
  appendOperatorTurn(snapshot, `operator steer: ${action}`, timestamp);
  recordEvent(snapshot, "operator_steer_applied", timestamp, {
    action,
    source: "mock_http_route",
  });

  if (action === "pause") {
    transitionFlowState(snapshot, "policy_hold", timestamp, "operator_paused_demo_flow");
    recordEvent(snapshot, "operator_demo_paused", timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
    });
    appendAgentTurn(
      snapshot,
      "I am pausing the scripted demo flow here until an operator resumes or redirects the session.",
      timestamp,
    );
    snapshot.pipecatFlow.activeTool = "pause_presentation";
    return;
  }

  if (action === "arm_fallback") {
    setDemoFallback(snapshot, true, timestamp, reason ?? "operator_requested_manual_takeover", null);
    transitionFlowState(snapshot, "policy_hold", timestamp, "operator_armed_manual_fallback");
    recordEvent(snapshot, "demo_fallback_armed", timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
      reason: snapshot.demoFallback.reason,
    });
    appendAgentTurn(snapshot, buildSteeredResponse(action), timestamp);
    snapshot.pipecatFlow.activeTool = "pause_presentation";
    return;
  }

  if (action === "disarm_fallback") {
    setDemoFallback(snapshot, false, timestamp, null, snapshot.demoFallback.mode);
    transitionFlowState(snapshot, "operator_steer", timestamp, "operator_disarmed_manual_fallback");
    recordEvent(snapshot, "demo_fallback_disarmed", timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
    });
    appendAgentTurn(snapshot, buildSteeredResponse(action), timestamp);
    snapshot.pipecatFlow.activeTool = "ask_operator";
    return;
  }

  if (action === "goto_slide") {
    transitionFlowState(snapshot, "operator_steer", timestamp, "operator_requested_slide_redirect");
    recordEvent(snapshot, "operator_slide_redirect_requested", timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
    });
    appendAgentTurn(
      snapshot,
      "I have the slide redirect request and I am holding for the operator-approved talking track before I continue.",
      timestamp,
    );
    snapshot.pipecatFlow.activeTool = "goto_slide";
    return;
  }

  if (action === "ask_operator") {
    transitionFlowState(snapshot, "operator_steer", timestamp, "operator_guidance_requested_explicitly");
    recordEvent(snapshot, "operator_guidance_re_requested", timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
    });
    appendAgentTurn(
      snapshot,
      "I am explicitly asking the operator for guidance before I continue this demo call.",
      timestamp,
    );
    snapshot.pipecatFlow.activeTool = "ask_operator";
    return;
  }

  if (action === "escalate_to_human") {
    recordEvent(snapshot, "human_handoff_started", timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
      source: "operator_steer",
    });
    transitionFlowState(snapshot, "wrap", timestamp, "operator_escalated_to_human");
    appendAgentTurn(snapshot, buildSteeredResponse(action), timestamp);
    snapshot.pipecatFlow.activeTool = "pause_presentation";
    return;
  }

  transitionFlowState(
    snapshot,
    "steered_response",
    timestamp,
    action === "resume" ? "operator_resumed_demo_flow" : "operator_guidance_available",
  );
  appendAgentTurn(snapshot, buildSteeredResponse(action), timestamp);
}
