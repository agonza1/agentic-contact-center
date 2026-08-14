import { listAccToolsForPrincipal, type ToolGatewayPrincipalType } from "./toolGatewayTools";

export type ToolGatewayMode = "direct" | "toolhive";

export interface ToolGatewayToolExposure {
  principalType: ToolGatewayPrincipalType;
  tools: string[];
}

export interface ToolGatewayReadiness {
  mode: ToolGatewayMode;
  configured: boolean;
  ready: boolean;
  failClosed: boolean;
  mcpUrl: string | null;
  timeoutMs: number;
  policyVersion: string | null;
  toolExposure: ToolGatewayToolExposure[];
  blockers: string[];
  evidence: string;
}

const defaultToolGatewayTimeoutMs = 1500;
const defaultToolExposure: ToolGatewayToolExposure[] = [
  { principalType: "voice_agent", tools: listAccToolsForPrincipal("voice_agent").map((tool) => tool.name) },
  { principalType: "operator", tools: listAccToolsForPrincipal("operator").map((tool) => tool.name) },
];

function parseToolGatewayMode(rawMode: string | undefined): ToolGatewayMode | null {
  const normalized = rawMode?.trim().toLowerCase();
  if (!normalized) return "direct";
  if (normalized === "direct" || normalized === "toolhive") return normalized;
  return null;
}

function parseTimeoutMs(rawTimeout: string | undefined): number {
  const parsed = Number(rawTimeout ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultToolGatewayTimeoutMs;
  return Math.min(Math.max(Math.trunc(parsed), 50), 60_000);
}

export function buildToolGatewayReadiness(env: NodeJS.ProcessEnv = process.env): ToolGatewayReadiness {
  const parsedMode = parseToolGatewayMode(env.ACC_TOOL_GATEWAY_MODE);
  const timeoutMs = parseTimeoutMs(env.TOOLHIVE_TIMEOUT_MS);

  if (!parsedMode) {
    return {
      mode: "direct",
      configured: false,
      ready: false,
      failClosed: true,
      mcpUrl: null,
      timeoutMs,
      policyVersion: env.TOOLHIVE_POLICY_VERSION?.trim() || null,
      toolExposure: defaultToolExposure,
      blockers: ["invalid_ACC_TOOL_GATEWAY_MODE"],
      evidence: "ACC_TOOL_GATEWAY_MODE must be direct or toolhive; invalid values fail closed.",
    };
  }

  if (parsedMode === "direct") {
    return {
      mode: "direct",
      configured: true,
      ready: true,
      failClosed: false,
      mcpUrl: null,
      timeoutMs,
      policyVersion: env.TOOLHIVE_POLICY_VERSION?.trim() || null,
      toolExposure: defaultToolExposure,
      blockers: [],
      evidence: "Default direct tool execution is active; no ToolHive service is required.",
    };
  }

  const mcpUrl = env.TOOLHIVE_MCP_URL?.trim() || "";
  const policyVersion = env.TOOLHIVE_POLICY_VERSION?.trim() || "";
  const blockers: string[] = [];

  if (!mcpUrl) {
    blockers.push("missing_TOOLHIVE_MCP_URL");
  } else {
    try {
      const parsedUrl = new URL(mcpUrl);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        blockers.push("invalid_TOOLHIVE_MCP_URL");
      }
    } catch {
      blockers.push("invalid_TOOLHIVE_MCP_URL");
    }
  }

  if (!policyVersion) blockers.push("missing_TOOLHIVE_POLICY_VERSION");

  return {
    mode: "toolhive",
    configured: blockers.length === 0,
    ready: blockers.length === 0,
    failClosed: true,
    mcpUrl: mcpUrl || null,
    timeoutMs,
    policyVersion: policyVersion || null,
    toolExposure: defaultToolExposure,
    blockers,
    evidence: blockers.length === 0
      ? "ToolHive mode has the minimum required configuration; gateway failures must not downgrade to direct execution."
      : "ToolHive mode is selected but incomplete; consequential tools must fail closed instead of falling back to direct execution.",
  };
}
