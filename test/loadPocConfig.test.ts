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
  assert.equal(DEFAULT_CONFIG_PATH.endsWith("config/poc.config.example.json"), true);
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
