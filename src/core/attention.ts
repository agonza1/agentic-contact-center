import type { AttentionSource, CallSnapshot } from "./types";

interface AttentionMetadata {
  required: boolean;
  source: AttentionSource | null;
  reason: string | null;
  startedAt: string | null;
  ageMs: number | null;
}

function getTimestampMs(value: string): number {
  return new Date(value).getTime();
}

export function compareTimestamps(left: string, right: string): number {
  return getTimestampMs(left) - getTimestampMs(right);
}

function getAttentionStartedAt(snapshot: CallSnapshot): string | null {
  const candidates = [
    snapshot.operatorSteer.pending ? snapshot.operatorSteer.requestedAt : null,
    snapshot.demoFallback.armed ? snapshot.demoFallback.armedAt : null,
  ].filter((value): value is string => value !== null);

  if (candidates.length === 0) {
    return null;
  }

  return candidates.reduce((oldest, candidate) => (compareTimestamps(candidate, oldest) < 0 ? candidate : oldest));
}

export function getAttentionMetadata(snapshot: CallSnapshot, now = Date.now()): AttentionMetadata {
  const required = snapshot.operatorSteer.pending || snapshot.demoFallback.armed;
  const source = snapshot.operatorSteer.pending && snapshot.demoFallback.armed
    ? "operator_steer+fallback"
    : snapshot.demoFallback.armed
      ? "fallback"
      : snapshot.operatorSteer.pending
        ? "operator_steer"
        : null;
  const startedAt = required ? getAttentionStartedAt(snapshot) : null;

  return {
    required,
    source,
    reason: snapshot.demoFallback.reason ?? snapshot.operatorSteer.lastReason,
    startedAt,
    ageMs: startedAt ? Math.max(0, now - new Date(startedAt).getTime()) : null,
  };
}
