import { readFileSync } from "node:fs";
import path from "node:path";

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
  toolhiveVersion: string;
  policyPath: string;
  failClosedWebhook: boolean;
  agentApplyOfferForbidden: boolean;
  operatorDiscountPercentMax: number;
  manifestMatchesToolExposure: boolean;
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

  return {
    policyVersion: manifest.policyVersion,
    toolhiveVersion: manifest.toolhiveVersion,
    policyPath: path.join(policyBundleDir, manifest.policyFile),
    failClosedWebhook: manifest.webhook.failurePolicy === "fail",
    agentApplyOfferForbidden:
      manifest.principals.voice_agent?.forbiddenTools?.includes("retention.apply_offer") === true
      && cedarPolicy.includes('forbid (')
      && cedarPolicy.includes('action == Action::"retention.apply_offer"')
      && cedarPolicy.includes('principal.type == "voice_agent"'),
    operatorDiscountPercentMax: manifest.retentionBoundary.discountPercentMax,
    manifestMatchesToolExposure:
      JSON.stringify(manifest.principals.voice_agent?.allowedTools) === JSON.stringify(voiceAgentTools)
      && JSON.stringify(manifest.principals.operator?.allowedTools) === JSON.stringify(operatorTools)
      && [...declaredTools].every((tool) => knownTools.has(tool)),
  };
}
