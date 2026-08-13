#!/usr/bin/env python3
"""FreeSWITCH Verto agent-leg sidecar for the ACC local SIP path.

This process owns the new preferred #222 signaling boundary:

Linphone SIP 1000 -> FreeSWITCH 8600 -> Verto/WebRTC agent leg -> Pipecat

The sidecar registers a local Verto endpoint and answers incoming Verto WebRTC
offers with the shared Pipecat voice pipeline. It does not claim caller-audible
media acceptance until live proof is captured.
"""

from __future__ import annotations

import argparse
import asyncio
import binascii
import contextlib
import importlib
import importlib.metadata
import inspect
import json
import os
import re
import sys
import time
import wave
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import MethodType
from typing import Any
from uuid import uuid4

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_PATH = REPO_ROOT / "scripts"
LOCAL_RUNTIME_PATH = REPO_ROOT / ".pipecat-runtime"
DEFAULT_INTRO_AUDIO_PATH = REPO_ROOT / "assets/audio/agilityfeat-intro.wav"
DEFAULT_INTRO_TEXT = "Hello, you are calling AgilityFeat."
if LOCAL_RUNTIME_PATH.exists():
    sys.path.insert(0, str(LOCAL_RUNTIME_PATH))
    nltk_data_path = LOCAL_RUNTIME_PATH / "nltk_data"
    nltk_data_path.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("NLTK_DATA", str(nltk_data_path))
sys.path.insert(0, str(SCRIPTS_PATH))

try:
    # NLTK's dependency guard treats the repo cwd as unsafe while Pipecat imports
    # regex from the local target runtime. Prime regex without changing cwd.
    importlib.import_module("regex")
    import websockets
    from OpenSSL import SSL
    from aiortc import RTCCertificate, RTCSessionDescription
    from aiortc.rtcdtlstransport import RTCDtlsTransport
    from aiohttp import web
    from cryptography import x509
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import rsa
    from pipecat.frames.frames import TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.transports.base_transport import TransportParams
    from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
    from pipecat.transports.smallwebrtc.request_handler import SmallWebRTCRequest, SmallWebRTCRequestHandler
    from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
    from acc_pipecat_voice_pipeline import (
        ACC_VOICE_PIPELINE_CONTRACT,
        DEFAULT_ACC_URL,
        INPUT_SAMPLE_RATE,
        AccVoicePipelineSession,
        build_acc_voice_pipeline,
        check_readiness,
        json_http,
        normalize_browser_answer_sdp,
    )
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


def safe_artifact_id(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    safe_value = "".join(character if character.isalnum() or character in "._-" else "_" for character in value.strip())
    return safe_value[:160] or None


SECRET_PARAM_KEY_PATTERN = re.compile(r"(authorization|password|passwd|token|secret|credential|api[_-]?key|access[_-]?key)", re.IGNORECASE)
CALLER_IDENTITY_PARAM_KEY_PATTERN = re.compile(
    r"(caller[-_\s]?id|caller[-_\s]?(?:name|number|uri)|effective[-_\s]?caller|origination[-_\s]?caller|cid[-_\s]?(?:name|num|number)?|ani|clid|(?:variable[-_\s]?)?sip[-_\s]?(?:full[-_\s]?from|from[-_\s]?(?:uri|user|number|name)|h[-_\s]?(?:p[-_\s]?(?:asserted|preferred)[-_\s]?identity|remote[-_\s]?party[-_\s]?id|diversion|history[-_\s]*info|referred[-_\s]*by))|p[-_\s]?(?:asserted|preferred)[-_\s]?identity|remote[-_\s]?party[-_\s]?id|diversion|history[-_\s]*info|referred[-_\s]*by|full[-_\s]?from|from[-_\s]?(?:uri|user|number|name))",
    re.IGNORECASE,
)


def sanitize_verto_params(params: dict[str, Any]) -> dict[str, Any]:
    sanitized: dict[str, Any] = {}
    for key, value in params.items():
        if SECRET_PARAM_KEY_PATTERN.search(str(key)):
            sanitized[key] = "<redacted secret>"
        elif CALLER_IDENTITY_PARAM_KEY_PATTERN.search(str(key)):
            sanitized[key] = "<redacted caller identity>"
        elif key == "sdp":
            sanitized[key] = f"<redacted sdp bytes={len(value.encode('utf8'))}>" if isinstance(value, str) else "<redacted sdp>"
        elif isinstance(value, dict):
            sanitized[key] = sanitize_verto_params(value)
        elif isinstance(value, list):
            sanitized[key] = [sanitize_verto_params(item) if isinstance(item, dict) else item for item in value[:20]]
        else:
            sanitized[key] = value
    return sanitized


def nested_param_value(params: Any, keys: tuple[str, ...]) -> str | None:
    if isinstance(params, dict):
        for key in keys:
            value = params.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        for value in params.values():
            matched = nested_param_value(value, keys)
            if matched:
                return matched
    elif isinstance(params, list):
        for value in params:
            matched = nested_param_value(value, keys)
            if matched:
                return matched
    return None


def normalize_verto_answer_sdp(sdp: str) -> str:
    """Trim browser-oriented aiortc SDP details that native FreeSWITCH Verto rejects."""
    lines = sdp.replace("\r\n", "\n").strip().split("\n")
    has_mid = any(line.startswith("a=mid:") for line in lines)
    ipv4_candidate = next(
        (
            match.group(1)
            for line in lines
            if line.startswith("a=candidate:")
            for match in [re.search(r" udp \d+ ((?:\d{1,3}\.){3}\d{1,3}) \d+ typ host", line)]
            if match
        ),
        None,
    )
    normalized: list[str] = []
    for line in lines:
        if line.startswith("a=group:BUNDLE") and not has_mid:
            continue
        if line.startswith("a=candidate:") and " typ host" in line and re.search(r" udp \d+ [0-9a-fA-F:]+ \d+ typ host", line):
            continue
        if line.startswith("a=fingerprint:sha-384") or line.startswith("a=fingerprint:sha-512"):
            continue
        if ipv4_candidate and line.startswith("c=IN IP6 "):
            normalized.append(f"c=IN IP4 {ipv4_candidate}")
            continue
        normalized.append(line)
    return "\r\n".join(normalized) + "\r\n"


def normalize_verto_offer_sdp(sdp: str) -> str:
    """Treat FreeSWITCH's Verto ICE endpoint as ICE-lite for aiortc role selection."""
    lines = sdp.replace("\r\n", "\n").strip().split("\n")
    if "a=ice-lite" not in lines:
        session_boundary = next((index for index, line in enumerate(lines) if line.startswith("m=")), len(lines))
        lines.insert(session_boundary, "a=ice-lite")
    return "\r\n".join(lines) + "\r\n"


def run_sdp_normalization_self_test() -> int:
    source = "\r\n".join(
        [
            "v=0",
            "o=- 123 456 IN IP6 ::",
            "s=-",
            "t=0 0",
            "a=group:BUNDLE 0",
            "m=audio 9 UDP/TLS/RTP/SAVPF 111",
            "c=IN IP6 ::",
            "a=fingerprint:sha-256 11:22",
            "a=fingerprint:sha-384 33:44",
            "a=fingerprint:sha-512 55:66",
            "a=candidate:1 1 udp 2130706431 127.0.0.1 5004 typ host",
            "a=candidate:2 1 udp 2130706431 ::1 5005 typ host",
        ]
    )
    normalized = normalize_verto_answer_sdp(source)
    normalized_offer = normalize_verto_offer_sdp(source)
    marked_pcmu_packet = bytes([0x80, 0x80, *([0] * 10)])
    normalized_pcmu_packet = normalize_verto_rtp_packet(marked_pcmu_packet)
    checks = {
        "drops_bundle_without_mid": "a=group:BUNDLE" not in normalized,
        "keeps_sha256_fingerprint": "a=fingerprint:sha-256 11:22" in normalized,
        "drops_sha384_fingerprint": "a=fingerprint:sha-384" not in normalized,
        "drops_sha512_fingerprint": "a=fingerprint:sha-512" not in normalized,
        "rewrites_ipv6_connection_address": "c=IN IP4 127.0.0.1" in normalized,
        "drops_ipv6_host_candidate": "::1" not in normalized,
        "keeps_ipv4_host_candidate": "127.0.0.1 5004 typ host" in normalized,
        "uses_crlf_line_endings": normalized.endswith("\r\n") and "\n" in normalized,
        "marks_freeswitch_offer_ice_lite": "a=ice-lite\r\n" in normalized_offer,
        "clears_repeated_pcmu_marker": normalized_pcmu_packet[1] == 0,
    }
    ok = all(checks.values())
    print(json.dumps({"ok": ok, "checks": checks}, indent=2))
    return 0 if ok else 2


def normalize_verto_rtp_packet(data: bytes) -> bytes:
    if len(data) >= 12 and data[0] >> 6 == 2 and data[1] & 0x7F == 0:
        return data[:1] + bytes([data[1] & 0x7F]) + data[2:]
    return data


class _RsaRtcCertificate(RTCCertificate):
    def _create_ssl_context(self, srtp_profiles: list[Any]) -> SSL.Context:
        context = SSL.Context(SSL.DTLS_METHOD)
        context.set_verify(SSL.VERIFY_PEER | SSL.VERIFY_FAIL_IF_NO_PEER_CERT, lambda *args: True)
        context.use_certificate(self._cert)
        context.use_privatekey(self._key)
        context.set_cipher_list(
            b"ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA"
        )
        context.set_tlsext_use_srtp(b":".join(profile.openssl_profile for profile in srtp_profiles))
        return context


def _create_rsa_certificate() -> _RsaRtcCertificate:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048, backend=default_backend())
    name = x509.Name(
        [x509.NameAttribute(x509.NameOID.COMMON_NAME, binascii.hexlify(os.urandom(16)).decode("ascii"))]
    )
    now = datetime.now(tz=UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=30))
        .sign(key, hashes.SHA256(), default_backend())
    )
    return _RsaRtcCertificate(key=key, cert=certificate)


