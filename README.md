# Agentic Contact Center

Current GitHub implementation track for the ClueCon 2026 POC lane.

The active scaffold is the TypeScript HTTP server under `src/`. It now covers:

- config-backed `GET /health`
- mocked telephony ingress bootstrap at `POST /api/demo/start`
- in-memory caller transcript append at `POST /api/calls/:callId/caller-turn`
- current call snapshot lookup at `GET /api/calls/:callId`
- deterministic Pipecat-style flow state, policy hold behavior, operator-steer control, and tool coverage in the live call snapshot
- OpenClaw-style per-call session envelope plus seeded latency/event trail visibility in the live call snapshot

## Run locally

```bash
npm install
npm test
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

## Current slice status

- CUE-001: scaffold and architecture baseline merged in PR `#9`
- CUE-002 / issue `#3`: implemented on PR `#10` with mocked telephony ingress and in-memory call session bootstrap
- CUE-003 / issue `#4`: implemented on the current branch with deterministic Pipecat-style flow state, safe policy hold behavior, and live tool coverage
- CUE-004 / issue `#5`: implemented in merged PR `#13` with mock OpenClaw session metadata, ordered event trail visibility, and seeded latency marks
- CUE-005 / issue `#6`: in progress on the current branch with a mocked `POST /api/calls/:callId/operator-steer` path with Slack-style pause/resume/goto-slide/ask operations plus safe approve/escalate outcomes
- CUE-006: not yet implemented in the TypeScript scaffold

## Note on legacy prototype

`apps/api/` and `apps/web/` contain an older local FastAPI demo prototype. They are useful reference material, but they are not the authoritative implementation status for the current GitHub issue sequence.
