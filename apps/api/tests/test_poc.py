from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def create_live_session() -> str:
    response = client.post("/api/poc/sessions", json={"operator_notes": "qa session"})
    assert response.status_code == 200
    session_id = response.json()["session_id"]
    started = client.post(f"/api/poc/sessions/{session_id}/presentation/start", json={})
    assert started.status_code == 200
    return session_id


def test_full_poc_controls_update_session_state() -> None:
    session_id = create_live_session()

    telephony = client.post(
        f"/api/poc/sessions/{session_id}/telephony-ingress",
        json={
            "provider": "signalwire",
            "caller": "+13125550123",
            "call_id": "sw-demo-42",
            "operator_notes": "VIP caller",
        },
    )
    assert telephony.status_code == 200

    openclaw = client.post(
        f"/api/poc/sessions/{session_id}/openclaw-session",
        json={"session_id": "oc-123", "label": "Demo supervisor"},
    )
    assert openclaw.status_code == 200

    slack = client.post(
        f"/api/poc/sessions/{session_id}/slack-steer",
        json={"command": "goto-slide", "slide_number": 2},
    )
    assert slack.status_code == 200
    assert slack.json()["current_slide"] == 2

    fallback = client.post(
        f"/api/poc/sessions/{session_id}/fallback",
        json={"enabled": True, "rationale": "operator wants manual control"},
    )
    assert fallback.status_code == 200
    assert fallback.json()["poc"]["fallback"]["enabled"] is True

    question = client.post(
        f"/api/poc/sessions/{session_id}/question",
        json={"question": "What happens after human steer?", "channel": "voice"},
    )
    assert question.status_code == 200

    session = client.get(f"/api/poc/sessions/{session_id}")
    assert session.status_code == 200
    body = session.json()
    assert body["poc"]["telephony"]["call_id"] == "sw-demo-42"
    assert body["poc"]["openclaw"]["session_id"] == "oc-123"
    assert body["poc"]["slack_steer"]["last_command"] == "goto-slide"
    assert body["poc"]["fallback"]["enabled"] is True
    event_kinds = [event["kind"] for event in body["recent_events"]]
    assert "telephony-ingress" in event_kinds
    assert "openclaw-session-attached" in event_kinds
    assert "slack-steer" in event_kinds
    assert "fallback-updated" in event_kinds
    assert body["transcript"][-1]["speaker"] == "agent"


def test_slack_ask_command_generates_answer() -> None:
    session_id = create_live_session()
    response = client.post(
        f"/api/poc/sessions/{session_id}/slack-steer",
        json={"command": "ask", "question": "Can we summarize the current state?"},
    )
    assert response.status_code == 200
    transcript = response.json()["transcript"]
    assert transcript[-2]["speaker"] == "operator"
    assert "current state" in transcript[-1]["text"].lower()


def test_unknown_session_returns_404() -> None:
    response = client.get("/api/poc/sessions/does-not-exist")
    assert response.status_code == 404
