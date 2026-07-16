import { InMemoryTelephonyIngress } from "./inMemoryTelephonyIngress";
import {
  PIPECAT_FLOW_MANAGER_PARITY_FIXTURES,
  type PipecatFlowManagerParityFixture,
} from "./pipecatFlowManagerContract";
import type { FlowState, OperatorSteerAction, PocConfig } from "./types";

export interface PipecatFlowManagerParityTraceStep {
  step: "start" | "caller_turn" | "operator_steer" | "injected_failure";
  input: string | null;
  flowState: FlowState;
  latestEventType: string | null;
  transcriptTurns: number;
}

export interface PipecatFlowManagerParityReplay {
  fixtureId: string;
  passed: boolean;
  callId: string;
  openclawSessionLabel: string;
  expectedState: string;
  actualState: string;
  expectedEvents: string[];
  missingExpectedEvents: string[];
  observedEvents: string[];
  forbiddenAgentClaimsFound: string[];
  transitionTrace: PipecatFlowManagerParityTraceStep[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExplicitClaimNegation(line: string, normalizedClaim: string): boolean {
  const claim = escapeRegExp(normalizedClaim).replace(/\s+/g, "\\s+");
  const optionalArticle = "(?:a|an|any|the)?\\s*";
  const claimAction = "(?:promise|promising|offer|offering|provide|providing|approve|approving|grant|granting|discuss|discussing)";
  const explicitNegationPatterns = [
    new RegExp(`\\bcannot\\s+discuss\\s+${optionalArticle}${claim}\\b`),
    new RegExp(`\\bcannot\\s+make\\s+an\\s+offer\\b.*\\b${claim}\\b`),
    new RegExp(`\\bnot\\s+${claimAction}\\s+${optionalArticle}${claim}\\b`),
    new RegExp(`\\bwithout\\s+${claimAction}\\s+${optionalArticle}${claim}\\b`),
    new RegExp(`\\binstead\\s+of\\b.*\\b${claimAction}\\s+${optionalArticle}${claim}\\b`),
    new RegExp(`\\bno\\s+${claim}\\b`),
  ];

  return explicitNegationPatterns.some((pattern) => pattern.test(line));
}

export function includesUnsafeClaim(agentText: string, claim: string): boolean {
  const normalizedClaim = claim.toLowerCase();
  return agentText
    .split("\n")
    .map((line) => line.toLowerCase())
    .filter((line) => line.includes(normalizedClaim))
    .some((line) => !hasExplicitClaimNegation(line, normalizedClaim));
}

export async function replayPipecatFlowManagerParityFixtures(
  config: PocConfig,
  fixtures: readonly PipecatFlowManagerParityFixture[] = PIPECAT_FLOW_MANAGER_PARITY_FIXTURES,
): Promise<PipecatFlowManagerParityReplay[]> {
  const replays: PipecatFlowManagerParityReplay[] = [];

  for (const [fixtureIndex, fixture] of fixtures.entries()) {
    const ingress = new InMemoryTelephonyIngress();
    let snapshot = await ingress.startCall(config, {
      openclawSessionLabel: `flowmanager-parity:${fixture.id}`,
    });
    const transitionTrace: PipecatFlowManagerParityTraceStep[] = [
      {
        step: "start",
        input: null,
        flowState: snapshot.flowState,
        latestEventType: snapshot.events.at(-1)?.type ?? null,
        transcriptTurns: snapshot.transcript.length,
      },
    ];

    const callerTurns = "callerTurns" in fixture ? fixture.callerTurns : [];
    for (const [turnIndex, callerText] of callerTurns.entries()) {
      snapshot = await ingress.appendCallerTurn(
        snapshot.session.callId,
        {
          speaker: "caller",
          text: callerText,
          timestamp: new Date(Date.UTC(2026, 0, fixtureIndex + 1, 0, turnIndex)).toISOString(),
        },
        config,
        { conversationMode: "scripted" },
      );
      transitionTrace.push({
        step: "caller_turn",
        input: callerText,
        flowState: snapshot.flowState,
        latestEventType: snapshot.events.at(-1)?.type ?? null,
        transcriptTurns: snapshot.transcript.length,
      });
    }

    if ("injectedFailure" in fixture && fixture.injectedFailure === "pipecat_runtime_failure") {
      snapshot = await ingress.triggerFallback(
        snapshot.session.callId,
        "runtime_failure",
        new Date(Date.UTC(2026, 0, fixtureIndex + 1, 1, 0)).toISOString(),
        "flowmanager parity runtime failure fixture",
      );
      transitionTrace.push({
        step: "injected_failure",
        input: fixture.injectedFailure,
        flowState: snapshot.flowState,
        latestEventType: snapshot.events.at(-1)?.type ?? null,
        transcriptTurns: snapshot.transcript.length,
      });
    }

    if ("operatorAction" in fixture) {
      snapshot = await ingress.applyOperatorSteer(
        snapshot.session.callId,
        fixture.operatorAction as OperatorSteerAction,
        new Date(Date.UTC(2026, 0, fixtureIndex + 1, 2, 0)).toISOString(),
        "flowmanager parity operator fixture",
      );
      transitionTrace.push({
        step: "operator_steer",
        input: fixture.operatorAction,
        flowState: snapshot.flowState,
        latestEventType: snapshot.events.at(-1)?.type ?? null,
        transcriptTurns: snapshot.transcript.length,
      });
    }

    const observedEvents = snapshot.events.map((event) => event.type);
    const agentTranscript = snapshot.transcript
      .filter((turn) => turn.speaker === "agent")
      .map((turn) => turn.text.toLowerCase())
      .join("\n");
    const forbiddenAgentClaimsFound = fixture.forbiddenAgentClaims.filter((claim) => includesUnsafeClaim(agentTranscript, claim));
    const missingExpectedEvents = fixture.expectedEvents.filter((eventType) => !observedEvents.includes(eventType));

    replays.push({
      fixtureId: fixture.id,
      callId: snapshot.session.callId,
      openclawSessionLabel: snapshot.session.openclawSession.label,
      passed:
        snapshot.flowState === fixture.expectedState &&
        missingExpectedEvents.length === 0 &&
        forbiddenAgentClaimsFound.length === 0,
      expectedState: fixture.expectedState,
      actualState: snapshot.flowState,
      expectedEvents: [...fixture.expectedEvents],
      missingExpectedEvents,
      observedEvents,
      forbiddenAgentClaimsFound,
      transitionTrace,
    });
  }

  return replays;
}
