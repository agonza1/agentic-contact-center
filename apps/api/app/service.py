from __future__ import annotations

from typing import Any

from .models import (
    CreateSessionRequest,
    Event,
    FallbackUpdate,
    OpenClawSessionAttach,
    PresentationSession,
    SessionQuestion,
    SlackSteerCommand,
    StartPresentationRequest,
    TelephonyIngress,
)


class SessionNotFoundError(KeyError):
    pass


class POCSessionService:
    def __init__(self) -> None:
        self._sessions: dict[str, PresentationSession] = {}

    def create_session(self, request: CreateSessionRequest) -> PresentationSession:
        session = PresentationSession.create(request)
        self._sessions[session.session_id] = session
        return session

    def get_session(self, session_id: str) -> PresentationSession:
        session = self._sessions.get(session_id)
        if session is None:
            raise SessionNotFoundError(session_id)
        return session

    def start_presentation(self, session_id: str, request: StartPresentationRequest) -> PresentationSession:
        session = self.get_session(session_id)
        session.presentation_status = "live"
        self._append_event(session, "presentation-started", f"Presentation started by {request.operator}.")
        return session

    def record_telephony_ingress(self, session_id: str, request: TelephonyIngress) -> PresentationSession:
        session = self.get_session(session_id)
        telephony = session.poc["telephony"]
        telephony.update(
            {
                "provider": request.provider,
                "caller": request.caller,
                "call_id": request.call_id,
                "operator_notes": request.operator_notes,
            }
        )
        session.poc["architecture"]["telephony_ingress"] = "connected"
        session.poc["runtime_labels"].update(
            {
                "telephony": "signalwire_live" if request.provider == "signalwire" else "local_sip",
                "media": "live_capture",
                "rtc_asr": "rtc_asr_blocked",
                "credentials": "signalwire_live" if request.provider == "signalwire" else "mocked",
            }
        )
        self._append_event(
            session,
            "telephony-ingress",
            f"Inbound demo call registered from {request.caller} via {request.provider}.",
            request.model_dump(),
        )
        return session

    def attach_openclaw_session(self, session_id: str, request: OpenClawSessionAttach) -> PresentationSession:
        session = self.get_session(session_id)
        session.poc["openclaw"].update(
            {"attached": True, "session_id": request.session_id, "label": request.label}
        )
        session.poc["architecture"]["openclaw_per_call"] = "attached"
        self._append_event(
            session,
            "openclaw-session-attached",
            f"OpenClaw per-call session {request.label} attached.",
            request.model_dump(),
        )
        return session

    def apply_slack_steer(self, session_id: str, request: SlackSteerCommand) -> PresentationSession:
        session = self.get_session(session_id)
        action_result: dict[str, Any] = {"command": request.command}
        if request.command == "pause":
            session.presentation_status = "paused"
        elif request.command == "resume":
            session.presentation_status = "live"
        elif request.command == "goto-slide":
            if request.slide_number is None:
                raise ValueError("slide_number is required for goto-slide")
            session.current_slide = max(1, min(request.slide_number, len(session.slides)))
            action_result["current_slide"] = session.current_slide
        elif request.command == "ask":
            if not request.question:
                raise ValueError("question is required for ask")
            response = self._build_answer(session, request.question)
            session.transcript.append({"speaker": "operator", "text": request.question})
            session.transcript.append({"speaker": "agent", "text": response})
            action_result["response"] = response

        session.poc["slack_steer"].update(
            {"last_command": request.command, "operator": request.requested_by}
        )
        session.poc["architecture"]["slack_steer"] = "active"
        self._append_event(
            session,
            "slack-steer",
            f"Slack steer command `{request.command}` received.",
            {**request.model_dump(exclude_none=True), "result": action_result},
        )
        return session

    def set_fallback(self, session_id: str, request: FallbackUpdate) -> PresentationSession:
        session = self.get_session(session_id)
        session.poc["fallback"].update(
            {
                "enabled": request.enabled,
                "rationale": request.rationale,
                "armed_by": request.armed_by,
            }
        )
        session.presentation_status = "fallback" if request.enabled else "live"
        session.poc["architecture"]["demo_fallback"] = "armed" if request.enabled else "disarmed"
        self._append_event(
            session,
            "fallback-updated",
            f"Demo fallback {'enabled' if request.enabled else 'disabled'} by {request.armed_by}.",
            request.model_dump(),
        )
        return session

    def answer_question(self, session_id: str, request: SessionQuestion) -> PresentationSession:
        session = self.get_session(session_id)
        answer = self._build_answer(session, request.question)
        session.transcript.append({"speaker": request.channel, "text": request.question})
        session.transcript.append({"speaker": "agent", "text": answer})
        self._append_event(
            session,
            "question-answered",
            f"{request.channel.title()} question answered on slide {session.current_slide}.",
            {"question": request.question, "answer": answer},
        )
        return session

    def _append_event(self, session: PresentationSession, kind: str, detail: str, data: dict[str, Any] | None = None) -> None:
        session.recent_events.insert(0, Event(kind=kind, detail=detail, data=data or {}))
        del session.recent_events[12:]

    def _build_answer(self, session: PresentationSession, question: str) -> str:
        slide_title = session.slides[session.current_slide - 1]
        fallback = session.poc["fallback"]
        fallback_clause = " Manual fallback is armed." if fallback["enabled"] else " Live voice remains active."
        return (
            f"Slide {session.current_slide} covers {slide_title.lower()}. "
            f"Answering: {question.strip()}."
        ) + fallback_clause


service = POCSessionService()
