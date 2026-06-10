# ClueCon POC Architecture

This repo now carries a runnable local proof of concept for the `cluecon-presentation-2026` demo lane.

## End-to-end shape

1. Telephony ingress enters through `POST /api/poc/sessions/{session_id}/telephony-ingress` and records canonical caller evidence on the presentation session.
2. FastAPI owns the live session state and returns one operator-visible object through `GET /api/poc/sessions/{session_id}`.
3. Pipecat Flow is represented as an always-on prototype contract in `poc.pipecat_flow`, including readiness and tool coverage for slide-aware actions.
4. OpenClaw per-call session integration enters through `POST /api/poc/sessions/{session_id}/openclaw-session` and attaches operator session metadata.
5. Slack human steer enters through `POST /api/poc/sessions/{session_id}/slack-steer` and can pause, resume, jump slides, or ask a question.
6. Demo fallback enters through `POST /api/poc/sessions/{session_id}/fallback` and visibly arms or disarms manual operator control.

## Live session envelope

The API keeps all POC subsystem visibility in one `poc` object:

- `architecture`: subsystem status summary for QA and operators
- `telephony`: provider, caller, call id, and operator notes
- `pipecat_flow`: readiness, prototype mode, and tool coverage
- `openclaw`: attached per-call session id/label
- `slack_steer`: last command, supported actions, and operator identity
- `fallback`: enabled state, rationale, and actor

## Supporting routes

- `POST /api/poc/sessions`
- `POST /api/poc/sessions/{session_id}/presentation/start`
- `POST /api/poc/sessions/{session_id}/question`
- `GET /health`
