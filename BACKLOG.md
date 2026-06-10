# BACKLOG

## cluecon-presentation-2026

Canonical backlog for the local ClueCon POC lane until GitHub exists.

Labels: `cluecon-presentation-2026`, `poc`, `demo`

### CUE-001 POC architecture
Acceptance criteria:
- Document the end-to-end POC shape in repo-local terms: telephony ingress, FastAPI session state, Pipecat flow, OpenClaw per-call session attach, Slack steer rail, and demo fallback.
- Keep the live session payload able to report those POC subsystems in one object for operator and QA review.
Status: implemented in [`docs/cluecon-poc-architecture.md`](./docs/cluecon-poc-architecture.md) and the live session `poc` envelope returned by `GET /api/poc/sessions/{session_id}`.

### CUE-002 Telephony ingress
Acceptance criteria:
- Provide a local ingress endpoint that can register an inbound demo call against a presentation session.
- Persist provider, caller, call id, and operator notes in canonical session evidence.
Status: implemented at `POST /api/poc/sessions/{session_id}/telephony-ingress`.

### CUE-003 Pipecat Flow prototype
Acceptance criteria:
- Keep the slide-aware Pipecat tool contract active for the demo session.
- Expose Pipecat prototype readiness and tool coverage through the session live status.
Status: implemented through `poc.pipecat_flow` in session state plus the slide-aware control actions served by FastAPI.

### CUE-004 OpenClaw per-call session integration
Acceptance criteria:
- Attach an OpenClaw session id/label to a live presentation session.
- Surface the attached per-call session in operator-visible state.
Status: implemented at `POST /api/poc/sessions/{session_id}/openclaw-session` and shown in the live-ops UI.

### CUE-005 Slack human-steer path
Acceptance criteria:
- Provide a human-steer endpoint that records a Slack-style command and can trigger a lightweight action.
- Support at least `pause`, `resume`, `goto-slide`, and `ask` operations.
Status: implemented at `POST /api/poc/sessions/{session_id}/slack-steer` and wired into the live-ops UI for `goto-slide`.

### CUE-006 Demo fallback
Acceptance criteria:
- Allow operators to explicitly arm/disarm manual fallback for the demo.
- Keep fallback state and rationale visible in the live operator view.
Status: implemented at `POST /api/poc/sessions/{session_id}/fallback` and shown in the live-ops UI.

## QA handoff

Before closing the card, QA should verify:
- Install the API deps from [`apps/api/requirements.txt`](./apps/api/requirements.txt) and launch `uvicorn app.main:app --reload` from `apps/api`.
- Open `http://127.0.0.1:8000/`, create a session, and start the presentation.
- In Live ops, click `Simulate telephony ingress`, `Attach OpenClaw session`, `Slack jump to slide 2`, and `Enable fallback`.
- Confirm the `poc` sections update, the slide moves to slide 2 after the Slack jump, and fallback shows as enabled.
- Ask a text question from the UI and confirm transcript + recent events continue updating after the POC controls are used.
- Confirm recent events include telephony, OpenClaw, Slack steer, fallback, and question-answer entries.

Status: ready for QA after local API smoke tests pass.

## Remaining work after this lane

- Replace simulated telephony ingress with a real provider webhook.
- Replace the local Slack-style control path with actual Slack transport.
- Add a dedicated Pipecat runtime adapter instead of session-state-only readiness metadata.
- Add persistence/auth before exposing the operator view beyond local demo use.
