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
Status: implemented on issue `#4` via deterministic flow state transitions, policy-hold gating, scripted caller turns, and Pipecat readiness/tool coverage in `GET /health` plus call snapshots.

### CUE-004 OpenClaw per-call session integration
Acceptance criteria:
- Attach an OpenClaw session id/label to a live demo call.
- Surface the attached per-call session in operator-visible state.
Status: implemented in merged PR `#13` with mock OpenClaw session metadata, ordered event trail visibility, and seeded latency marks exposed in call snapshots.

### CUE-005 Slack human-steer path
Acceptance criteria:
- Provide a human-steer endpoint that records a Slack-style command and can trigger a lightweight action.
- Support at least pause, resume, goto-slide, and ask operations.
Status: in progress on branch `issue-6-operator-steer-path` with a mocked HTTP steer endpoint, Slack-style pause/resume/goto-slide/ask actions, and deterministic approve/escalate coverage.

### CUE-006 Demo fallback
Acceptance criteria:
- Allow operators to explicitly arm/disarm manual fallback for the demo.
- Keep fallback state and rationale visible in operator state.
Status: pending in the TypeScript scaffold.

## QA handoff for issue #4

- Run `npm test` from the repo root.
- Start the server with `npm start`.
- `POST /api/demo/start` should return `201` with Pipecat readiness metadata and `demo-call-0001` style ids.
- Post the four seeded caller turns from `README.md` to `POST /api/calls/:callId/caller-turn` in order.
- After the second turn, the call snapshot should be in `policy_hold` and the latest agent turn should not promise a billing credit.
- After the fourth turn, `GET /api/calls/:callId` should show `wrap`, full transcript history, script completion, and the operator-steer events.
