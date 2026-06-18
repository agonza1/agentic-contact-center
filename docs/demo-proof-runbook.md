# Demo proof runbook

Use this runbook when you need a lightweight QA handoff artifact for the ClueCon cancellation-rescue demo.

## Generate proof

From the repo root:

```bash
npm install
npm test
npm run proof -- --out artifacts/demo-proof.json --latest-out artifacts/demo-proof-latest.json
```

The proof command boots the local server on an ephemeral port, verifies a healthy `/health` response, runs both the seeded scripted flow and the fail-closed fallback flow, then writes reviewable JSON artifacts under `artifacts/`.

## What to inspect

Open `artifacts/demo-proof.json` or `artifacts/demo-proof-latest.json` and confirm:

- `summary.healthOk` is `true`
- `summary.scripted.outcome` is `scripted_wrap_complete`
- `summary.scripted.flowState` is `wrap`
- `summary.scripted.latencyStages` includes `policy_hold_entered`
- `summary.fallback.outcome` is `fail_closed_handoff`
- `summary.fallback.mode` is `tool_timeout`
- `summary.fallback.reason` is `pipecat tool exceeded latency budget`
- `summary.fallback.eventTypes` includes `human_handoff_started`
- `summary.queueAttention.attentionRequired` is `1`
- `proofContract.queueAttentionFilter` scopes queue proof to `attentionRequired=true&attentionReason=pipecat%20tool%20exceeded%20latency%20budget`
- `summary.queueAttention.oldestAttentionSource` is `fallback`
- `summary.queueAttention.oldestAttentionFlowState` is `wrap`
- `summary.queueAttention.oldestAttentionAgeMs` is a non-null number for stale-queue polling
- `summary.queueAttention.oldestAttentionStartedAt` is an ISO timestamp for the oldest attention item

When generating the proof through Docker Compose on Linux, run `LOCAL_UID=$(id -u) LOCAL_GID=$(id -g) docker compose run --rm proof` so the bind-mounted `artifacts/` files stay writable by the invoking host user.

For deeper review, the full artifact also contains:

- transcript history for each scenario
- ordered event trail entries
- seeded latency marks
- final call snapshots for scripted wrap and fallback handoff

## QA handoff notes

Attach the stable `artifacts/demo-proof-latest.json` file to PR review or demo notes when you want a deterministic pointer. Keep timestamped artifacts when you need a point-in-time audit trail for multiple runs.