async def _flush_all_pending_ssl_datagrams(dtls: Any) -> None:
    """Drain every DTLS datagram OpenSSL queued for the FreeSWITCH peer."""
    while True:
        try:
            data = dtls._ssl.bio_read(1500)
        except SSL.Error:
            return
        if not data:
            return
        await dtls.transport._send(data)
        dtls._RTCDtlsTransport__tx_bytes += len(data)
        dtls._RTCDtlsTransport__tx_packets += 1


def assert_verto_webrtc_compatibility() -> None:
    expected_versions = {"pipecat-ai": "1.7.0", "aiortc": "1.14.0"}
    mismatched_versions = {
        package: importlib.metadata.version(package)
        for package, expected in expected_versions.items()
        if importlib.metadata.version(package) != expected
    }
    required_connection_methods = {
        "_create_answer",
        "disconnect",
        "force_transceivers_to_send_recv",
        "initialize",
        "renegotiate",
        "get_answer",
    }
    missing_connection_methods = [
        name for name in sorted(required_connection_methods)
        if not callable(getattr(SmallWebRTCConnection, name, None))
    ]
    required_dtls_methods = {"_write_ssl", "_send_rtp"}
    missing_dtls_methods = [
        name for name in sorted(required_dtls_methods)
        if not callable(getattr(RTCDtlsTransport, name, None))
    ]
    request_handler_params = set(inspect.signature(SmallWebRTCRequestHandler).parameters)
    missing_request_handler_params = [
        name for name in ("ice_servers", "esp32_mode", "host", "connection_mode")
        if name not in request_handler_params
    ]
    if mismatched_versions or missing_connection_methods or missing_dtls_methods or missing_request_handler_params:
        raise RuntimeError(
            "Unsupported Pipecat/Verto WebRTC runtime. "
            f"expectedVersions={expected_versions} "
            f"mismatchedVersions={mismatched_versions} "
            f"missingConnectionMethods={missing_connection_methods} "
            f"missingDtlsMethods={missing_dtls_methods} "
            f"missingRequestHandlerParams={missing_request_handler_params}"
        )


class FreeSwitchWebRTCConnection(SmallWebRTCConnection):
    """Verto-specific WebRTC connection scoped to FreeSWITCH agent-leg calls.

    Pipecat 1.7.0 does not expose public hooks for the DTLS certificate/role or
    G.711 RTP marker behavior FreeSWITCH needs, so this subclass keeps the
    compatibility work on the Verto connection instance instead of mutating
    Pipecat or aiortc classes for the whole process.
    """

    def _set_rsa_certificate_for_free_switch(self) -> None:
        self._pc._RTCPeerConnection__certificates = [_create_rsa_certificate()]

    def _force_dtls_server_role_for_free_switch(self) -> None:
        for transceiver in getattr(self._pc, "_RTCPeerConnection__transceivers", []):
            transceiver.receiver.transport._set_role("server")
        sctp = getattr(self._pc, "_RTCPeerConnection__sctp", None)
        if sctp is not None:
            sctp.transport._set_role("server")

    def _free_switch_dtls_transports(self) -> list[Any]:
        transports: list[Any] = []
        for transceiver in self._pc.getTransceivers():
            for owner in (getattr(transceiver, "receiver", None), getattr(transceiver, "sender", None)):
                transport = getattr(owner, "transport", None)
                if transport is not None and transport not in transports:
                    transports.append(transport)
        sctp = getattr(self._pc, "_RTCPeerConnection__sctp", None)
        sctp_transport = getattr(sctp, "transport", None)
        if sctp_transport is not None and sctp_transport not in transports:
            transports.append(sctp_transport)
        return transports

    def _install_free_switch_dtls_hooks(self) -> None:
        async def flush_all_ssl_datagrams(dtls: Any) -> None:
            await _flush_all_pending_ssl_datagrams(dtls)

        for transport in self._free_switch_dtls_transports():
            if getattr(transport, "_acc_verto_hooks_installed", False):
                continue
            original_send_rtp = transport._send_rtp

            async def send_rtp_without_repeated_audio_marker(
                dtls: Any,
                data: bytes,
                *,
                send_rtp: Any = original_send_rtp,
            ) -> None:
                await send_rtp(normalize_verto_rtp_packet(data))

            transport._write_ssl = MethodType(flush_all_ssl_datagrams, transport)
            transport._send_rtp = MethodType(send_rtp_without_repeated_audio_marker, transport)
            transport._acc_verto_hooks_installed = True

    async def _create_answer(self, sdp: str, type: str) -> None:
        """Create a FreeSWITCH-compatible answer without process-global patches."""
        if os.environ.get("FREESWITCH_VERTO_DTLS_CERTIFICATE", "rsa").strip().lower() == "rsa":
            self._set_rsa_certificate_for_free_switch()
        offer = RTCSessionDescription(sdp=normalize_verto_offer_sdp(sdp), type=type)
        await self._pc.setRemoteDescription(offer)
        if os.environ.get("FREESWITCH_VERTO_DTLS_ROLE", "active").strip().lower() == "passive":
            self._force_dtls_server_role_for_free_switch()
        self.force_transceivers_to_send_recv()
        local_answer = await self._pc.createAnswer()
        await self._pc.setLocalDescription(local_answer)
        self._install_free_switch_dtls_hooks()
        self._answer = self._pc.localDescription


