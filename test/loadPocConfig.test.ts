import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG_PATH, loadPocConfig } from "../src/config/loadPocConfig";

test("loadPocConfig reads the example config", () => {
  const config = loadPocConfig();

  assert.equal(config.demoName, "cluecon-2026-cancellation-rescue");
  assert.equal(config.mode, "mocked_telephony");
  assert.equal(config.provider.name, "signalwire");
  assert.equal(config.operator.channel, "demo-operator-console");
  assert.equal(DEFAULT_CONFIG_PATH.endsWith("config/poc.config.example.json"), true);
});
