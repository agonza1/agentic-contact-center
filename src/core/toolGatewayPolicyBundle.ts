import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { accToolDefinitions, listAccToolsForPrincipal } from "./toolGatewayTools";

interface ToolHivePolicyBundleManifest {
  policyVersion: string;
  toolhiveVersion: string;
  policyFile: string;
  webhook: {
    failurePolicy: string;
  };
  principals: Record<string, {
    allowedTools: string[];
    forbiddenTools?: string[];
  }>;
  retentionBoundary: {
    discountPercentMax: number;
  };
}

export interface ToolHivePolicyBundleSummary {
  policyVersion: string;
  policyHash: string;
  toolhiveVersion: string;
  policyPath: string;
  failClosedWebhook: boolean;
  validatingWebhookFailurePolicy: string;
  agentApplyOfferForbidden: boolean;
  operatorDiscountPercentMax: number;
  manifestMatchesToolExposure: boolean;
  ready: boolean;
  blockers: string[];
}

const defaultPolicyBundleDir = path.join(process.cwd(), "config", "toolhive");

function readPolicyManifest(policyBundleDir: string): ToolHivePolicyBundleManifest {
  return JSON.parse(readFileSync(path.join(policyBundleDir, "manifest.json"), "utf8")) as ToolHivePolicyBundleManifest;
}

export function summarizeToolHivePolicyBundle(policyBundleDir = defaultPolicyBundleDir): ToolHivePolicyBundleSummary {
  const manifest = readPolicyManifest(policyBundleDir);
  const cedarPolicy = readFileSync(path.join(policyBundleDir, manifest.policyFile), "utf8");
  const voiceAgentTools = listAccToolsForPrincipal("voice_agent").map((tool) => tool.name);
  const operatorTools = listAccToolsForPrincipal("operator").map((tool) => tool.name);
  const declaredTools = new Set(Object.values(manifest.principals).flatMap((principal) => principal.allowedTools));
  const knownTools: Set<string> = new Set(accToolDefinitions.map((tool) => tool.name));

  const failClosedWebhook = manifest.webhook.failurePolicy === "fail";
  const agentApplyOfferForbidden =
    manifest.principals.voice_agent?.forbiddenTools?.includes("retention.apply_offer") === true
    && cedarPolicy.includes('forbid (')
    && cedarPolicy.includes('action == Action::"retention.apply_offer"')
    && cedarPolicy.includes('principal.type == "voice_agent"');
  const manifestMatchesToolExposure =
    JSON.stringify(manifest.principals.voice_agent?.allowedTools) === JSON.stringify(voiceAgentTools)
    && JSON.stringify(manifest.principals.operator?.allowedTools) === JSON.stringify(operatorTools)
    && [...declaredTools].every((tool) => knownTools.has(tool));
  const operatorDiscountPercentMax = manifest.retentionBoundary.discountPercentMax;
  const blockers = [
    ...(failClosedWebhook ? [] : ["toolhive_webhook_not_fail_closed"]),
    ...(agentApplyOfferForbidden ? [] : ["voice_agent_apply_offer_not_forbidden"]),
    ...(operatorDiscountPercentMax === 10 ? [] : ["retention_discount_boundary_mismatch"]),
    ...(manifestMatchesToolExposure ? [] : ["toolhive_manifest_tool_exposure_mismatch"]),
  ];

  return {
    policyVersion: manifest.policyVersion,
    policyHash: createHash("sha256").update(cedarPolicy).digest("hex"),
    toolhiveVersion: manifest.toolhiveVersion,
    policyPath: path.join(policyBundleDir, manifest.policyFile),
    failClosedWebhook,
    validatingWebhookFailurePolicy: manifest.webhook.failurePolicy,
    agentApplyOfferForbidden,
    operatorDiscountPercentMax,
    manifestMatchesToolExposure,
    ready: blockers.length === 0,
    blockers,
  };
}