class FreeSwitchSmallWebRTCRequestHandler(SmallWebRTCRequestHandler):
    """SmallWebRTC request handler that creates Verto-specific connections."""

    async def handle_web_request(
        self,
        request: SmallWebRTCRequest,
        webrtc_connection_callback: Callable[[Any], Awaitable[None]],
    ) -> dict[str, str] | None:
        pc_id = request.pc_id
        self._check_single_connection_constraints(pc_id)
        existing_connection = self._pcs_map.get(pc_id) if pc_id else None

        if existing_connection:
            pipecat_connection = existing_connection
            await pipecat_connection.renegotiate(
                sdp=request.sdp,
                type=request.type,
                restart_pc=request.restart_pc or False,
            )
        else:
            pipecat_connection = FreeSwitchWebRTCConnection(ice_servers=self._ice_servers)
            await pipecat_connection.initialize(sdp=request.sdp, type=request.type)

            @pipecat_connection.event_handler("closed")
            async def discard_closed_peer(webrtc_connection: SmallWebRTCConnection) -> None:
                self._pcs_map.pop(webrtc_connection.pc_id, None)

            try:
                await webrtc_connection_callback(pipecat_connection)
            except Exception as exc:
                print(
                    json.dumps(
                        {
                            "type": "verto.connection_callback.error",
                            "at": now_iso(),
                            "pcId": pipecat_connection.pc_id,
                            "error": str(exc),
                        }
                    ),
                    flush=True,
                )
                try:
                    await pipecat_connection.disconnect()
                except Exception as close_exc:
                    print(
                        json.dumps(
                            {
                                "type": "verto.connection_callback.close_failed",
                                "at": now_iso(),
                                "pcId": pipecat_connection.pc_id,
                                "error": str(close_exc),
                            }
                        ),
                        flush=True,
                    )
                raise

        answer = pipecat_connection.get_answer()
        if answer is None:
            raise RuntimeError("FreeSwitchWebRTCConnection produced no SDP answer")
        if self._esp32_mode:
            from pipecat.runner.utils import smallwebrtc_sdp_munging

            answer["sdp"] = smallwebrtc_sdp_munging(answer["sdp"], self._host)
        self._pcs_map[answer["pc_id"]] = pipecat_connection
        return answer


