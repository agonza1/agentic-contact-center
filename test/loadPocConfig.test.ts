import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG_PATH, loadPocConfig, resolvePocConfigPath } from "../src/config/loadPocConfig";

test("loadPocConfig reads the example config", () => {
  const config = loadPocConfig();

  assert.equal(config.demoName, "cluecon-2026-cancellation-rescue");
  assert.equal(config.mode, "mocked_telephony");
  assert.equal(config.provider.name, "signalwire");
  assert.equal(config.operator.channel, "demo-operator-console");
  assert.equal(DEFAULT_CONFIG_PATH.endsWith("config/poc.config.example.json"), true);
});


test("resolvePocConfigPath honors a relative env override", () => {
  const resolvedPath = resolvePocConfigPath({ POC_CONFIG_PATH: "config/poc.config.example.json" });

  assert.equal(resolvedPath, DEFAULT_CONFIG_PATH);
});

test("resolvePocConfigPath falls back when the env override is blank", () => {
  const resolvedPath = resolvePocConfigPath({ POC_CONFIG_PATH: "   " });

  assert.equal(resolvedPath, DEFAULT_CONFIG_PATH);
});
