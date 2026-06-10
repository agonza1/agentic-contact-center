# Agentic Contact Center

Runnable local ClueCon 2026 POC scaffold for the presentation lane:

`SignalWire -> FastAPI session state -> Pipecat Flow prototype -> OpenClaw -> Slack human steer -> Demo fallback`

## What is implemented

- In-memory FastAPI presentation sessions for the local demo
- POC subsystem envelope under `session.poc`
- Telephony ingress evidence capture
- Pipecat prototype readiness and tool coverage reporting
- OpenClaw per-call session attach
- Slack-style human steer actions: `pause`, `resume`, `goto-slide`, `ask`
- Manual demo fallback arm/disarm
- Minimal live-ops page for local QA and demo operation

## Run locally

```bash
cd apps/api
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Then open `http://127.0.0.1:8000/`.

## Test

```bash
cd apps/api
pytest
```

## Key routes

- `POST /api/poc/sessions`
- `GET /api/poc/sessions/{session_id}`
- `POST /api/poc/sessions/{session_id}/presentation/start`
- `POST /api/poc/sessions/{session_id}/telephony-ingress`
- `POST /api/poc/sessions/{session_id}/openclaw-session`
- `POST /api/poc/sessions/{session_id}/slack-steer`
- `POST /api/poc/sessions/{session_id}/fallback`
- `POST /api/poc/sessions/{session_id}/question`

## Canonical backlog

Detailed acceptance criteria and QA handoff remain in [`BACKLOG.md`](./BACKLOG.md) until GitHub issue tracking exists.
