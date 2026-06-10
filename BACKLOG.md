# BACKLOG

## cluecon-presentation-2026

Canonical backlog for the GitHub implementation lane.

Labels: `cluecon-presentation-2026`, `poc`, `demo`

### CUE-001 POC architecture
Acceptance criteria:
- Document the end-to-end POC shape in repo-local terms: telephony ingress, session state, Pipecat flow, OpenClaw per-call session attach, Slack steer rail, and demo fallback.
- Keep the scaffold explicit about future seams.
Status: implemented in merged PR `#9` and the scaffold docs under `docs/`.

### CUE-002 Telephony ingress
Acceptance criteria:
- Provide a local ingress endpoint that can register an inbound demo call against a presentation session.
- Persist provider, caller transcript, call id, and seeded scenario metadata in canonical session evidence.
Status: implemented on issue `#3` via `POST /api/demo/start`, `POST /api/calls/:callId/caller-turn`, `GET /api/calls/:callId`, and the in-memory session store in `src/core/inMemoryTelephonyIngress.ts`.

### CUE-003 Pipecat Flow prototype
Acceptance criteria:
- Keep the slide-aware Pipecat tool contract active for the demo session.
- Expose Pipecat prototype readiness and tool coverage through live status.
Status: pending in the TypeScript scaffold.

### CUE-004 OpenClaw per-call session integration
Acceptance criteria:
- Attach an OpenClaw session id/label to a live demo call.
- Surface the attached per-call session in operator-visible state.
Status: pending in the TypeScript scaffold.

### CUE-005 Slack human-steer path
Acceptance criteria:
- Provide a human-steer endpoint that records a Slack-style command and can trigger a lightweight action.
- Support at least pause, resume, goto-slide, and ask operations.
Status: pending in the TypeScript scaffold.

### CUE-006 Demo fallback
Acceptance criteria:
- Allow operators to explicitly arm/disarm manual fallback for the demo.
- Keep fallback state and rationale visible in operator state.
Status: pending in the TypeScript scaffold.

## QA handoff for issue #3

- Run `npm test` from the repo root.
- Start the server with `npm start`.
- `POST /api/demo/start` should return `201` with a stable `demo-call-0001` style id and seeded scenario metadata.
- `POST /api/calls/:callId/caller-turn` should append ordered caller transcript turns.
- `GET /api/calls/:callId` should return the current snapshot, flow state, transcript, event trail, and latency budgets.
- `GET /api/calls/does-not-exist` should return `404` and blank caller-turn text should return `400`.
