import { InMemoryTelephonyIngress } from "./inMemoryTelephonyIngress";
import {
  PIPECAT_FLOW_MANAGER_PARITY_FIXTURES,
  type PipecatFlowManagerParityFixture,
} from "./pipecatFlowManagerContract";
import type { PocConfig } from "./types";

export interface PipecatFlowManagerParityReplay {
  fixtureId: string;
  passed: boolean;
  expectedState: string;
  actualState: string;
  expectedEvents: string[];
  observedEvents: string[];
  forbiddenAgentClaimsFound: string[];
}

function includesUnsafeClaim(agentText: string, claim: string): boolean {
  const normalizedClaim = claim.toLowerCase();
  return agentText
    .split("\n")
    .filter((line) => line.includes(normalizedClaim))
    .some((line) => {
      const safeNegations = [
        `cannot discuss a ${normalizedClaim}`,
        `cannot discuss any ${normalizedClaim}`,
        `cannot make an offer`,
        `not promise any ${normalizedClaim}`,
        `not promising any ${normalizedClaim}`,
        `promising any ${normalizedClaim}`,
        `without promising any ${normalizedClaim}`,
      ];

      return !safeNegations.some((negation) => line.includes(negation));
    });
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
    }

    if ("injectedFailure" in fixture && fixture.injectedFailure === "pipecat_runtime_failure") {
      snapshot = await ingress.triggerFallback(
        snapshot.session.callId,
        "runtime_failure",
        new Date(Date.UTC(2026, 0, fixtureIndex + 1, 1, 0)).toISOString(),
        "flowmanager parity runtime failure fixture",
      );
    }

    const observedEvents = snapshot.events.map((event) => event.type);
    const agentTranscript = snapshot.transcript
      .filter((turn) => turn.speaker === "agent")
      .map((turn) => turn.text.toLowerCase())
      .join("\n");
    const forbiddenAgentClaimsFound = fixture.forbiddenAgentClaims.filter((claim) => includesUnsafeClaim(agentTranscript, claim));
    const hasExpectedEvents = fixture.expectedEvents.every((eventType) => observedEvents.includes(eventType));

    replays.push({
      fixtureId: fixture.id,
      passed:
        snapshot.flowState === fixture.expectedState &&
        hasExpectedEvents &&
        forbiddenAgentClaimsFound.length === 0,
      expectedState: fixture.expectedState,
      actualState: snapshot.flowState,
      expectedEvents: [...fixture.expectedEvents],
      observedEvents,
      forbiddenAgentClaimsFound,
    });
  }

  return replays;
}
