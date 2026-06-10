from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .models import (
    CreateSessionRequest,
    FallbackUpdate,
    OpenClawSessionAttach,
    SessionQuestion,
    SlackSteerCommand,
    StartPresentationRequest,
    TelephonyIngress,
)
from .service import SessionNotFoundError, service

BASE_DIR = Path(__file__).resolve().parents[3]
WEB_DIR = BASE_DIR / "apps" / "web" / "src"

app = FastAPI(title="Agentic Contact Center POC API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "demo": "cluecon-presentation-2026",
        "subsystems": {
            "telephony_ingress": True,
            "fastapi_session_state": True,
            "pipecat_flow": True,
            "openclaw_per_call": True,
            "slack_steer": True,
            "demo_fallback": True,
        },
    }


@app.get("/")
def root() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


@app.post("/api/poc/sessions")
def create_session(request: CreateSessionRequest):
    return service.create_session(request)


@app.get("/api/poc/sessions/{session_id}")
def get_session(session_id: str):
    return _run_or_404(service.get_session, session_id)


@app.post("/api/poc/sessions/{session_id}/presentation/start")
def start_presentation(session_id: str, request: StartPresentationRequest):
    return _run_or_404(service.start_presentation, session_id, request)


@app.post("/api/poc/sessions/{session_id}/telephony-ingress")
def telephony_ingress(session_id: str, request: TelephonyIngress):
    return _run_or_404(service.record_telephony_ingress, session_id, request)


@app.post("/api/poc/sessions/{session_id}/openclaw-session")
def openclaw_session(session_id: str, request: OpenClawSessionAttach):
    return _run_or_404(service.attach_openclaw_session, session_id, request)


@app.post("/api/poc/sessions/{session_id}/slack-steer")
def slack_steer(session_id: str, request: SlackSteerCommand):
    try:
        return _run_or_404(service.apply_slack_steer, session_id, request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/poc/sessions/{session_id}/fallback")
def fallback(session_id: str, request: FallbackUpdate):
    return _run_or_404(service.set_fallback, session_id, request)


@app.post("/api/poc/sessions/{session_id}/question")
def question(session_id: str, request: SessionQuestion):
    return _run_or_404(service.answer_question, session_id, request)


def _run_or_404(handler, session_id: str, request=None):
    try:
        return handler(session_id) if request is None else handler(session_id, request)
    except SessionNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown session: {exc.args[0]}") from exc
