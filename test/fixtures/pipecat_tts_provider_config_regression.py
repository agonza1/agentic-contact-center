#!/usr/bin/env python3
"""Regression coverage for ACC Pipecat TTS provider selection."""

from __future__ import annotations

import importlib.util
import os
import sys
import types
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
PIPELINE_PATH = REPO_ROOT / "scripts" / "acc_pipecat_voice_pipeline.py"


def install_pipecat_stubs() -> None:
    def module(name: str) -> types.ModuleType:
        existing = sys.modules.get(name)
        if existing is not None:
            return existing
        created = types.ModuleType(name)
        sys.modules[name] = created
        if "." in name:
            parent_name, attr = name.rsplit(".", 1)
            setattr(module(parent_name), attr, created)
        return created

    for name in [
        "pipecat",
        "pipecat.audio",
        "pipecat.audio.turn",
        "pipecat.audio.turn.base_turn_analyzer",
        "pipecat.audio.turn.smart_turn",
        "pipecat.audio.turn.smart_turn.local_smart_turn_v3",
        "pipecat.frames",
        "pipecat.frames.frames",
        "pipecat.pipeline",
        "pipecat.pipeline.pipeline",
        "pipecat.processors",
        "pipecat.processors.frame_processor",
        "pipecat.turns",
        "pipecat.turns.user_start",
    ]:
        module(name)

    class _Frame:
        def __init__(self, *args: object, **kwargs: object) -> None:
            self.args = args
            self.__dict__.update(kwargs)

    frames = module("pipecat.frames.frames")
    for name in [
        "BotStartedSpeakingFrame",
        "BotStoppedSpeakingFrame",
        "InputAudioRawFrame",
        "InterruptionFrame",
        "TextFrame",
        "TranscriptionFrame",
        "TTSAudioRawFrame",
        "TTSStartedFrame",
        "TTSStoppedFrame",
    ]:
        setattr(frames, name, _Frame)

    module("pipecat.audio.turn.base_turn_analyzer").EndOfTurnState = types.SimpleNamespace(COMPLETE="complete")
    module("pipecat.audio.turn.smart_turn.local_smart_turn_v3").LocalSmartTurnAnalyzerV3 = type("LocalSmartTurnAnalyzerV3", (), {})
    module("pipecat.pipeline.pipeline").Pipeline = type("Pipeline", (), {})
    module("pipecat.processors.frame_processor").FrameDirection = types.SimpleNamespace(DOWNSTREAM="downstream", UPSTREAM="upstream")
    module("pipecat.processors.frame_processor").FrameProcessor = type("FrameProcessor", (), {})
    module("pipecat.turns.user_start").MinWordsUserTurnStartStrategy = type("MinWordsUserTurnStartStrategy", (), {})

    sys.modules.setdefault("audioop", types.ModuleType("audioop"))
    sys.modules.setdefault("websockets", types.ModuleType("websockets"))
    sys.path.insert(0, str(REPO_ROOT / "scripts"))


def load_pipeline_module(name: str, env: dict[str, str | None]) -> types.ModuleType:
    previous = {key: os.environ.get(key) for key in env}
    try:
        for key, value in env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        spec = importlib.util.spec_from_file_location(name, PIPELINE_PATH)
        assert spec and spec.loader
        loaded = importlib.util.module_from_spec(spec)
        sys.modules[name] = loaded
        spec.loader.exec_module(loaded)
        return loaded
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def main() -> None:
    install_pipecat_stubs()
    compose_empty = load_pipeline_module(
        "acc_pipecat_voice_pipeline_compose_empty",
        {
            "ACC_TTS_PROVIDER": "",
            "POCKET_TTS_BASE_URL": "http://pocket.test/v1",
        },
    )
    assert compose_empty.active_tts_provider() == "pocket"
    assert compose_empty.active_tts_config()["base_url"] == "http://pocket.test/v1"

    explicit_kokoro = load_pipeline_module(
        "acc_pipecat_voice_pipeline_explicit_kokoro",
        {
            "ACC_TTS_PROVIDER": " kokoro ",
            "POCKET_TTS_BASE_URL": "http://pocket.test/v1",
        },
    )
    assert explicit_kokoro.active_tts_provider() == "kokoro"

    no_pocket_url = load_pipeline_module(
        "acc_pipecat_voice_pipeline_no_pocket_url",
        {
            "ACC_TTS_PROVIDER": "",
            "POCKET_TTS_BASE_URL": None,
        },
    )
    assert no_pocket_url.active_tts_provider() == "kokoro"

    print({"ok": True, "composeEmptyProvider": "pocket"})


if __name__ == "__main__":
    main()
