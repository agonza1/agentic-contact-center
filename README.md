# Agentic Contact Center

Current GitHub implementation track for the ClueCon 2026 POC lane.

The active scaffold is the TypeScript HTTP server under `src/`. It now covers:

- config-backed `GET /health`
- mocked telephony ingress bootstrap at `POST /api/demo/start`
- in-memory caller transcript append at `POST /api/calls/:callId/caller-turn`
- current call snapshot lookup at `GET /api/calls/:callId`
- active call index lookup at `GET /api/calls` with optional `?flowState=policy_hold`, `?pendingOperatorSteer=true`, `?fallbackArmed=true`, `?attentionRequired=true`, `?providerCallId=mock-sw-call-001-0001`, `?openclawSessionId=openclaw-call-0001`, `?openclawSessionLabel=cluecon-demo/demo-call-0001`, and `?openclawSessionRef=...` filtering when the operator only has a single OpenClaw session handle, plus oldest-attention queue summary metadata including provider and OpenClaw session id/label references, flow state, and the current attention reason/source
- deterministic Pipecat-style flow state, policy hold behavior, operator-steer control, and tool coverage in the live call snapshot
- OpenClaw-style per-call session envelope plus seeded latency/event trail visibility in the live call snapshot

## Run locally

```bash
npm install
npm test
npm run proof -- --out artifacts/demo-proof.json --latest-out artifacts/demo-proof-latest.json
npm start
```

The server listens on `http://localhost:8026` by default.

## Seeded cancellation-rescue script

Post these caller turns in order to exercise the deterministic issue `#4` prototype:

1. `I want to cancel my policy today.`
2. `The renewal increase is too high.`
3. `Okay, what safe options can you review for me?`
4. `Thanks, please note that follow-up and close the call.`

The prototype will pause at `policy_hold` before any risky retention offer and then resume with a safe deterministic response that never promises a billing credit by default.

## Proof Runner

Run the text-first proof harness to execute the critical demo flows and save both a reviewable artifact and a stable latest pointer:

```bash
npm run proof -- --out artifacts/demo-proof.json --latest-out artifacts/demo-proof-latest.json
```

The command:

- runs the seeded scripted path through policy hold, operator steer, and wrap
- runs the fail-closed `tool_timeout` fallback path
- writes JSON proof output with transcript, event trail, and latency marks for both scenarios
- adds a top-level `summary` block so reviewers can inspect outcomes, turn counts, fallback reason, event types, and latency stages quickly
- optionally refreshes a stable latest artifact path for QA handoff or PR review attachments

If `--out` is omitted, the proof file is written to `artifacts/demo-proof-<timestamp>.json`. Add `--latest-out artifacts/demo-proof-latest.json` to keep a deterministic handoff file updated alongside timestamped runs.

For a step-by-step QA handoff flow, artifact inspection checklist, and example commands, use [docs/demo-proof-runbook.md](docs/demo-proof-runbook.md).

## Current slice status

- CUE-001: scaffold and architecture baseline merged in PR `#9`
- CUE-002 / issue `#3`: implemented on PR `#10` with mocked telephony ingress and in-memory call session bootstrap
- CUE-003 / issue `#4`: implemented in merged PR `#12` with deterministic Pipecat-style flow state, safe policy hold behavior, and live tool coverage
- CUE-004 / issue `#5`: implemented in merged PR `#13` with mock OpenClaw session metadata, ordered event trail visibility, and seeded latency marks
- CUE-005 / issue `#6`: implemented with a mocked `POST /api/calls/:callId/operator-steer` path with Slack-style pause/resume/goto-slide/ask operations plus safe approve/escalate outcomes
- CUE-006 / issue `#7`: implemented with `POST /api/calls/:callId/fallback`, `tool_timeout` fail-closed handling, explicit fallback rationale in `GET /api/calls/:callId`, and proof/test coverage for safe human escalation
- CUE-007 / issue `#8`: implemented with `npm run proof`, serializable JSON evidence for scripted and fallback paths, and a repo-local QA runbook for reproducible handoff

## Note on legacy prototype

`apps/api/` and `apps/web/` contain an older local FastAPI demo prototype. They are useful reference material, but they are not the authoritative implementation status for the current GitHub issue sequence.
