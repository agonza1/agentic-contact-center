# ClueCon POC Architecture

This repo now carries a runnable local proof of concept for the `cluecon-presentation-2026` demo lane.

## End-to-end shape

1. Telephony ingress enters through `POST /api/demo/start` and `POST /api/calls/:callId/caller-turn`, recording canonical caller evidence on the in-memory call session.
2. The TypeScript HTTP server owns the live call state and returns one operator-visible object through `GET /api/calls/:callId`.
3. Pipecat Flow is represented as an always-on prototype contract in `pipecatFlow`, including readiness and tool coverage for slide-aware actions.
4. OpenClaw per-call session integration is attached during `POST /api/demo/start` and stored on `session.openclawSession`.
5. Slack-style human steer enters through `POST /api/calls/:callId/operator-steer` and can pause, resume, jump slides, ask for guidance, approve a safe response, or escalate to a human.
6. Demo fallback enters through `POST /api/calls/:callId/fallback` and triggers a fail-closed human handoff for `tool_timeout`, while `operator-steer` can also arm or disarm manual fallback visibility.

## Live session envelope

The API keeps all POC subsystem visibility in one top-level call snapshot:

- `session`: call id, provider ids, and attached OpenClaw session id/label
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
