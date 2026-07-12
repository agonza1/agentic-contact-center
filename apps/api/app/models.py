from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Event(BaseModel):
    at: str = Field(default_factory=utc_now)
    kind: str
    detail: str
    data: dict[str, Any] = Field(default_factory=dict)


class TelephonyIngress(BaseModel):
    provider: str = "signalwire"
    caller: str
    call_id: str
    operator_notes: str = ""


class OpenClawSessionAttach(BaseModel):
    session_id: str
    label: str


class SlackSteerCommand(BaseModel):
    command: Literal["pause", "resume", "goto-slide", "ask"]
    slide_number: int | None = None
    question: str | None = None
    requested_by: str = "slack-operator"


class FallbackUpdate(BaseModel):
    enabled: bool
    rationale: str
    armed_by: str = "operator"


class StartPresentationRequest(BaseModel):
    operator: str = "operator"


class SessionQuestion(BaseModel):
    question: str
    channel: Literal["voice", "text"] = "text"


class CreateSessionRequest(BaseModel):
    deck_name: str = "ClueCon 2026 Cancellation Rescue"
    operator_notes: str = ""


class PresentationSession(BaseModel):
    session_id: str = Field(default_factory=lambda: f"cue-{uuid4().hex[:8]}")
    deck_name: str = "ClueCon 2026 Cancellation Rescue"
    created_at: str = Field(default_factory=utc_now)
    presentation_status: Literal["draft", "live", "paused", "fallback"] = "draft"
    current_slide: int = 1
    slides: list[str] = Field(
        default_factory=lambda: [
            "Problem framing",
            "Human steer intervention",
            "Fallback closeout",
        ]
    )
    operator_notes: str = ""
    transcript: list[dict[str, str]] = Field(default_factory=list)
    recent_events: list[Event] = Field(default_factory=list)
    poc: dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def create(cls, request: CreateSessionRequest) -> "PresentationSession":
        session = cls(deck_name=request.deck_name, operator_notes=request.operator_notes)
        session.poc = {
            "architecture": {
                "telephony_ingress": "pending",
                "fastapi_session_state": "active",
                "pipecat_flow": "prototype-ready",
                "openclaw_per_call": "pending",
                "slack_steer": "pending",
                "demo_fallback": "disarmed",
            },
            "runtime_labels": {
                "telephony": "mocked_telephony",
                "media": "generated_media",
                "rtc_asr": "rtc_asr_blocked",
                "credentials": "mocked",
            },
            "telephony": {
                "ready": True,
                "provider": None,
                "caller": None,
                "call_id": None,
                "operator_notes": "",
            },
            "pipecat_flow": {
                "ready": True,
                "prototype": "slide-aware-tool-contract",
                "tool_coverage": [
                    "pause_presentation",
                    "resume_presentation",
                    "goto_slide",
                    "answer_question",
                    "request_human_steer",
                ],
            },
            "openclaw": {
                "attached": False,
                "session_id": None,
                "label": None,
            },
            "slack_steer": {
                "last_command": None,
                "actions": ["pause", "resume", "goto-slide", "ask"],
                "operator": None,
            },
            "fallback": {
                "enabled": False,
                "rationale": "",
                "armed_by": None,
            },
        }
        session.recent_events.append(Event(kind="session-created", detail="Presentation session created."))
        return session
