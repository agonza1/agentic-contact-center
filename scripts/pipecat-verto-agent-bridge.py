#!/usr/bin/env python3
"""FreeSWITCH Verto agent-leg sidecar for the ACC local SIP path.

This process owns the new preferred #222 signaling boundary:

Linphone SIP 1000 -> FreeSWITCH 8600 -> Verto/WebRTC agent leg -> Pipecat

The current implementation proves and holds the Verto registration surface. It
does not claim caller-audible media acceptance until the incoming Verto dialog
is answered with a Pipecat-backed WebRTC transport and live proof is captured.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

REPO_ROOT = Path(__file__).resolve().parents[1]
LOCAL_RUNTIME_PATH = REPO_ROOT / ".pipecat-runtime"
if LOCAL_RUNTIME_PATH.exists():
    import sys

    sys.path.insert(0, str(LOCAL_RUNTIME_PATH))

try:
    import websockets
    from aiohttp import web
except Exception as exc:  # pragma: no cover - local setup guard
    print(
        json.dumps(
            {
                "ok": False,
                "error": "pipecat_verto_runtime_import_failed",
                "detail": str(exc),
                "install": "npm run pipecat:webrtc:install",
            },
            indent=2,
        )
    )
    raise SystemExit(2)


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


class VertoAgentBridge:
    def __init__(self, *, verto_url: str, login: str, password: str) -> None:
        self.verto_url = verto_url
        self.login = login
        self.password = password
        self.started_at = now_iso()
        self.last_login: dict[str, Any] = {}
        self.last_event: dict[str, Any] = {}
        self.last_error: dict[str, Any] = {}
        self.invite_count = 0
        self.websocket: Any = None
        self._rpc_id = 0

    def next_id(self) -> str:
        self._rpc_id += 1
        return f"acc-verto-{self._rpc_id}"

    async def send_rpc(self, method: str, params: dict[str, Any]) -> str:
        if self.websocket is None:
            raise RuntimeError("verto_websocket_not_connected")
        rpc_id = self.next_id()
        await self.websocket.send(json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": rpc_id}))
        return rpc_id

    async def connect_and_register(self) -> None:
        while True:
            try:
                async with websockets.connect(self.verto_url, ping_interval=20, ping_timeout=10) as ws:
                    self.websocket = ws
                    login_id = await self.send_rpc("login", {"login": self.login, "passwd": self.password})
                    async for raw in ws:
                        event = json.loads(raw) if isinstance(raw, str) else {}
                        self.last_event = {"at": now_iso(), "event": event}
                        if event.get("id") == login_id:
                            self.last_login = {
                                "at": now_iso(),
                                "ok": "error" not in event,
                                "response": event,
                            }
                            print(json.dumps({"type": "verto.login", **self.last_login}), flush=True)
                        if event.get("method") == "verto.invite":
                            self.invite_count += 1
                            await self.handle_invite(event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.websocket = None
                self.last_error = {"at": now_iso(), "error": str(exc)}
                print(json.dumps({"type": "verto.error", **self.last_error}), flush=True)
                await asyncio.sleep(2)

    async def handle_invite(self, event: dict[str, Any]) -> None:
        params = event.get("params") if isinstance(event.get("params"), dict) else {}
        call_id = params.get("callID") or params.get("callId") or str(uuid4())
        proof = {
            "type": "verto.invite.received",
            "at": now_iso(),
            "callId": call_id,
            "mediaTarget": "pipecat_verto_webrtc_agent_leg",
            "reviewReady": False,
            "blocker": "Incoming FreeSWITCH Verto signaling reached the Pipecat sidecar, but Verto WebRTC media answer is not implemented in this slice.",
            "nextAction": "Implement Verto dialog answer with Pipecat WebRTC media frames, then rerun the strict live SIP bundle for caller-audible proof.",
        }
        print(json.dumps(proof), flush=True)

    def readiness_payload(self) -> dict[str, Any]:
        logged_in = bool(self.last_login.get("ok"))
        return {
            "ok": logged_in,
            "status": "registered_pending_media_answer" if logged_in else "blocked",
            "checkedAt": now_iso(),
            "startedAt": self.started_at,
            "vertoUrl": self.verto_url,
            "login": self.login,
            "transport": "freeswitch_verto_webrtc",
            "targetPath": "SIP 1000 -> FreeSWITCH 8600 -> Verto/WebRTC acc-pipecat -> Pipecat rtc-asr/ACC/Kokoro -> same Verto leg -> SIP caller",
            "freeSwitchOwns": ["SIP/RTP", "Verto WebRTC DTLS-SRTP/Opus"],
            "pipecatOwns": ["rtc-asr STT", "ACC caller-turn", "Kokoro TTS", "turn/barge-in policy"],
            "inviteCount": self.invite_count,
            "lastLogin": self.last_login,
            "lastError": self.last_error,
            "reviewReady": False,
            "blockers": [] if logged_in else ["FreeSWITCH Verto login is not established."],
            "remainingMediaBlocker": "Verto signaling is configured, but live caller-audible acceptance still requires answering the Verto WebRTC dialog with a Pipecat media transport.",
        }

    async def health(self, _request: web.Request) -> web.Response:
        payload = self.readiness_payload()
        return web.json_response(payload, status=200 if payload["ok"] else 503)

    def app(self) -> web.Application:
        app = web.Application()
        app.router.add_get("/health", self.health)
        app.router.add_get("/api/verto/readiness", self.health)
        return app


async def run_server(bridge: VertoAgentBridge, host: str, port: int) -> None:
    runner = web.AppRunner(bridge.app())
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    print(json.dumps({"ok": True, "url": f"http://{host}:{port}", "vertoUrl": bridge.verto_url, "login": bridge.login}), flush=True)
    await asyncio.Event().wait()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("PIPECAT_VERTO_BRIDGE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PIPECAT_VERTO_BRIDGE_PORT", "8770")))
    parser.add_argument("--verto-url", default=os.environ.get("FREESWITCH_VERTO_URL", "ws://127.0.0.1:8081"))
    parser.add_argument("--login", default=os.environ.get("FREESWITCH_VERTO_LOGIN", "acc-pipecat@127.0.0.1"))
    parser.add_argument("--password", default=os.environ.get("FREESWITCH_VERTO_PASSWORD", "local-verto-pass"))
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    bridge = VertoAgentBridge(verto_url=args.verto_url, login=args.login, password=args.password)
    if args.check:
        async def check_once() -> int:
            started = time.monotonic()
            try:
                async with websockets.connect(args.verto_url, open_timeout=3) as ws:
                    bridge.websocket = ws
                    login_id = await bridge.send_rpc("login", {"login": args.login, "passwd": args.password})
                    while time.monotonic() - started < 5:
                        event = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                        if event.get("id") == login_id:
                            bridge.last_login = {"at": now_iso(), "ok": "error" not in event, "response": event}
                            print(json.dumps(bridge.readiness_payload(), indent=2))
                            return 0 if bridge.last_login["ok"] else 2
            except Exception as exc:
                bridge.last_error = {"at": now_iso(), "error": str(exc)}
            print(json.dumps(bridge.readiness_payload(), indent=2))
            return 2

        return asyncio.run(check_once())

    async def run() -> None:
        await asyncio.gather(bridge.connect_and_register(), run_server(bridge, args.host, args.port))

    asyncio.run(run())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