class FreeSwitchVertoSignalingAdapter:
    def __init__(self, *, verto_url: str, login: str, password: str, acc_url: str, proof_out: str | None = None) -> None:
        assert_verto_webrtc_compatibility()
        self.verto_url = verto_url
        self.login = login
        self.password = password
        self.acc_url = acc_url.rstrip("/")
        self.proof_out = Path(proof_out).resolve() if proof_out else None
        self.started_at = now_iso()
        self.last_login: dict[str, Any] = {}
        self.last_event: dict[str, Any] = {}
        self.last_error: dict[str, Any] = {}
        self.last_invite: dict[str, Any] = {}
        self.last_answer: dict[str, Any] = {}
        self.invite_count = 0
        self.websocket: Any = None
        self._rpc_id = 0
        self.request_handler = FreeSwitchSmallWebRTCRequestHandler(host="127.0.0.1")
        self.sessions: dict[str, dict[str, Any]] = {}
        self.pipeline_evidence: dict[str, dict[str, Any]] = {}

    def write_proof_artifact(self, event_type: str, *, affected_artifact_ids: list[str | None] | None = None) -> None:
        if self.proof_out is None:
            return
        try:
            pipeline_evidence = list(self.pipeline_evidence.values())
            payload = {
                "schemaVersion": 1,
                "generatedAt": now_iso(),
                "eventType": event_type,
                "status": "registered_media_answer_ready" if self.last_login.get("ok") else "blocked",
                "reviewReady": False,
                "vertoUrl": self.verto_url,
                "login": self.login,
                "transport": "freeswitch_verto_webrtc",
                "inviteCount": self.invite_count,
                "lastLogin": self.last_login,
                "lastInvite": self.last_invite,
                "lastAnswer": self.last_answer,
                "lastError": self.last_error,
                "pipelineEvidence": pipeline_evidence,
                "remainingMediaBlocker": "Verto signaling is configured and the sidecar can attempt a Pipecat-backed WebRTC answer, but caller-audible acceptance still requires a live 8600 proof showing rtc-asr final transcript and Kokoro/Pipecat playback heard by the caller.",
                "nextAction": "Place a local 8600 call with the Verto bridge running, then attach this artifact with the strict live SIP bundle once caller playback proof is captured.",
            }
            scoped_paths = self.call_scoped_proof_paths(payload)
            paths_to_write = (
                self.call_scoped_proof_paths(payload, artifact_ids=affected_artifact_ids)
                if affected_artifact_ids is not None
                else scoped_paths
            )
            if scoped_paths:
                payload["callScopedProofArtifactPaths"] = [str(path) for path in scoped_paths]
            self.proof_out.parent.mkdir(parents=True, exist_ok=True)
            self.write_json_atomic(self.proof_out, payload)
            for path in paths_to_write:
                scoped_payload = self.call_scoped_payload(payload, path.parent.name)
                scoped_payload["callScopedProofArtifactPaths"] = [str(path)]
                self.write_json_atomic(path, scoped_payload)
        except Exception as exc:
            print(json.dumps({
                "type": "verto.proof_artifact.error",
                "at": now_iso(),
                "eventType": event_type,
                "proofArtifactPath": str(self.proof_out),
                "error": str(exc),
            }), flush=True)

    def write_json_atomic(self, path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = path.with_suffix(f"{path.suffix}.tmp")
        tmp_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf8")
        tmp_path.replace(path)

    def call_scoped_proof_paths(self, payload: dict[str, Any], *, artifact_ids: list[str | None] | None = None) -> list[Path]:
        if self.proof_out is None:
            return []
        if artifact_ids is not None:
            ids: list[str] = []
            for artifact_id in artifact_ids:
                safe_id = safe_artifact_id(artifact_id)
                if safe_id and safe_id not in ids:
                    ids.append(safe_id)
            return [self.proof_out.parent / "calls" / artifact_id / self.proof_out.name for artifact_id in ids]
        ids: list[str] = []
        for source in [
            payload.get("lastInvite"),
            payload.get("lastAnswer"),
            payload.get("lastError"),
            *payload.get("pipelineEvidence", []),
        ]:
            if not isinstance(source, dict):
                continue
            for key in ("callId", "vertoCallId", "sipCallId", "linkedSipCallId", "proofSipCallId", "harnessSipCallId", "accCallId"):
                safe_id = safe_artifact_id(source.get(key))
                if safe_id and safe_id not in ids:
                    ids.append(safe_id)
        return [self.proof_out.parent / "calls" / artifact_id / self.proof_out.name for artifact_id in ids]

    def payload_matches_artifact_id(self, payload: dict[str, Any], artifact_id: str) -> bool:
        for key in ("callId", "vertoCallId", "sipCallId", "linkedSipCallId", "proofSipCallId", "harnessSipCallId", "accCallId"):
            if safe_artifact_id(payload.get(key)) == artifact_id:
                return True
        return False

    def call_scoped_payload(self, payload: dict[str, Any], artifact_id: str) -> dict[str, Any]:
        scoped_pipeline_evidence = [
            item for item in payload.get("pipelineEvidence", [])
            if isinstance(item, dict) and self.payload_matches_artifact_id(item, artifact_id)
        ]
        scoped_payload = dict(payload)
        scoped_payload["pipelineEvidence"] = scoped_pipeline_evidence
        for key in ("lastInvite", "lastAnswer", "lastError"):
            value = payload.get(key)
            scoped_payload[key] = value if isinstance(value, dict) and self.payload_matches_artifact_id(value, artifact_id) else {}
        scoped_payload["inviteCount"] = len(scoped_pipeline_evidence)
        return scoped_payload

    def write_sdp_artifact(self, call_id: str, kind: str, sdp: str) -> str | None:
        if self.proof_out is None:
            return None
        safe_call_id = safe_artifact_id(call_id) or "unknown-call"
        path = self.proof_out.parent / f"{safe_call_id}-{kind}.sdp"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(sdp, encoding="utf8")
        return str(path)

    def linked_sip_call_id(self, params: dict[str, Any]) -> str | None:
        return nested_param_value(
            params,
            (
                "acc_linked_sip_call_id",
                "variable_acc_linked_sip_call_id",
                "linkedSipCallId",
                "linked_sip_call_id",
                "aleg_uuid",
                "variable_originating_leg_uuid",
            ),
        )

    def proof_sip_call_id(self, params: dict[str, Any]) -> str | None:
        return self.first_param_string(params, (
            "sip_h_X-ACC-Proof-Call-ID",
            "variable_sip_h_X-ACC-Proof-Call-ID",
            "sip_h_X_ACC_Proof_Call_ID",
            "variable_sip_h_X_ACC_Proof_Call_ID",
            "X-ACC-Proof-Call-ID",
            "x-acc-proof-call-id",
            "proofSipCallId",
            "harnessSipCallId",
        ))

    def first_param_string(self, params: dict[str, Any], keys: tuple[str, ...]) -> str | None:
        case_insensitive = {
            str(key).lower(): value
            for key, value in params.items()
        }
        for key in keys:
            value = params.get(key)
            if not isinstance(value, str):
                value = case_insensitive.get(key.lower())
            if isinstance(value, str) and value.strip():
                return value.strip()
        return nested_param_value(params, keys)

    def destination_number(self, params: dict[str, Any]) -> str | None:
        value = self.first_param_string(params, (
            "sip_h_X-ACC-Destination",
            "variable_sip_h_X-ACC-Destination",
            "sip_h_X_ACC_Destination",
            "variable_sip_h_X_ACC_Destination",
            "X-ACC-Destination",
            "Caller-Destination-Number",
            "acc_destination_number",
            "variable_acc_destination_number",
            "variable_destination_number",
            "destinationNumber",
            "destination",
        ))
        if value:
            destination = value.strip()
            return "8600" if destination.lower() == "acc" else destination
        route_hint = nested_param_value(params, ("caller_id_name", "Caller-Caller-ID-Name"))
        route_match = re.fullmatch(r"ACC[-_ ](8600|8611|8612)", route_hint or "", flags=re.IGNORECASE)
        if route_match:
            return route_match.group(1)
        return None

    def conversation_mode(self, params: dict[str, Any], destination_number: str | None) -> str:
        value = self.first_param_string(params, (
            "sip_h_X-ACC-Conversation-Mode",
            "variable_sip_h_X-ACC-Conversation-Mode",
            "sip_h_X_ACC_Conversation_Mode",
            "variable_sip_h_X_ACC_Conversation_Mode",
            "X-ACC-Conversation-Mode",
            "acc_conversation_mode",
            "variable_acc_conversation_mode",
            "conversationMode",
        ))
        if value and value in {"scripted", "free_caller", "openai_llm"}:
            return value
        if destination_number == "8600":
            return "openai_llm"
        if destination_number == "8611":
            return "free_caller"
        return "scripted"

    def telephony_mode(self, params: dict[str, Any]) -> str:
        trusted_route = self.first_param_string(params, (
            "acc_route",
            "variable_acc_route",
        ))
        if trusted_route == "signalwire_live":
            return "signalwire_live"
        return "local_sip"

    async def end_acc_call(self, call_id: str, *, reason: str, timestamp: str | None = None, timeout: float = 2.0, linked_sip_call_id: str | None = None) -> bool:
        try:
            payload = {
                "eventType": "call.ended",
                "timestamp": timestamp or now_iso(),
                "sipCallId": linked_sip_call_id or call_id,
                "vertoCallId": call_id,
                "hangupCause": reason,
            }
            if linked_sip_call_id:
                payload["linkedSipCallId"] = linked_sip_call_id
            await asyncio.to_thread(
                json_http,
                "POST",
                f"{self.acc_url.rstrip('/')}/api/live-sip/events",
                payload,
                timeout,
            )
            return True
        except Exception as exc:
            self.last_error = {"at": now_iso(), "error": f"ACC live SIP call end failed: {exc}", "callId": call_id, "reason": reason}
            print(json.dumps({"type": "verto.call_end.error", **self.last_error}), flush=True)
            self.write_proof_artifact("verto.call_end.error")
            return False

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
                async with websockets.connect(self.verto_url, ping_interval=None) as ws:
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
                            self.write_proof_artifact("verto.login")
                        if event.get("method") == "verto.invite":
                            self.invite_count += 1
                            await self.handle_invite(event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.websocket = None
                self.last_error = {"at": now_iso(), "error": str(exc)}
                print(json.dumps({"type": "verto.error", **self.last_error}), flush=True)
                self.write_proof_artifact("verto.error")
                await asyncio.sleep(2)

    async def handle_invite(self, event: dict[str, Any]) -> None:
        params = event.get("params") if isinstance(event.get("params"), dict) else {}
        call_id = params.get("callID") or params.get("callId") or str(uuid4())
        linked_sip_call_id = self.linked_sip_call_id(params)
        proof_sip_call_id = self.proof_sip_call_id(params)
        destination_number = self.destination_number(params)
        conversation_mode = self.conversation_mode(params, destination_number)
        telephony_mode = self.telephony_mode(params)
        offer_sdp = params.get("sdp") if isinstance(params.get("sdp"), str) else ""
        if not offer_sdp.strip():
            proof = {
                "type": "verto.invite.blocked",
                "at": now_iso(),
                "callId": call_id,
                "vertoCallId": call_id,
                "sipCallId": linked_sip_call_id or call_id,
                "linkedSipCallId": linked_sip_call_id,
                "proofSipCallId": proof_sip_call_id,
                "destinationNumber": destination_number,
                "conversationMode": conversation_mode,
                "telephonyMode": telephony_mode,
                "mediaTarget": "pipecat_verto_webrtc_agent_leg",
                "reviewReady": False,
                "blocker": "Incoming FreeSWITCH Verto invite did not include SDP, so the Pipecat sidecar cannot create a WebRTC answer.",
            }
            self.last_invite = proof
            print(json.dumps(proof), flush=True)
            self.write_proof_artifact("verto.invite.blocked")
            return
        offer_sdp_path = None
        offer_artifact_error = None
        try:
            offer_sdp_path = self.write_sdp_artifact(call_id, "offer", offer_sdp)
        except Exception as exc:
            offer_artifact_error = str(exc)
            self.last_error = {
                "at": now_iso(),
                "error": f"Verto offer SDP artifact write failed before answer delivery: {exc}",
                "callId": call_id,
                "vertoCallId": call_id,
                "sipCallId": linked_sip_call_id or call_id,
                "linkedSipCallId": linked_sip_call_id,
                "proofSipCallId": proof_sip_call_id,
            }
            print(json.dumps({"type": "verto.invite.artifact_error", **self.last_error}), flush=True)
        proof = {
            "type": "verto.invite.received",
            "at": now_iso(),
            "callId": call_id,
            "vertoCallId": call_id,
            "sipCallId": linked_sip_call_id or call_id,
            "linkedSipCallId": linked_sip_call_id,
            "proofSipCallId": proof_sip_call_id,
            "destinationNumber": destination_number,
            "conversationMode": conversation_mode,
            "telephonyMode": telephony_mode,
            "mediaTarget": "pipecat_verto_webrtc_agent_leg",
            "reviewReady": False,
            "offerSdpBytes": len(offer_sdp.encode("utf-8")),
            "offerSdpPath": offer_sdp_path,
            "offerSdpArtifactPersisted": offer_sdp_path is not None,
            "offerSdpArtifactError": offer_artifact_error,
            "vertoParams": sanitize_verto_params(params),
            "nextAction": "Answer the Verto WebRTC dialog with the shared Pipecat pipeline and then rerun the strict live SIP bundle for caller-audible proof.",
        }
        self.last_invite = proof
        print(json.dumps(proof), flush=True)
        self.write_proof_artifact("verto.invite.received")
        await self.answer_invite(
            call_id=call_id,
            linked_sip_call_id=linked_sip_call_id,
            proof_sip_call_id=proof_sip_call_id,
            destination_number=destination_number,
            conversation_mode=conversation_mode,
            telephony_mode=telephony_mode,
            offer_sdp=offer_sdp,
            params=params,
        )

    async def answer_invite(self, *, call_id: str, linked_sip_call_id: str | None, proof_sip_call_id: str | None, destination_number: str | None, conversation_mode: str, telephony_mode: str, offer_sdp: str, params: dict[str, Any]) -> None:
        readiness = await asyncio.to_thread(check_readiness, self.acc_url)
        sip_call_id = linked_sip_call_id or call_id
        try:
            started_call = await asyncio.to_thread(
                json_http,
                "POST",
                f"{self.acc_url.rstrip('/')}/api/live-sip/events",
                {
                    "eventType": "call.started",
                    "timestamp": now_iso(),
                    "sipCallId": sip_call_id,
                    "vertoCallId": call_id,
                    **({"linkedSipCallId": linked_sip_call_id} if linked_sip_call_id else {}),
                    **({"proofSipCallId": proof_sip_call_id} if proof_sip_call_id else {}),
                    **({"destinationNumber": destination_number} if destination_number else {}),
                    "conversationMode": conversation_mode,
                    "telephonyMode": telephony_mode,
                    "source": "freeswitch_verto",
                    "rtcAsrMode": "rtc_asr_live" if readiness.ok else "rtc_asr_blocked",
                },
            )
            acc_call_id = str(started_call["call"]["session"]["callId"])
        except Exception as exc:
            self.last_answer = {
                "type": "verto.answer.blocked",
                "at": now_iso(),
                "callId": call_id,
                "vertoCallId": call_id,
                "sipCallId": sip_call_id,
                "linkedSipCallId": linked_sip_call_id,
                "proofSipCallId": proof_sip_call_id,
                "reviewReady": False,
                "blocker": f"ACC live SIP call creation failed: {exc}",
            }
            print(json.dumps(self.last_answer), flush=True)
            self.write_proof_artifact("verto.answer.blocked")
            return

        if not readiness.ok:
            blocked_evidence_posted = False
            blocked_evidence_error = None
            try:
                await asyncio.to_thread(
                    json_http,
                    "POST",
                    f"{self.acc_url.rstrip('/')}/api/live-sip/events",
                    {
                        "eventType": "rtc_asr.blocked",
                        "timestamp": now_iso(),
                        "sipCallId": sip_call_id,
                        "vertoCallId": call_id,
                        **({"linkedSipCallId": linked_sip_call_id} if linked_sip_call_id else {}),
                        **({"proofSipCallId": proof_sip_call_id} if proof_sip_call_id else {}),
                        **({"destinationNumber": destination_number} if destination_number else {}),
                        "conversationMode": conversation_mode,
                        "telephonyMode": telephony_mode,
                        "blocker": readiness.detail,
                        "nextAction": "Restore ACC, rtc-asr, Kokoro, and Pipecat readiness before rerunning the Verto live SIP proof.",
                    },
                )
                blocked_evidence_posted = True
            except Exception as exc:
                blocked_evidence_error = str(exc)
                self.last_error = {
                    "at": now_iso(),
                    "error": f"ACC rtc_asr.blocked evidence post failed: {exc}",
                    "callId": call_id,
                    "vertoCallId": call_id,
                    "sipCallId": sip_call_id,
                    "linkedSipCallId": linked_sip_call_id,
                }
                print(json.dumps({"type": "verto.rtc_asr_blocked.post_error", **self.last_error}), flush=True)
                self.write_proof_artifact("verto.rtc_asr_blocked.post_error")
            finally:
                self.last_answer = {
                    "type": "verto.answer.blocked",
                    "at": now_iso(),
                    "callId": call_id,
                    "vertoCallId": call_id,
                    "sipCallId": sip_call_id,
                    "linkedSipCallId": linked_sip_call_id,
                    "proofSipCallId": proof_sip_call_id,
                    "destinationNumber": destination_number,
                    "conversationMode": conversation_mode,
                    "telephonyMode": telephony_mode,
                    "reviewReady": False,
                    "blocker": "ACC, rtc-asr, Kokoro, or Pipecat runtime readiness failed before answering Verto media.",
                    "blockedEvidencePosted": blocked_evidence_posted,
                    "blockedEvidenceError": blocked_evidence_error,
                    "readiness": {
                        "status": readiness.status,
                        "detail": readiness.detail,
                        "blockers": readiness.blockers,
                    },
                }
                print(json.dumps(self.last_answer), flush=True)
                self.write_proof_artifact("verto.answer.blocked")
                await self.end_acc_call(call_id, reason="verto_readiness_blocked", linked_sip_call_id=linked_sip_call_id)
            return

        session_id = f"verto-{call_id}"
        small_request = SmallWebRTCRequest.from_dict(
            {
                "sdp": offer_sdp,
                "type": "offer",
                "pc_id": call_id,
                "restart_pc": False,
                "request_data": {
                    "source": "freeswitch_verto",
                    "sessionId": session_id,
                    "callId": call_id,
                    "sipCallId": sip_call_id,
                    "linkedSipCallId": linked_sip_call_id,
                    "proofSipCallId": proof_sip_call_id,
                    "destinationNumber": destination_number,
                    "conversationMode": conversation_mode,
                    "telephonyMode": telephony_mode,
                    "vertoCallId": call_id,
                    "vertoParams": sanitize_verto_params(params),
                },
            }
        )

        async def on_connection(connection: Any) -> None:
            try:
                await self.start_pipeline(
                    connection=connection,
                    session_id=session_id,
                    call_id=call_id,
                    linked_sip_call_id=linked_sip_call_id,
                    proof_sip_call_id=proof_sip_call_id,
                    destination_number=destination_number,
                    conversation_mode=conversation_mode,
                    telephony_mode=telephony_mode,
                    acc_call_id=acc_call_id,
                    readiness=readiness,
                )
            except Exception as exc:
                self.last_error = {"at": now_iso(), "error": f"Verto pipeline start failed: {exc}", "callId": call_id, "vertoCallId": call_id, "sipCallId": sip_call_id, "linkedSipCallId": linked_sip_call_id, "proofSipCallId": proof_sip_call_id}
                print(json.dumps({"type": "verto.pipeline_start.error", **self.last_error}), flush=True)
                self.write_proof_artifact("verto.pipeline_start.error")
                await self.end_acc_call(call_id, reason="verto_pipeline_start_failed", linked_sip_call_id=linked_sip_call_id)
                raise

        try:
            answer = await self.request_handler.handle_web_request(small_request, on_connection)
        except Exception as exc:
            self.last_answer = {
                "type": "verto.answer.failed",
                "at": now_iso(),
                "callId": call_id,
                "vertoCallId": call_id,
                "sipCallId": sip_call_id,
                "linkedSipCallId": linked_sip_call_id,
                "proofSipCallId": proof_sip_call_id,
                "reviewReady": False,
                "blocker": f"Pipecat SmallWebRTCRequestHandler failed before returning an SDP answer: {exc}",
            }
            print(json.dumps(self.last_answer), flush=True)
            self.write_proof_artifact("verto.answer.failed")
            if session_id in self.sessions:
                await self.close_session(session_id, reason="verto_sdp_answer_failed")
            else:
                await self.end_acc_call(call_id, reason="verto_sdp_answer_failed", linked_sip_call_id=linked_sip_call_id)
            return
        if not answer or not isinstance(answer.get("sdp"), str):
            self.last_answer = {
                "type": "verto.answer.failed",
                "at": now_iso(),
                "callId": call_id,
                "vertoCallId": call_id,
                "sipCallId": sip_call_id,
                "linkedSipCallId": linked_sip_call_id,
                "proofSipCallId": proof_sip_call_id,
                "reviewReady": False,
                "blocker": "Pipecat SmallWebRTCRequestHandler did not return an SDP answer for the Verto offer.",
            }
            print(json.dumps(self.last_answer), flush=True)
            self.write_proof_artifact("verto.answer.failed")
            if session_id in self.sessions:
                await self.close_session(session_id, reason="verto_sdp_answer_failed")
            else:
                await self.end_acc_call(call_id, reason="verto_sdp_answer_failed", linked_sip_call_id=linked_sip_call_id)
            return

        answer_sdp = normalize_verto_answer_sdp(normalize_browser_answer_sdp(str(answer["sdp"])))
        try:
            await self.send_rpc("verto.answer", {"dialogParams": {"callID": call_id}, "sdp": answer_sdp})
        except Exception as exc:
            self.last_answer = {
                "type": "verto.answer.failed",
                "at": now_iso(),
                "callId": call_id,
                "vertoCallId": call_id,
                "sipCallId": sip_call_id,
                "linkedSipCallId": linked_sip_call_id,
                "proofSipCallId": proof_sip_call_id,
                "reviewReady": False,
                "blocker": f"Verto answer send failed after ACC call creation: {exc}",
            }
            print(json.dumps(self.last_answer), flush=True)
            self.write_proof_artifact("verto.answer.failed")
            await self.close_session(session_id, reason="verto_answer_send_failed")
            return
        answer_sdp_path = None
        answer_artifact_error = None
        try:
            answer_sdp_path = self.write_sdp_artifact(call_id, "answer", answer_sdp)
        except Exception as exc:
            answer_artifact_error = str(exc)
            self.last_error = {
                "at": now_iso(),
                "error": f"Verto answer SDP artifact write failed after successful answer delivery: {exc}",
                "callId": call_id,
            }
            print(json.dumps({"type": "verto.answer.artifact_error", **self.last_error}), flush=True)
        self.last_answer = {
            "type": "verto.answer.sent",
            "at": now_iso(),
            "callId": call_id,
            "vertoCallId": call_id,
            "sipCallId": sip_call_id,
            "linkedSipCallId": linked_sip_call_id,
            "proofSipCallId": proof_sip_call_id,
            "accCallId": acc_call_id,
            "telephonyMode": telephony_mode,
            "sessionId": session_id,
            "pcId": str(answer.get("pc_id") or call_id),
            "answerSdpBytes": len(answer_sdp.encode("utf-8")),
            "answerSdpPath": answer_sdp_path,
            "answerSdpArtifactPersisted": answer_sdp_path is not None,
            "answerSdpArtifactError": answer_artifact_error,
            "transport": "SmallWebRTCTransport",
            "pipeline": ACC_VOICE_PIPELINE_CONTRACT,
            "reviewReady": False,
            "nextAction": "Capture live Linphone 1000 -> 8600 proof with rtc_asr_live transcript and caller-audible Kokoro/Pipecat playback.",
        }
        print(json.dumps(self.last_answer), flush=True)
        self.write_proof_artifact("verto.answer.sent")

    async def start_pipeline(
        self,
        *,
        connection: Any,
        session_id: str,
        call_id: str,
        linked_sip_call_id: str | None,
        proof_sip_call_id: str | None,
        destination_number: str | None,
        conversation_mode: str,
        telephony_mode: str,
        acc_call_id: str,
        readiness: Any,
    ) -> None:
        def record_pipeline_evidence(snapshot: dict[str, Any]) -> None:
            self.pipeline_evidence[call_id] = {
                **snapshot,
                "accCallId": acc_call_id,
                "vertoCallId": call_id,
                "sipCallId": linked_sip_call_id or call_id,
                "linkedSipCallId": linked_sip_call_id,
                "proofSipCallId": proof_sip_call_id,
                "conversationMode": conversation_mode,
                "telephonyMode": telephony_mode,
            }
            self.write_proof_artifact(
                "verto.pipeline.stage",
                affected_artifact_ids=[call_id, acc_call_id, linked_sip_call_id, proof_sip_call_id],
            )

        session = AccVoicePipelineSession(
            acc_url=self.acc_url,
            call_id=acc_call_id,
            correlation_id=f"acc-pipecat-{call_id}",
            readiness=readiness,
            evidence_callback=record_pipeline_evidence,
            conversation_mode=conversation_mode,
        )
        session.hold_caller_turns("prerecorded_greeting_evidence_pending")
        # FreeSWITCH's Verto leg negotiates PCMU/8 kHz for the local SIP demo.
        # Preserve that native input clock here and let RtcAsrTurnProcessor do
        # the one explicit normalization to the 16 kHz rtc-asr contract. Asking
        # the WebRTC transport to relabel/resample this leg caused Linphone
        # speech to arrive at the recognizer stretched to roughly half speed.
        audio_in_sample_rate = int(os.environ.get("ACC_VERTO_AUDIO_IN_SAMPLE_RATE", "8000"))
        audio_out_sample_rate = int(os.environ.get("ACC_VERTO_AUDIO_OUT_SAMPLE_RATE", "8000"))
        transport = SmallWebRTCTransport(
            webrtc_connection=connection,
            params=TransportParams(
                audio_in_enabled=True,
                audio_in_sample_rate=audio_in_sample_rate,
                audio_in_channels=1,
                audio_in_passthrough=True,
                audio_out_enabled=True,
                audio_out_sample_rate=audio_out_sample_rate,
                audio_out_channels=1,
                audio_out_auto_silence=True,
            ),
        )
        pipeline = build_acc_voice_pipeline(
            transport_input=transport.input(),
            transport_output=transport.output(),
            session=session,
        )
        task = PipelineTask(
            pipeline,
            params=PipelineParams(
                audio_in_sample_rate=audio_in_sample_rate,
                audio_out_sample_rate=audio_out_sample_rate,
            ),
            enable_rtvi=False,
            idle_timeout_secs=None,
        )
        runner = PipelineRunner()
        session_record: dict[str, Any] = {}
        runner_task = asyncio.create_task(runner.run(task, auto_end=False))
        async def queue_prerecorded_intro() -> None:
            prewarm_task = asyncio.create_task(session.prewarm_conversation_tts_cache())
            session_record["prewarmTask"] = prewarm_task
            flow_manager_task = asyncio.create_task(session.get_flow_manager_adapter().initialize())
            greeting_preroll_ms = max(int(os.environ.get("ACC_SIP_GREETING_PREROLL_MS", "300")), 0)
            if greeting_preroll_ms:
                await asyncio.sleep(greeting_preroll_ms / 1000)
            session.record_stage(
                "greeting.media_preroll_completed",
                prerollMs=greeting_preroll_ms,
                reason="allow_ice_dtls_srtp_and_output_clock_to_stabilize",
            )
            intro_path = Path(os.environ.get("ACC_SIP_PRERECORDED_INTRO_PATH", str(DEFAULT_INTRO_AUDIO_PATH)))
            with wave.open(str(intro_path), "rb") as intro:
                if intro.getnchannels() != 1 or intro.getsampwidth() != 2:
                    raise RuntimeError("Prerecorded SIP intro must be mono 16-bit PCM WAV")
                intro_sample_rate = intro.getframerate()
                intro_pcm = intro.readframes(intro.getnframes())
            intro_context_id = f"prerecorded-intro-{call_id}"
            intro_chunk_bytes = intro_sample_rate * 2 * 20 // 1000
            session.begin_output_stream(stream_id=intro_context_id)
            intro_output_generation = session.output_generation
            intro_frames = [TTSStartedFrame(context_id=intro_context_id)]
            intro_chunk_count = 0
            for offset in range(0, len(intro_pcm), intro_chunk_bytes):
                audio_chunk = intro_pcm[offset:offset + intro_chunk_bytes]
                intro_chunk_count += 1
                session.extend_output_window(audio_bytes=len(audio_chunk), sample_rate=intro_sample_rate)
                session.record_agent_track(
                    audio_chunk,
                    sample_rate=intro_sample_rate,
                    event_id=f"prerecorded-intro-frame-{intro_chunk_count}",
                )
                session.record_output_chunk(len(audio_chunk))
                intro_frames.append(TTSAudioRawFrame(
                    audio=audio_chunk,
                    sample_rate=intro_sample_rate,
                    num_channels=1,
                    context_id=intro_context_id,
                ))
            intro_frames.append(TTSStoppedFrame(context_id=intro_context_id))
            await task.queue_frames(intro_frames)
            intro_duration_s = len(intro_pcm) / max(intro_sample_rate * 2, 1)
            greeting_text = os.environ.get("ACC_SIP_PRERECORDED_INTRO_TEXT", DEFAULT_INTRO_TEXT)

            async def finish_intro_output_stream() -> None:
                await asyncio.sleep(intro_duration_s)
                if (
                    session.output_stream_id == intro_context_id
                    and session.output_generation == intro_output_generation
                ):
                    session.finish_output_stream()
                    try:
                        await asyncio.to_thread(
                            json_http,
                            "POST",
                            f"{self.acc_url.rstrip('/')}/api/live-sip/events",
                            {
                                "eventType": "agent.greeting",
                                "timestamp": now_iso(),
                                "sipCallId": linked_sip_call_id or call_id,
                                "vertoCallId": call_id,
                                **({"linkedSipCallId": linked_sip_call_id} if linked_sip_call_id else {}),
                                **({"proofSipCallId": proof_sip_call_id} if proof_sip_call_id else {}),
                                **({"destinationNumber": destination_number} if destination_number else {}),
                                "conversationMode": conversation_mode,
                                "text": greeting_text,
                            },
                        )
                    except Exception as exc:
                        session.record_stage(
                            "greeting.evidence_post_failed",
                            ok=False,
                            error=str(exc),
                            streamId=intro_context_id,
                            outputGeneration=session.output_generation,
                        )
                    finally:
                        session.release_caller_turns("prerecorded_greeting_evidence_finished")
                    session.record_stage(
                        "tts.prerecorded_intro_completed",
                        streamId=intro_context_id,
                        outputGeneration=session.output_generation,
                        durationMs=round(intro_duration_s * 1000),
                    )
                else:
                    session.record_stage(
                        "tts.prerecorded_intro_interrupted",
                        streamId=intro_context_id,
                        queuedOutputGeneration=intro_output_generation,
                        outputGeneration=session.output_generation,
                        durationMs=round(intro_duration_s * 1000),
                        bargeIn=session.last_barge_in_evidence,
                    )
                    session.release_caller_turns("prerecorded_greeting_interrupted")

            asyncio.create_task(finish_intro_output_stream())
            session.record_stage(
                "tts.prerecorded_intro_queued",
                text=greeting_text,
                audioPath=str(intro_path),
                audioBytes=len(intro_pcm),
                chunkCount=intro_chunk_count,
                streamId=intro_context_id,
                sampleRate=intro_sample_rate,
                durationMs=round(len(intro_pcm) / (intro_sample_rate * 2) * 1000),
            )
            # Keep cache generation off the greeting's media clock. It normally
            # completes under the prerecorded intro or while the caller speaks.
            prewarm_task.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
            flow_manager_task.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)

        @connection.event_handler("connected")
        async def queue_intro_for_connected_peer(_connection: Any) -> None:
            verto_owns_greeting = os.environ.get("ACC_VERTO_OWNS_GREETING", "true").strip().lower() != "false"
            session.record_stage(
                "greeting.owner_selected",
                owner="pipecat_verto_bridge" if verto_owns_greeting else "freeswitch_esl_bridge",
                vertoOwnsGreeting=verto_owns_greeting,
            )
            if verto_owns_greeting:
                try:
                    await queue_prerecorded_intro()
                except Exception as exc:
                    session.record_stage("tts.prerecorded_intro_failed", ok=False, error=str(exc))
                    session.release_caller_turns("prerecorded_greeting_failed")
                    raise
            else:
                session.release_caller_turns("freeswitch_esl_bridge_owns_greeting")
        session_record.update(
            {
                "connection": connection,
                "transport": transport,
                "runner": runner,
                "runnerTask": runner_task,
                "pipelineTask": task,
                "turnSession": session,
                "callId": call_id,
                "vertoCallId": call_id,
                "sipCallId": linked_sip_call_id or call_id,
                "linkedSipCallId": linked_sip_call_id,
                "accCallId": acc_call_id,
                "sessionId": session_id,
                "startedAt": now_iso(),
                "closedAt": None,
                "closeReason": None,
            }
        )
        self.sessions[session_id] = session_record
        self.sessions[call_id] = session_record

        @connection.event_handler("closed")
        async def close_pipeline_for_peer(_connection: Any) -> None:
            asyncio.create_task(self.close_session(session_id, reason="verto_peer_closed"))

    async def close_session(self, session_id: str, *, reason: str = "verto session closed") -> None:
        session = self.sessions.get(session_id) or {}
        call_id = session.get("callId")
        linked_sip_call_id = session.get("linkedSipCallId")
        closed_at = now_iso()
        if session:
            session["closedAt"] = session.get("closedAt") or closed_at
            session["closeReason"] = session.get("closeReason") or reason
            closed_at = session["closedAt"]
        for key, value in list(self.sessions.items()):
            if value is session:
                self.sessions.pop(key, None)
        teardown_errors: list[dict[str, Any]] = []

        def record_teardown_error(stage: str, exc: BaseException) -> None:
            detail = {
                "at": now_iso(),
                "error": f"Verto session teardown failed during {stage}: {exc}",
                "callId": call_id,
                "sessionId": session_id,
                "reason": reason,
                "stage": stage,
            }
            teardown_errors.append(detail)
            self.last_error = detail
            print(json.dumps({"type": "verto.session_teardown.error", **detail}), flush=True)

        try:
            turn_session = session.get("turnSession")
            if isinstance(turn_session, AccVoicePipelineSession):
                try:
                    turn_session.write_track_recording_manifest(reason)
                except Exception as exc:
                    record_teardown_error("track_recording_manifest", exc)
                try:
                    turn_session.cancel_output("verto_peer_closed")
                    await turn_session.close_rtc_asr_stream(reason)
                except Exception as exc:
                    record_teardown_error("rtc_asr_close", exc)
            runner = session.get("runner")
            if isinstance(runner, PipelineRunner):
                try:
                    await runner.cancel(reason)
                except Exception as exc:
                    record_teardown_error("runner_cancel", exc)
            task = session.get("runnerTask")
            if isinstance(task, asyncio.Task):
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                except Exception as exc:
                    record_teardown_error("runner_task", exc)
            prewarm_task = session.get("prewarmTask")
            if isinstance(prewarm_task, asyncio.Task):
                prewarm_task.cancel()
                try:
                    await prewarm_task
                except asyncio.CancelledError:
                    pass
                except Exception as exc:
                    record_teardown_error("prewarm_task", exc)
        finally:
            if teardown_errors:
                self.write_proof_artifact("verto.session_teardown.error")
            if isinstance(call_id, str) and call_id:
                await self.end_acc_call(
                    call_id,
                    reason=reason,
                    timestamp=closed_at,
                    linked_sip_call_id=linked_sip_call_id if isinstance(linked_sip_call_id, str) else None,
                )

    def readiness_payload(self) -> dict[str, Any]:
        logged_in = bool(self.last_login.get("ok"))
        return {
            "ok": logged_in,
            "status": "registered_media_answer_ready" if logged_in else "blocked",
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
            "lastInvite": self.last_invite,
            "lastAnswer": self.last_answer,
            "lastError": self.last_error,
            "proofArtifactPath": str(self.proof_out) if self.proof_out else None,
            "reviewReady": False,
            "blockers": [] if logged_in else ["FreeSWITCH Verto login is not established."],
            "remainingMediaBlocker": "Verto signaling is configured and the sidecar can attempt a Pipecat-backed WebRTC answer, but caller-audible acceptance still requires a live 8600 proof showing rtc-asr final transcript and Kokoro/Pipecat playback heard by the caller.",
            "pipelineEvidence": list(self.pipeline_evidence.values()),
        }

    async def health(self, _request: web.Request) -> web.Response:
        payload = self.readiness_payload()
        return web.json_response(payload, status=200 if payload["ok"] else 503)

    def app(self) -> web.Application:
        app = web.Application()
        app.router.add_get("/health", self.health)
        app.router.add_get("/api/verto/readiness", self.health)
        return app


VertoAgentBridge = FreeSwitchVertoSignalingAdapter


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
    parser.add_argument("--acc-url", default=os.environ.get("ACC_URL", DEFAULT_ACC_URL))
    parser.add_argument("--proof-out", default=os.environ.get("PIPECAT_VERTO_PROOF_OUT"))
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--sdp-normalization-self-test", action="store_true")
    args = parser.parse_args()
    if args.sdp_normalization_self_test:
        return run_sdp_normalization_self_test()
    bridge = VertoAgentBridge(verto_url=args.verto_url, login=args.login, password=args.password, acc_url=args.acc_url, proof_out=args.proof_out)
    if args.check:
        async def check_once() -> int:
            started = time.monotonic()
            try:
                async with websockets.connect(args.verto_url, open_timeout=3, ping_interval=None) as ws:
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
