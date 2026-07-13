# ClueCon POC Architecture

This repo now carries a runnable local proof of concept for the `cluecon-presentation-2026` demo lane.

## End-to-end shape

1. Telephony ingress enters through `POST /api/demo/start` and `POST /api/calls/:callId/caller-turn`, recording canonical caller evidence on the in-memory call session.
2. The TypeScript HTTP server owns the live call state and returns one operator-visible object through `GET /api/calls/:callId`.
3. Pipecat Flow is exposed as the local `pipecat_local_runtime` path in `pipecatFlow`, including readiness, runtime engine, mocked credentials mode, script progress, and tool coverage for slide-aware actions.
4. A per-call agent evidence envelope is attached during `POST /api/demo/start` so transcript, tool, and artifact references stay correlated.
5. Slack-style human steer enters through `POST /api/calls/:callId/operator-steer` and can pause, resume, jump slides, ask for guidance, approve a safe response, escalate to a human, take over, or end the call.
6. Demo fallback enters through `POST /api/calls/:callId/fallback` and triggers a fail-closed human handoff for `tool_timeout` or `runtime_failure`, while `operator-steer` can also arm or disarm manual fallback visibility.

## Live session envelope

The API keeps all POC subsystem visibility in one top-level call snapshot:

- `session`: call id, provider ids, and attached agent-session evidence
- `scenario`: demo mode, policy profile, fallback mode, and operator channel
- `pipecatFlow`: readiness, prototype mode, script progress, and tool coverage
- `operatorSteer`: last command state, rationale, and timestamps
- `demoFallback`: enabled state, rationale, mode, and source
- `events` plus `latencyMarks`: ordered evidence for QA and operator review

## Supporting routes

- `POST /api/demo/start`
- `POST /api/calls/:callId/caller-turn`
- `POST /api/calls/:callId/operator-steer`
- `POST /api/calls/:callId/fallback`
- `GET /api/calls/:callId`
- `GET /health`
- `GET /api/calls/:callId/artifacts`
- `GET /api/calls/:callId/proof`
- `GET /api/calls/:callId/transcript`
- `GET /api/calls/:callId/events`
- `GET /api/calls/:callId/latency`
