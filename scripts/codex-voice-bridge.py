#!/usr/bin/env python3
"""Local Codex OAuth bridge for the ACC voice demo.

The bridge owns ChatGPT/Codex authentication. ACC and the browser receive only
device-login metadata and a typed conversation proposal; OAuth credentials
never cross this HTTP boundary.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


REPO_ROOT = Path(__file__).resolve().parents[1]
LOCAL_RUNTIME_PATH = REPO_ROOT / ".pipecat-runtime"
if LOCAL_RUNTIME_PATH.exists():
    sys.path.insert(0, str(LOCAL_RUNTIME_PATH))

PINNED_MODEL = "gpt-5.4-mini"
MAX_BODY_BYTES = 64 * 1024
MAX_PROMPT_CHARS = 12_000
VOICE_THREAD_CONFIG: dict[str, Any] = {
    "apps": {"_default": {"enabled": False, "default_tools_enabled": False}},
    "features": {
        "shell_tool": False,
        "unified_exec": False,
        "skill_mcp_dependency_install": False,
    },
    "tools": {"view_image": False, "web_search": False},
    "web_search": "disabled",
}
VOICE_DEVELOPER_INSTRUCTIONS = " ".join(
    (
        "You are the conversational reasoning component for ACC SIP extension 8600.",
        "Return only a JSON object with exactly these fields: schemaVersion, intent, requestedOperation, needsClarification, slots, and proposedReply.",
        "schemaVersion must be 1.",
        "intent must be cancellation, billing, account_update, service_information, human_handoff, or unsupported.",
        "requestedOperation must respectively be cancel_policy, review_billing, update_account, get_service_information, handoff, or null.",
        "needsClarification is true only for unsupported; slots contains exactly reason, which is a string or null.",
        "proposedReply is one or two short sentences suitable for TTS. Do not use Markdown or JSON fences.",
        "Do not use tools, inspect files, run commands, or discuss software implementation.",
        "Do not promise discounts, refunds, cancellation completion, policy changes, or regulated advice.",
        "When a request requires approval, account access, or a human decision, offer a safe handoff.",
        "Ask at most one focused follow-up question.",
        "This routing slice does not verify identity, authorize an operation, or execute a business action.",
    )
)


def _safe_error(error: BaseException | str) -> str:
    text = str(error).strip() or "codex_bridge_error"
    text = re.sub(r"Bearer\s+[A-Za-z0-9._-]+", "Bearer [redacted]", text)
    text = re.sub(r"sk-[A-Za-z0-9._-]+", "sk-[redacted]", text)
    return text[:500]


def _account_summary(account_response: Any) -> dict[str, Any]:
    account_wrapper = getattr(account_response, "account", None)
    account = getattr(account_wrapper, "root", None)
    if account is None:
        return {"authenticated": False, "accountType": None, "planType": None}
    account_type = getattr(account, "type", None)
    plan_type = getattr(account, "plan_type", None)
    if hasattr(plan_type, "value"):
        plan_type = plan_type.value
    return {
        "authenticated": True,
        "accountType": str(account_type) if account_type else None,
        "planType": str(plan_type) if plan_type else None,
    }


@dataclass
class LoginAttempt:
    login_id: str
    verification_url: str
    user_code: str
    status: str = "pending"
    error: str | None = None

    def public(self) -> dict[str, Any]:
        return {
            "loginId": self.login_id,
            "verificationUrl": self.verification_url,
            "userCode": self.user_code,
            "status": self.status,
            "error": self.error,
        }


@dataclass
class CallThread:
    thread: Any
    lock: threading.Lock = field(default_factory=threading.Lock)


class CodexVoiceBridge:
    def __init__(self, workspace: Path) -> None:
        from openai_codex import ApprovalMode, Codex, Sandbox
        from openai_codex.types import ReasoningEffort

        workspace.mkdir(parents=True, exist_ok=True)
        self.workspace = workspace
        self.approval_mode = ApprovalMode.deny_all
        self.reasoning_effort = ReasoningEffort.low
        self.sandbox = Sandbox.read_only
        self.codex = Codex()
        self.logins: dict[str, LoginAttempt] = {}
        self.calls: dict[str, CallThread] = {}
        self.state_lock = threading.Lock()

    def close(self) -> None:
        self.codex.close()

    def auth_status(self) -> dict[str, Any]:
        try:
            summary = _account_summary(self.codex.account())
            return {"ok": True, "model": PINNED_MODEL, **summary}
        except Exception as error:  # SDK/runtime error is intentionally fail-closed.
            return {
                "ok": False,
                "model": PINNED_MODEL,
                "authenticated": False,
                "accountType": None,
                "planType": None,
                "error": _safe_error(error),
            }

    def start_device_login(self) -> tuple[int, dict[str, Any]]:
        status = self.auth_status()
        if status.get("authenticated"):
            return HTTPStatus.OK, {**status, "status": "connected"}
        try:
            handle = self.codex.login_chatgpt_device_code()
            attempt = LoginAttempt(handle.login_id, handle.verification_url, handle.user_code)
            with self.state_lock:
                self.logins[attempt.login_id] = attempt
            threading.Thread(target=self._wait_for_login, args=(handle, attempt), daemon=True).start()
            return HTTPStatus.ACCEPTED, {"ok": True, "model": PINNED_MODEL, **attempt.public()}
        except Exception as error:
            return HTTPStatus.BAD_GATEWAY, {"ok": False, "error": _safe_error(error), "model": PINNED_MODEL}

    def _wait_for_login(self, handle: Any, attempt: LoginAttempt) -> None:
        try:
            completed = handle.wait()
            success = bool(getattr(completed, "success", True))
            attempt.status = "connected" if success else "failed"
            if not success:
                attempt.error = "codex_device_login_failed"
        except Exception as error:
            attempt.status = "failed"
            attempt.error = _safe_error(error)

    def login_status(self, login_id: str) -> tuple[int, dict[str, Any]]:
        with self.state_lock:
            attempt = self.logins.get(login_id)
        if attempt is None:
            return HTTPStatus.NOT_FOUND, {"ok": False, "error": "codex_login_not_found", "model": PINNED_MODEL}
        payload = {"ok": attempt.status != "failed", "model": PINNED_MODEL, **attempt.public()}
        if attempt.status == "connected":
            payload.update(self.auth_status())
        return HTTPStatus.OK, payload

    def _call_thread(self, call_id: str) -> CallThread:
        with self.state_lock:
            existing = self.calls.get(call_id)
            if existing is not None:
                return existing
            thread = self.codex.thread_start(
                approval_mode=self.approval_mode,
                config=VOICE_THREAD_CONFIG,
                cwd=str(self.workspace),
                developer_instructions=VOICE_DEVELOPER_INSTRUCTIONS,
                ephemeral=True,
                model=PINNED_MODEL,
                sandbox=self.sandbox,
                service_name="acc-voice-demo",
            )
            created = CallThread(thread=thread)
            self.calls[call_id] = created
            return created

    def release_call(self, call_instance_id: str) -> bool:
        with self.state_lock:
            return self.calls.pop(call_instance_id, None) is not None

    def respond(self, body: Any) -> tuple[int, dict[str, Any]]:
        if not isinstance(body, dict):
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "json_object_required", "model": PINNED_MODEL}
        call_id = body.get("callId")
        call_instance_id = body.get("callInstanceId") or call_id
        model = body.get("model")
        prompt = body.get("prompt")
        if not isinstance(call_id, str) or not call_id.strip() or len(call_id) > 200:
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "call_id_invalid", "model": PINNED_MODEL}
        if not isinstance(call_instance_id, str) or not call_instance_id.strip() or len(call_instance_id) > 300:
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "call_instance_id_invalid", "model": PINNED_MODEL}
        if model != PINNED_MODEL:
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "codex_model_must_be_gpt-5.4-mini", "model": PINNED_MODEL}
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT_CHARS:
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "prompt_invalid", "model": PINNED_MODEL}
        if not self.auth_status().get("authenticated"):
            return HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "codex_oauth_login_required", "model": PINNED_MODEL}
        try:
            call = self._call_thread(call_instance_id.strip())
            with call.lock:
                result = call.thread.run(
                    prompt.strip(),
                    approval_mode=self.approval_mode,
                    effort=self.reasoning_effort,
                    model=PINNED_MODEL,
                    sandbox=self.sandbox,
                )
            text = (result.final_response or "").strip()
            if not text:
                return HTTPStatus.BAD_GATEWAY, {"ok": False, "error": "codex_response_empty", "model": PINNED_MODEL}
            return HTTPStatus.OK, {
                "ok": True,
                "model": PINNED_MODEL,
                "text": text,
                "threadId": call.thread.id,
            }
        except Exception as error:
            return HTTPStatus.BAD_GATEWAY, {"ok": False, "error": _safe_error(error), "model": PINNED_MODEL}


class RequestHandler(BaseHTTPRequestHandler):
    bridge: CodexVoiceBridge
    server_version = "ACC-Codex-Voice-Bridge/1"

    def log_message(self, format_string: str, *args: Any) -> None:
        # Avoid request body or auth metadata in logs.
        print(f"codex-voice-bridge {self.address_string()} {format_string % args}", flush=True)

    def _write(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _json_body(self) -> Any:
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            raise ValueError("content_length_invalid")
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("request_body_size_invalid")
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("json_invalid") from error

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API.
        path = urlparse(self.path).path
        if path == "/health":
            status = self.bridge.auth_status()
            self._write(HTTPStatus.OK, {"ok": True, "service": "codex-voice-bridge", **status})
            return
        if path == "/auth/status":
            self._write(HTTPStatus.OK, self.bridge.auth_status())
            return
        match = re.fullmatch(r"/auth/device/([^/]+)", path)
        if match:
            status, payload = self.bridge.login_status(unquote(match.group(1)))
            self._write(status, payload)
            return
        self._write(HTTPStatus.NOT_FOUND, {"ok": False, "error": "route_not_found"})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API.
        path = urlparse(self.path).path
        if path == "/auth/device/start":
            status, payload = self.bridge.start_device_login()
            self._write(status, payload)
            return
        if path == "/respond":
            try:
                body = self._json_body()
            except ValueError as error:
                self._write(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error), "model": PINNED_MODEL})
                return
            status, payload = self.bridge.respond(body)
            self._write(status, payload)
            return
        self._write(HTTPStatus.NOT_FOUND, {"ok": False, "error": "route_not_found"})

    def do_DELETE(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API.
        path = urlparse(self.path).path
        match = re.fullmatch(r"/calls/([^/]+)", path)
        if not match:
            self._write(HTTPStatus.NOT_FOUND, {"ok": False, "error": "route_not_found"})
            return
        call_instance_id = unquote(match.group(1)).strip()
        if not call_instance_id or len(call_instance_id) > 300:
            self._write(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "call_instance_id_invalid"})
            return
        released = self.bridge.release_call(call_instance_id)
        self._write(HTTPStatus.OK, {"ok": True, "released": released, "model": PINNED_MODEL})


def _self_test() -> None:
    assert PINNED_MODEL == "gpt-5.4-mini"
    assert _safe_error("Bearer secret sk-secret") == "Bearer [redacted] sk-[redacted]"
    empty = type("AccountResponse", (), {"account": None})()
    assert _account_summary(empty)["authenticated"] is False
    print(json.dumps({"ok": True, "model": PINNED_MODEL}))


def main() -> int:
    parser = argparse.ArgumentParser(description="Backend-owned Codex OAuth bridge for the ACC voice demo")
    parser.add_argument("--host", default=os.environ.get("CODEX_VOICE_BRIDGE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("CODEX_VOICE_BRIDGE_PORT", "8771")))
    parser.add_argument("--workspace", default=os.environ.get("CODEX_VOICE_WORKSPACE", "/tmp/acc-codex-voice"))
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        _self_test()
        return 0

    bridge = CodexVoiceBridge(Path(args.workspace).resolve())
    RequestHandler.bridge = bridge
    server = ThreadingHTTPServer((args.host, args.port), RequestHandler)
    print(f"codex-voice-bridge listening on http://{args.host}:{args.port}; model={PINNED_MODEL}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        bridge.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
