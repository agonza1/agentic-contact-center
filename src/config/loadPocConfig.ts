import { readFileSync } from "node:fs";
import path from "node:path";

import type { PocConfig } from "../core/types";

const DEFAULT_CONFIG_PATH = path.resolve(
  process.cwd(),
  "config",
  "poc.config.example.json",
);

export function loadPocConfig(configPath = DEFAULT_CONFIG_PATH): PocConfig {
  const rawConfig = readFileSync(configPath, "utf8");
  const config = JSON.parse(rawConfig) as Partial<PocConfig>;

  if (!config.demoName || !config.provider?.name || !config.provider.callId) {
    throw new Error(`Invalid POC config at ${configPath}`);
  }

  if (!config.policy?.defaultSupervisorSteer || !config.policy.fallbackMode) {
    throw new Error(`Incomplete policy config at ${configPath}`);
  }

  if (!config.operator?.channel || !config.latencyBudgetsMs) {
    throw new Error(`Incomplete operator or latency config at ${configPath}`);
  }

  return config as PocConfig;
}

export { DEFAULT_CONFIG_PATH };
