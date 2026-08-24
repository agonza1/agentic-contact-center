import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG_PATH, loadPocConfig, resolvePocConfigPath } from "../src/config/loadPocConfig";

test("loadPocConfig reads the example config", () => {
  const config = loadPocConfig();

  assert.equal(config.demoName, "cluecon-2026-cancellation-rescue");
  assert.equal(config.mode, "mocked_telephony");
  assert.equal(config.provider.name, "signalwire");
  assert.equal(config.operator.channel, "demo-operator-console");
  assert.deepEqual(config.speechEnhancement, {
    enabled: false,
    provider: "none",
    placement: "disabled",
    targetAlgorithmicLatencyMs: null,
    featureFlag: "ACC_SPEECH_ENHANCEMENT_ENABLED",
  });
  assert.equal(DEFAULT_CONFIG_PATH.endsWith("config/poc.config.example.json"), true);
});

test("loadPocConfig accepts an enabled speech enhancement spike config", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "poc-config-"));
  const overridePath = path.join(tempDir, "speech-enhancement-poc.config.json");
  const config = loadPocConfig(DEFAULT_CONFIG_PATH);

  try {
    writeFileSync(
      overridePath,
      JSON.stringify({
        ...config,
        speechEnhancement: {
          enabled: true,
          provider: "laco_senet",
          placement: "rtc_asr_frontend",
          targetAlgorithmicLatencyMs: 25,
          featureFlag: "ACC_SPEECH_ENHANCEMENT_ENABLED",
        },
      }),
    );

    assert.equal(loadPocConfig(overridePath).speechEnhancement?.targetAlgorithmicLatencyMs, 25);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("loadPocConfig rejects enabled speech enhancement without an accepted latency target", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "poc-config-"));
  const overridePath = path.join(tempDir, "invalid-speech-enhancement-poc.config.json");
  const config = loadPocConfig(DEFAULT_CONFIG_PATH);

  try {
    writeFileSync(
      overridePath,
      JSON.stringify({
        ...config,
        speechEnhancement: {
          enabled: true,
          provider: "laco_senet",
          placement: "sidecar_preprocessor",
          targetAlgorithmicLatencyMs: 40,
          featureFlag: "ACC_SPEECH_ENHANCEMENT_ENABLED",
        },
      }),
    );

    assert.throws(() => loadPocConfig(overridePath), /Invalid speech enhancement config/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("loadPocConfig honors the default env override", () => {
  const originalPath = process.env.POC_CONFIG_PATH;
  const tempDir = mkdtempSync(path.join(tmpdir(), "poc-config-"));
  const overridePath = path.join(tempDir, "custom-poc.config.json");
  const config = loadPocConfig(DEFAULT_CONFIG_PATH);

  try {
    writeFileSync(overridePath, JSON.stringify({ ...config, demoName: "custom-demo" }));
    process.env.POC_CONFIG_PATH = overridePath;

    assert.equal(loadPocConfig().demoName, "custom-demo");
  } finally {
    if (originalPath === undefined) {
      delete process.env.POC_CONFIG_PATH;
    } else {
      process.env.POC_CONFIG_PATH = originalPath;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolvePocConfigPath honors a relative env override", () => {
  const resolvedPath = resolvePocConfigPath({ POC_CONFIG_PATH: "config/poc.config.example.json" });

  assert.equal(resolvedPath, DEFAULT_CONFIG_PATH);
});

test("resolvePocConfigPath falls back when the env override is blank", () => {
  const resolvedPath = resolvePocConfigPath({ POC_CONFIG_PATH: "   " });

  assert.equal(resolvedPath, DEFAULT_CONFIG_PATH);
});
