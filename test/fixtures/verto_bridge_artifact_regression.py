#!/usr/bin/env python3
"""Regression proof for per-call Verto bridge proof artifacts."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / ".pipecat-runtime"))
sys.path.insert(0, str(REPO_ROOT / "scripts"))


def load_bridge_module():
    spec = importlib.util.spec_from_file_location("pipecat_verto_agent_bridge", REPO_ROOT / "scripts" / "pipecat-verto-agent-bridge.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("failed to load Verto bridge module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf8"))


def main() -> None:
    bridge_module = load_bridge_module()
    with tempfile.TemporaryDirectory(prefix="acc-verto-artifacts-") as artifact_dir:
        proof_out = Path(artifact_dir) / "verto-proof.json"
        bridge = bridge_module.VertoAgentBridge(
            verto_url="ws://127.0.0.1:8082",
            login="acc-verto",
            password="redacted",
            acc_url="http://127.0.0.1:8026",
            proof_out=str(proof_out),
        )
        nested_params = {
            "dialogParams": {
                "variables": {
                    "sip_h_X-ACC-Proof-Call-ID": "proof-call-1",
                    "acc_linked_sip_call_id": "linked-call-1",
                    "acc_destination_number": "8600",
                    "acc_conversation_mode": "openai_llm",
                    "caller_id_number": "+12025550123",
                    "Caller-Caller-ID-Number": "+12025550123",
                    "sip_from_user": "+12025550123",
                    "sip_from_uri": "sip:+12025550123@example.signalwire.test",
                    "variable_sip_from_uri": "sip:+12025550123@example.signalwire.test",
                    "sip_full_from": "\"Caller\" <sip:+12025550123@example.signalwire.test>",
                    "sip_h_P-Asserted-Identity": "<sip:+12025550123@example.signalwire.test>",
                    "variable_sip_h_P-Asserted-Identity": "<sip:+12025550123@example.signalwire.test>",
                    "sip_h_Remote-Party-ID": "\"Caller\" <sip:+12025550123@example.signalwire.test>",
                    "sip_h_Authorization": "Digest username=\"1000\", response=\"super-secret\"",
                    "acc_api_token": "token-secret",
                    "nested": {
                        "password": "do-not-persist",
                        "ani": "+12025550123",
                    },
                }
            }
        }
        sanitized_params = bridge_module.sanitize_verto_params(nested_params)
        bridge.last_login = {"ok": True}
        bridge.last_invite = {"callId": "call-a", "vertoCallId": "call-a", "sipCallId": "sip-a"}
        bridge.last_answer = {"callId": "call-a", "vertoCallId": "call-a", "sipCallId": "sip-a"}
        bridge.last_error = {"callId": "call-b", "vertoCallId": "call-b", "error": "call b failed"}
        bridge.pipeline_evidence = {
            "call-a": {"callId": "call-a", "vertoCallId": "call-a", "sipCallId": "sip-a", "stage": "stable"},
            "call-b": {"callId": "call-b", "vertoCallId": "call-b", "sipCallId": "sip-b", "stage": "initial"},
        }

        bridge.write_proof_artifact("seed")
        call_a_path = proof_out.parent / "calls" / "call-a" / proof_out.name
        call_b_path = proof_out.parent / "calls" / "call-b" / proof_out.name
        before_call_a = call_a_path.read_text(encoding="utf8")

        bridge.pipeline_evidence["call-b"]["stage"] = "updated"
        bridge.write_proof_artifact("verto.pipeline.stage", affected_artifact_ids=["call-b"])

        call_a = read_json(call_a_path)
        call_b = read_json(call_b_path)
        result = {
            "ok": (
                call_a_path.read_text(encoding="utf8") == before_call_a
                and call_a.get("lastError") == {}
                and call_b.get("lastError", {}).get("error") == "call b failed"
                and call_b.get("pipelineEvidence", [{}])[0].get("stage") == "updated"
                and bridge.proof_sip_call_id(nested_params) == "proof-call-1"
                and bridge.linked_sip_call_id(nested_params) == "linked-call-1"
                and bridge.destination_number(nested_params) == "8600"
                and bridge.conversation_mode(nested_params, "8600") == "openai_llm"
                and sanitized_params["dialogParams"]["variables"]["sip_h_Authorization"] == "<redacted secret>"
                and sanitized_params["dialogParams"]["variables"]["acc_api_token"] == "<redacted secret>"
                and sanitized_params["dialogParams"]["variables"]["nested"]["password"] == "<redacted secret>"
                and sanitized_params["dialogParams"]["variables"]["caller_id_number"] == "<redacted caller identity>"
                and sanitized_params["dialogParams"]["variables"]["Caller-Caller-ID-Number"] == "<redacted caller identity>"
                and sanitized_params["dialogParams"]["variables"]["sip_from_user"] == "<redacted caller identity>"
                and sanitized_params["dialogParams"]["variables"]["sip_from_uri"] == "<redacted caller identity>"
                and sanitized_params["dialogParams"]["variables"]["variable_sip_from_uri"] == "<redacted caller identity>"
                and sanitized_params["dialogParams"]["variables"]["sip_full_from"] == "<redacted caller identity>"
                and sanitized_params["dialogParams"]["variables"]["sip_h_P-Asserted-Identity"] == "<redacted caller identity>"
                and sanitized_params["dialogParams"]["variables"]["variable_sip_h_P-Asserted-Identity"] == "<redacted caller identity>"
                and sanitized_params["dialogParams"]["variables"]["sip_h_Remote-Party-ID"] == "<redacted caller identity>"
                and sanitized_params["dialogParams"]["variables"]["nested"]["ani"] == "<redacted caller identity>"
                and "+12025550123" not in json.dumps(sanitized_params)
            ),
            "callARewritten": call_a_path.read_text(encoding="utf8") != before_call_a,
            "callALastError": call_a.get("lastError"),
            "callBLastError": call_b.get("lastError"),
            "callBStage": call_b.get("pipelineEvidence", [{}])[0].get("stage"),
            "nestedProofSipCallId": bridge.proof_sip_call_id(nested_params),
            "nestedLinkedSipCallId": bridge.linked_sip_call_id(nested_params),
            "sanitizedParams": sanitized_params,
        }
        print(json.dumps(result))


if __name__ == "__main__":
    main()
