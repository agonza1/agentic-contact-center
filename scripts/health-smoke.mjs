function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:8026/health',
    timeoutMs: 10000,
    intervalMs: 250,
    expectDemoName: undefined,
    expectMode: undefined,
    expectProvider: undefined,
    expectPolicyProfile: undefined,
    expectPolicyToolScope: undefined,
    expectOperatorChannel: undefined,
    expectFallbackMode: undefined,
    expectPipecatReady: undefined,
    expectPipecatPrototypeMode: undefined,
    expectPipecatTransport: undefined,
    expectPipecatRuntimeEngine: undefined,
    expectPipecatCredentialsMode: undefined,
    expectPipecatRuntimeCheckCommand: undefined,
    expectPipecatRuntimeCheckInstallCommand: undefined,
    expectPipecatRuntimeCheckLiveTelephonyRequired: undefined,
    expectPipecatActiveTool: undefined,
    expectPipecatScriptCompleted: undefined,
    expectProductionReady: undefined,
    expectProductionReadinessBlockers: [],
    expectSpeechEnhancementRuntimeEnabled: undefined,
    expectSpeechEnhancementRuntimeStatus: undefined,
    expectSpeechEnhancementIssueCloseReady: undefined,
    expectSpeechEnhancementLiveDemoGate: undefined,
    expectSpeechEnhancementRecommendedLatencyMs: undefined,
    expectSpeechEnhancementRuntimeLatencyMs: undefined,
    expectSpeechEnhancementRuntimeBypassReason: undefined,
    expectSpeechEnhancementRuntimeProfileExpectedUse: undefined,
    expectSpeechEnhancementRuntimeProfileRecommendation: undefined,
    expectSpeechEnhancementRuntimeProfileBypassWhen: [],
    expectSpeechEnhancementRuntimeBypassReasons: [],
    expectSpeechEnhancementRuntimeLiveDemoEligible: undefined,
    expectSpeechEnhancementRuntimeLookaheadFrames: undefined,
    expectSpeechEnhancementRuntimeMaxBufferedAudioMs: undefined,
    expectSpeechEnhancementCloseGateRequiredLatencyMs: undefined,
    expectSpeechEnhancementCloseGateMaxAddedTurnLatencyMsP95: undefined,
    expectSpeechEnhancementCloseGateMaxCpuPercentP95: undefined,
    expectRuntimeSeams: [],
    expectPipecatTools: [],
    expectSpeechEnhancementMissingEvidence: [],
    expectSpeechEnhancementBlockers: [],
    expectSpeechEnhancementPassingReplayIds: [],
    expectSpeechEnhancementBlockedReplayIds: [],
    expectLatencyBudgetsMs: [],
    expectLatencyBudgetMaxMs: [],
  };

  const valueFlags = new Set([
    '--url',
    '--timeout-ms',
    '--interval-ms',
    '--expect-demo-name',
    '--expect-mode',
    '--expect-provider',
    '--expect-policy-profile',
    '--expect-policy-tool-scope',
    '--expect-operator-channel',
    '--expect-fallback-mode',
    '--expect-pipecat-ready',
    '--expect-pipecat-prototype-mode',
    '--expect-pipecat-transport',
    '--expect-pipecat-runtime-engine',
    '--expect-pipecat-credentials-mode',
    '--expect-pipecat-runtime-check-command',
    '--expect-pipecat-runtime-check-install-command',
    '--expect-pipecat-runtime-check-live-telephony-required',
    '--expect-pipecat-active-tool',
    '--expect-pipecat-script-completed',
    '--expect-production-ready',
    '--expect-production-readiness-blocker',
    '--expect-speech-enhancement-runtime-enabled',
    '--expect-speech-enhancement-runtime-status',
    '--expect-speech-enhancement-issue-close-ready',
    '--expect-speech-enhancement-live-demo-gate',
    '--expect-speech-enhancement-recommended-latency-ms',
    '--expect-speech-enhancement-runtime-latency-ms',
    '--expect-speech-enhancement-runtime-bypass-reason',
    '--expect-speech-enhancement-runtime-profile-expected-use',
    '--expect-speech-enhancement-runtime-profile-recommendation',
    '--expect-speech-enhancement-runtime-profile-bypass-when',
    '--expect-speech-enhancement-runtime-bypass-reason-item',
    '--expect-speech-enhancement-runtime-live-demo-eligible',
    '--expect-speech-enhancement-runtime-lookahead-frames',
    '--expect-speech-enhancement-runtime-max-buffered-audio-ms',
    '--expect-speech-enhancement-close-gate-required-latency-ms',
    '--expect-speech-enhancement-close-gate-max-added-turn-latency-ms-p95',
    '--expect-speech-enhancement-close-gate-max-cpu-percent-p95',
    '--expect-speech-enhancement-missing-evidence',
    '--expect-speech-enhancement-blocker',
    '--expect-speech-enhancement-passing-replay-id',
    '--expect-speech-enhancement-blocked-replay-id',
    '--expect-runtime-seam',
    '--expect-pipecat-tool',
    '--expect-latency-budget-ms',
    '--expect-latency-budget-max-ms',
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (!valueFlags.has(arg)) {
      throw new Error(`unknown_argument(${JSON.stringify(arg)})`);
    }

    if (next === undefined || next.startsWith('--')) {
      throw new Error(`missing_value(${JSON.stringify(arg)})`);
    }

    if (arg === '--url' && next) {
      args.url = next;
      index += 1;
      continue;
    }

    if (arg === '--timeout-ms' && next) {
      const invalidTimeoutMs = validatePositiveIntegerOption('timeout_ms', next);
      if (invalidTimeoutMs) {
        throw new Error(invalidTimeoutMs);
      }

      args.timeoutMs = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (arg === '--interval-ms' && next) {
      const invalidIntervalMs = validatePositiveIntegerOption('interval_ms', next);
      if (invalidIntervalMs) {
        throw new Error(invalidIntervalMs);
      }

      args.intervalMs = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (arg === '--expect-demo-name' && next) {
      args.expectDemoName = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-mode' && next) {
      args.expectMode = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-provider' && next) {
      args.expectProvider = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-policy-profile' && next) {
      args.expectPolicyProfile = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-policy-tool-scope' && next) {
      args.expectPolicyToolScope = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-operator-channel' && next) {
      args.expectOperatorChannel = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-fallback-mode' && next) {
      args.expectFallbackMode = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-pipecat-ready' && next) {
      args.expectPipecatReady = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-pipecat-prototype-mode' && next) {
      args.expectPipecatPrototypeMode = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-pipecat-transport' && next) {
      args.expectPipecatTransport = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-pipecat-runtime-engine' && next) {
      args.expectPipecatRuntimeEngine = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-pipecat-credentials-mode' && next) {
      args.expectPipecatCredentialsMode = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-pipecat-runtime-check-command' && next) {
      args.expectPipecatRuntimeCheckCommand = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-pipecat-runtime-check-install-command' && next) {
      args.expectPipecatRuntimeCheckInstallCommand = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-pipecat-runtime-check-live-telephony-required' && next) {
      args.expectPipecatRuntimeCheckLiveTelephonyRequired = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-pipecat-active-tool' && next) {
      args.expectPipecatActiveTool = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-pipecat-script-completed' && next) {
      args.expectPipecatScriptCompleted = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-production-ready' && next) {
      args.expectProductionReady = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-production-readiness-blocker' && next) {
      args.expectProductionReadinessBlockers.push(next);
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-runtime-enabled' && next) {
      args.expectSpeechEnhancementRuntimeEnabled = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-runtime-status' && next) {
      args.expectSpeechEnhancementRuntimeStatus = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-issue-close-ready' && next) {
      args.expectSpeechEnhancementIssueCloseReady = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-live-demo-gate' && next) {
      args.expectSpeechEnhancementLiveDemoGate = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-recommended-latency-ms' && next) {
      args.expectSpeechEnhancementRecommendedLatencyMs = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-runtime-latency-ms' && next) {
      args.expectSpeechEnhancementRuntimeLatencyMs = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-runtime-bypass-reason' && next) {
      args.expectSpeechEnhancementRuntimeBypassReason = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-runtime-profile-expected-use' && next) {
      args.expectSpeechEnhancementRuntimeProfileExpectedUse = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-runtime-profile-recommendation' && next) {
      args.expectSpeechEnhancementRuntimeProfileRecommendation = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-runtime-profile-bypass-when' && next) {
      args.expectSpeechEnhancementRuntimeProfileBypassWhen.push(next);
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-runtime-bypass-reason-item' && next) {
      args.expectSpeechEnhancementRuntimeBypassReasons.push(next);
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-runtime-live-demo-eligible' && next) {
      args.expectSpeechEnhancementRuntimeLiveDemoEligible = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-runtime-lookahead-frames' && next) {
      args.expectSpeechEnhancementRuntimeLookaheadFrames = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-runtime-max-buffered-audio-ms' && next) {
      args.expectSpeechEnhancementRuntimeMaxBufferedAudioMs = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-close-gate-required-latency-ms' && next) {
      args.expectSpeechEnhancementCloseGateRequiredLatencyMs = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-close-gate-max-added-turn-latency-ms-p95' && next) {
      args.expectSpeechEnhancementCloseGateMaxAddedTurnLatencyMsP95 = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-close-gate-max-cpu-percent-p95' && next) {
      args.expectSpeechEnhancementCloseGateMaxCpuPercentP95 = next;
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-missing-evidence' && next) {
      args.expectSpeechEnhancementMissingEvidence.push(next);
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-blocker' && next) {
      args.expectSpeechEnhancementBlockers.push(next);
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-passing-replay-id' && next) {
      args.expectSpeechEnhancementPassingReplayIds.push(next);
      index += 1;
      continue;
    }

    if (arg === '--expect-speech-enhancement-blocked-replay-id' && next) {
      args.expectSpeechEnhancementBlockedReplayIds.push(next);
      index += 1;
      continue;
    }

    if (arg === '--expect-runtime-seam' && next) {
      args.expectRuntimeSeams.push(next);
      index += 1;
      continue;
    }

    if (arg === '--expect-pipecat-tool' && next) {
      args.expectPipecatTools.push(next);
      index += 1;
      continue;
    }

    if (arg === '--expect-latency-budget-ms' && next) {
      args.expectLatencyBudgetsMs.push(next);
      index += 1;
      continue;
    }

    if (arg === '--expect-latency-budget-max-ms' && next) {
      args.expectLatencyBudgetMaxMs.push(next);
      index += 1;
    }
  }

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function hasJsonExpectations(args) {
  return [
    args.expectDemoName,
    args.expectMode,
    args.expectProvider,
    args.expectPolicyProfile,
    args.expectPolicyToolScope,
    args.expectOperatorChannel,
    args.expectFallbackMode,
    args.expectPipecatReady,
    args.expectPipecatPrototypeMode,
    args.expectPipecatTransport,
    args.expectPipecatRuntimeEngine,
    args.expectPipecatCredentialsMode,
    args.expectPipecatRuntimeCheckCommand,
    args.expectPipecatRuntimeCheckInstallCommand,
    args.expectPipecatRuntimeCheckLiveTelephonyRequired,
    args.expectPipecatActiveTool,
    args.expectPipecatScriptCompleted,
    args.expectProductionReady,
    args.expectSpeechEnhancementRuntimeEnabled,
    args.expectSpeechEnhancementIssueCloseReady,
    args.expectSpeechEnhancementLiveDemoGate,
    args.expectSpeechEnhancementRecommendedLatencyMs,
    args.expectSpeechEnhancementRuntimeLatencyMs,
    args.expectSpeechEnhancementRuntimeBypassReason,
    args.expectSpeechEnhancementRuntimeProfileExpectedUse,
    args.expectSpeechEnhancementRuntimeProfileRecommendation,
    args.expectSpeechEnhancementRuntimeLiveDemoEligible,
    args.expectSpeechEnhancementRuntimeLookaheadFrames,
    args.expectSpeechEnhancementRuntimeMaxBufferedAudioMs,
  ].some((expectedValue) => expectedValue !== undefined)
    || args.expectProductionReadinessBlockers.length > 0
    || args.expectSpeechEnhancementRuntimeBypassReasons.length > 0
    || args.expectRuntimeSeams.length > 0
    || args.expectPipecatTools.length > 0
    || args.expectSpeechEnhancementMissingEvidence.length > 0
    || args.expectSpeechEnhancementBlockers.length > 0
    || args.expectSpeechEnhancementPassingReplayIds.length > 0
    || args.expectSpeechEnhancementBlockedReplayIds.length > 0
    || args.expectLatencyBudgetsMs.length > 0
    || args.expectLatencyBudgetMaxMs.length > 0;
}

function parseBooleanExpectation(flagName, rawValue) {
  if (rawValue === 'true') {
    return { expectedValue: true };
  }

  if (rawValue === 'false') {
    return { expectedValue: false };
  }

  return { error: `invalid_${flagName}_value(${JSON.stringify(rawValue)})` };
}

function parseLatencyBudgetExpectation(rawExpectation) {
  const [name, rawValue, ...extraParts] = rawExpectation.split('=');

  if (!name || rawValue === undefined || extraParts.length > 0) {
    return { error: `invalid_latency_budget_expectation(${JSON.stringify(rawExpectation)})` };
  }

  const expectedValue = Number.parseInt(rawValue, 10);

  if (!Number.isFinite(expectedValue) || String(expectedValue) !== rawValue || expectedValue < 0) {
    return { error: `invalid_latency_budget_value(${JSON.stringify(rawExpectation)})` };
  }

  return { name, expectedValue };
}

function isStrictPositiveInteger(rawValue) {
  return /^\d+$/.test(rawValue) && Number.parseInt(rawValue, 10) > 0;
}

function validatePositiveIntegerOption(flagName, rawValue) {
  if (!isStrictPositiveInteger(String(rawValue))) {
    return 'invalid_' + flagName + '_value(' + JSON.stringify(String(rawValue)) + ')';
  }

  return null;
}

function validateLatencyBudgetExpectations(args) {
  for (const rawExpectation of [...args.expectLatencyBudgetsMs, ...args.expectLatencyBudgetMaxMs]) {
    const parsedExpectation = parseLatencyBudgetExpectation(rawExpectation);
    if (parsedExpectation.error) {
      return parsedExpectation.error;
    }
  }

  return null;
}

function parseFiniteNumberExpectation(flagName, rawValue) {
  const expectedValue = Number(rawValue);

  if (!Number.isFinite(expectedValue)) {
    return { error: `invalid_${flagName}_value(${JSON.stringify(rawValue)})` };
  }

  return { expectedValue };
}

function validateNumberExpectations(args) {
  const numberExpectations = [
    ['speech_enhancement_recommended_latency_ms', args.expectSpeechEnhancementRecommendedLatencyMs],
    ['speech_enhancement_runtime_latency_ms', args.expectSpeechEnhancementRuntimeLatencyMs],
    ['speech_enhancement_runtime_lookahead_frames', args.expectSpeechEnhancementRuntimeLookaheadFrames],
    ['speech_enhancement_runtime_max_buffered_audio_ms', args.expectSpeechEnhancementRuntimeMaxBufferedAudioMs],
  ];

  for (const [flagName, rawValue] of numberExpectations) {
    if (rawValue === undefined) {
      continue;
    }

    const parsedExpectation = parseFiniteNumberExpectation(flagName, rawValue);
    if (parsedExpectation.error) {
      return parsedExpectation.error;
    }
  }

  return null;
}

function validateBooleanExpectations(args) {
  const booleanExpectations = [
    ['pipecat_ready', args.expectPipecatReady],
    ['pipecat_script_completed', args.expectPipecatScriptCompleted],
    ['pipecat_runtime_check_live_telephony_required', args.expectPipecatRuntimeCheckLiveTelephonyRequired],
    ['production_ready', args.expectProductionReady],
    ['speech_enhancement_runtime_enabled', args.expectSpeechEnhancementRuntimeEnabled],
    ['speech_enhancement_issue_close_ready', args.expectSpeechEnhancementIssueCloseReady],
    ['speech_enhancement_runtime_live_demo_eligible', args.expectSpeechEnhancementRuntimeLiveDemoEligible],
  ];

  for (const [flagName, rawValue] of booleanExpectations) {
    if (rawValue === undefined) {
      continue;
    }

    const parsedExpectation = parseBooleanExpectation(flagName, rawValue);
    if (parsedExpectation.error) {
      return parsedExpectation.error;
    }
  }

  return null;
}

async function getFailureReason(response, args) {
  const contentType = response.headers.get('content-type') || '';

  if (!response.ok) {
    return `http_${response.status}`;
  }

  if (!contentType.toLowerCase().includes('application/json')) {
    return hasJsonExpectations(args) ? 'json_payload_required' : null;
  }

  let payload = null;

  try {
    payload = await response.json();

    if (payload && typeof payload === 'object' && 'ok' in payload && payload.ok !== true) {
      return 'json_ok_false';
    }
  } catch {
    return 'invalid_json';
  }

  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const expectations = [
    ['demoName', args.expectDemoName],
    ['mode', args.expectMode],
    ['provider', args.expectProvider],
    ['policyProfile', args.expectPolicyProfile],
    ['policyToolScope', args.expectPolicyToolScope],
    ['operatorChannel', args.expectOperatorChannel],
    ['fallbackMode', args.expectFallbackMode],
  ];

  for (const [field, expectedValue] of expectations) {
    if (expectedValue === undefined) {
      continue;
    }

    if (payload[field] !== expectedValue) {
      return `json_${field}_mismatch(expected=${JSON.stringify(expectedValue)},actual=${JSON.stringify(payload[field])})`;
    }
  }

  for (const expectedRuntimeSeam of args.expectRuntimeSeams) {
    const runtimeSeams = payload.runtimeSeams;

    if (!Array.isArray(runtimeSeams) || !runtimeSeams.includes(expectedRuntimeSeam)) {
      return `json_runtimeSeams_missing(expected=${JSON.stringify(expectedRuntimeSeam)},actual=${JSON.stringify(runtimeSeams)})`;
    }
  }


  if (args.expectPipecatReady !== undefined) {
    const parsedExpectation = parseBooleanExpectation('pipecat_ready', args.expectPipecatReady);
    if (parsedExpectation.error) {
      return parsedExpectation.error;
    }

    const pipecatFlow = payload.pipecatFlow;
    const actualValue = pipecatFlow && typeof pipecatFlow === 'object'
      ? pipecatFlow.ready
      : undefined;

    if (actualValue !== parsedExpectation.expectedValue) {
      return `json_pipecatFlow_ready_mismatch(expected=${JSON.stringify(parsedExpectation.expectedValue)},actual=${JSON.stringify(actualValue)})`;
    }
  }

  if (args.expectPipecatScriptCompleted !== undefined) {
    const parsedExpectation = parseBooleanExpectation('pipecat_script_completed', args.expectPipecatScriptCompleted);
    if (parsedExpectation.error) {
      return parsedExpectation.error;
    }

    const pipecatFlow = payload.pipecatFlow;
    const script = pipecatFlow && typeof pipecatFlow === 'object' && pipecatFlow.script && typeof pipecatFlow.script === 'object'
      ? pipecatFlow.script
      : undefined;
    const actualValue = script ? script.completed : undefined;

    if (actualValue !== parsedExpectation.expectedValue) {
      return `json_pipecatFlow_script_completed_mismatch(expected=${JSON.stringify(parsedExpectation.expectedValue)},actual=${JSON.stringify(actualValue)})`;
    }
  }

  if (args.expectProductionReady !== undefined) {
    const parsedExpectation = parseBooleanExpectation('production_ready', args.expectProductionReady);
    if (parsedExpectation.error) {
      return parsedExpectation.error;
    }

    const productionReadiness = payload.productionReadiness && typeof payload.productionReadiness === 'object'
      ? payload.productionReadiness
      : undefined;
    const actualValue = productionReadiness ? productionReadiness.productionReady : undefined;

    if (actualValue !== parsedExpectation.expectedValue) {
      return `json_productionReadiness_productionReady_mismatch(expected=${JSON.stringify(parsedExpectation.expectedValue)},actual=${JSON.stringify(actualValue)})`;
    }
  }

  for (const expectedBlocker of args.expectProductionReadinessBlockers) {
    const productionReadiness = payload.productionReadiness && typeof payload.productionReadiness === 'object'
      ? payload.productionReadiness
      : undefined;
    const blockers = productionReadiness ? productionReadiness.blockers : undefined;

    if (!Array.isArray(blockers) || !blockers.includes(expectedBlocker)) {
      return `json_productionReadiness_blockers_missing(expected=${JSON.stringify(expectedBlocker)},actual=${JSON.stringify(blockers)})`;
    }
  }

  const pipecatFlowExpectations = [
    ['prototypeMode', args.expectPipecatPrototypeMode],
    ['transport', args.expectPipecatTransport],
    ['runtimeEngine', args.expectPipecatRuntimeEngine],
    ['credentialsMode', args.expectPipecatCredentialsMode],
    ['activeTool', args.expectPipecatActiveTool],
  ];

  for (const [field, expectedValue] of pipecatFlowExpectations) {
    if (expectedValue === undefined) {
      continue;
    }

    const pipecatFlow = payload.pipecatFlow;
    const actualValue = pipecatFlow && typeof pipecatFlow === 'object'
      ? pipecatFlow[field]
      : undefined;

    if (actualValue !== expectedValue) {
      return `json_pipecatFlow_${field}_mismatch(expected=${JSON.stringify(expectedValue)},actual=${JSON.stringify(actualValue)})`;
    }
  }

  for (const expectedPipecatTool of args.expectPipecatTools) {
    const toolCoverage = payload.pipecatFlow && typeof payload.pipecatFlow === 'object'
      ? payload.pipecatFlow.toolCoverage
      : undefined;

    if (!Array.isArray(toolCoverage) || !toolCoverage.includes(expectedPipecatTool)) {
      return `json_pipecatFlow_toolCoverage_missing(expected=${JSON.stringify(expectedPipecatTool)},actual=${JSON.stringify(toolCoverage)})`;
    }
  }

  const speechEnhancementStringExpectations = [
    ['liveDemoGate', args.expectSpeechEnhancementLiveDemoGate],
    ['runtimeStatus', args.expectSpeechEnhancementRuntimeStatus],
    ['runtimeBypassReason', args.expectSpeechEnhancementRuntimeBypassReason],
    ['runtimeProfileExpectedUse', args.expectSpeechEnhancementRuntimeProfileExpectedUse],
    ['runtimeProfileRecommendation', args.expectSpeechEnhancementRuntimeProfileRecommendation],
  ];

  for (const [field, expectedValue] of speechEnhancementStringExpectations) {
    if (expectedValue === undefined) {
      continue;
    }

    const speechEnhancement = payload.speechEnhancement && typeof payload.speechEnhancement === 'object'
      ? payload.speechEnhancement
      : undefined;
    const actualValue = speechEnhancement ? speechEnhancement[field] : undefined;

    if (actualValue !== expectedValue) {
      return `json_speechEnhancement_${field}_mismatch(expected=${JSON.stringify(expectedValue)},actual=${JSON.stringify(actualValue)})`;
    }
  }

  const speechEnhancementBooleanExpectations = [
    ['runtimeEnabled', 'speech_enhancement_runtime_enabled', args.expectSpeechEnhancementRuntimeEnabled],
    ['issueCloseReady', 'speech_enhancement_issue_close_ready', args.expectSpeechEnhancementIssueCloseReady],
    ['runtimeLiveDemoEligible', 'speech_enhancement_runtime_live_demo_eligible', args.expectSpeechEnhancementRuntimeLiveDemoEligible],
  ];

  for (const [field, flagName, rawExpectedValue] of speechEnhancementBooleanExpectations) {
    if (rawExpectedValue === undefined) {
      continue;
    }

    const parsedExpectation = parseBooleanExpectation(flagName, rawExpectedValue);
    if (parsedExpectation.error) {
      return parsedExpectation.error;
    }

    const speechEnhancement = payload.speechEnhancement && typeof payload.speechEnhancement === 'object'
      ? payload.speechEnhancement
      : undefined;
    const actualValue = speechEnhancement ? speechEnhancement[field] : undefined;

    if (actualValue !== parsedExpectation.expectedValue) {
      return `json_speechEnhancement_${field}_mismatch(expected=${JSON.stringify(parsedExpectation.expectedValue)},actual=${JSON.stringify(actualValue)})`;
    }
  }

  const speechEnhancementNumberExpectations = [
    ['recommendedLatencyMs', 'speech_enhancement_recommended_latency_ms', args.expectSpeechEnhancementRecommendedLatencyMs],
    ['runtimeLatencyMs', 'speech_enhancement_runtime_latency_ms', args.expectSpeechEnhancementRuntimeLatencyMs],
    ['runtimeLookaheadFrames', 'speech_enhancement_runtime_lookahead_frames', args.expectSpeechEnhancementRuntimeLookaheadFrames],
    ['runtimeMaxBufferedAudioMs', 'speech_enhancement_runtime_max_buffered_audio_ms', args.expectSpeechEnhancementRuntimeMaxBufferedAudioMs],
    ['closeGateRequiredLatencyMs', 'speech_enhancement_close_gate_required_latency_ms', args.expectSpeechEnhancementCloseGateRequiredLatencyMs],
    ['closeGateMaxAddedTurnLatencyMsP95', 'speech_enhancement_close_gate_max_added_turn_latency_ms_p95', args.expectSpeechEnhancementCloseGateMaxAddedTurnLatencyMsP95],
    ['closeGateMaxCpuPercentP95', 'speech_enhancement_close_gate_max_cpu_percent_p95', args.expectSpeechEnhancementCloseGateMaxCpuPercentP95],
  ];

  for (const [field, flagName, rawExpectedValue] of speechEnhancementNumberExpectations) {
    if (rawExpectedValue === undefined) {
      continue;
    }

    const parsedExpectation = parseFiniteNumberExpectation(flagName, rawExpectedValue);
    if (parsedExpectation.error) {
      return parsedExpectation.error;
    }

    const speechEnhancement = payload.speechEnhancement && typeof payload.speechEnhancement === 'object'
      ? payload.speechEnhancement
      : undefined;
    const actualValue = speechEnhancement ? speechEnhancement[field] : undefined;

    if (actualValue !== parsedExpectation.expectedValue) {
      return `json_speechEnhancement_${field}_mismatch(expected=${JSON.stringify(parsedExpectation.expectedValue)},actual=${JSON.stringify(actualValue)})`;
    }
  }

  for (const expectedBypassReason of args.expectSpeechEnhancementRuntimeBypassReasons) {
    const bypassReasons = payload.speechEnhancement && typeof payload.speechEnhancement === 'object'
      ? payload.speechEnhancement.runtimeBypassReasons
      : undefined;

    if (!Array.isArray(bypassReasons) || !bypassReasons.includes(expectedBypassReason)) {
      return `json_speechEnhancement_runtimeBypassReasons_missing(expected=${JSON.stringify(expectedBypassReason)},actual=${JSON.stringify(bypassReasons)})`;
    }
  }

  for (const expectedProfileBypass of args.expectSpeechEnhancementRuntimeProfileBypassWhen) {
    const profileBypassWhen = payload.speechEnhancement && typeof payload.speechEnhancement === 'object'
      ? payload.speechEnhancement.runtimeProfileBypassWhen
      : undefined;

    if (!Array.isArray(profileBypassWhen) || !profileBypassWhen.includes(expectedProfileBypass)) {
      return `json_speechEnhancement_runtimeProfileBypassWhen_missing(expected=${JSON.stringify(expectedProfileBypass)},actual=${JSON.stringify(profileBypassWhen)})`;
    }
  }

  for (const expectedEvidence of args.expectSpeechEnhancementMissingEvidence) {
    const missingEvidence = payload.speechEnhancement && typeof payload.speechEnhancement === 'object'
      ? payload.speechEnhancement.missingEvidence
      : undefined;

    if (!Array.isArray(missingEvidence) || !missingEvidence.includes(expectedEvidence)) {
      return `json_speechEnhancement_missingEvidence_missing(expected=${JSON.stringify(expectedEvidence)},actual=${JSON.stringify(missingEvidence)})`;
    }
  }

  for (const expectedBlocker of args.expectSpeechEnhancementBlockers) {
    const blockers = payload.speechEnhancement && typeof payload.speechEnhancement === 'object'
      ? payload.speechEnhancement.blockers
      : undefined;

    if (!Array.isArray(blockers) || !blockers.includes(expectedBlocker)) {
      return `json_speechEnhancement_blockers_missing(expected=${JSON.stringify(expectedBlocker)},actual=${JSON.stringify(blockers)})`;
    }
  }

  for (const expectedReplayId of args.expectSpeechEnhancementPassingReplayIds) {
    const replayIds = payload.speechEnhancement && typeof payload.speechEnhancement === 'object'
      ? payload.speechEnhancement.passingRealCaptureReplayIds
      : undefined;

    if (!Array.isArray(replayIds) || !replayIds.includes(expectedReplayId)) {
      return `json_speechEnhancement_passingRealCaptureReplayIds_missing(expected=${JSON.stringify(expectedReplayId)},actual=${JSON.stringify(replayIds)})`;
    }
  }

  for (const expectedReplayId of args.expectSpeechEnhancementBlockedReplayIds) {
    const replayIds = payload.speechEnhancement && typeof payload.speechEnhancement === 'object'
      ? payload.speechEnhancement.blockedRealCaptureReplayIds
      : undefined;

    if (!Array.isArray(replayIds) || !replayIds.includes(expectedReplayId)) {
      return `json_speechEnhancement_blockedRealCaptureReplayIds_missing(expected=${JSON.stringify(expectedReplayId)},actual=${JSON.stringify(replayIds)})`;
    }
  }

  const runtimeCheckExpectations = [
    ['command', args.expectPipecatRuntimeCheckCommand],
    ['installCommand', args.expectPipecatRuntimeCheckInstallCommand],
  ];

  for (const [field, expectedValue] of runtimeCheckExpectations) {
    if (expectedValue === undefined) {
      continue;
    }

    const runtimeCheck = payload.pipecatFlow && typeof payload.pipecatFlow === 'object'
      && payload.pipecatFlow.runtimeCheck && typeof payload.pipecatFlow.runtimeCheck === 'object'
      ? payload.pipecatFlow.runtimeCheck
      : undefined;
    const actualValue = runtimeCheck ? runtimeCheck[field] : undefined;

    if (actualValue !== expectedValue) {
      return `json_pipecatFlow_runtimeCheck_${field}_mismatch(expected=${JSON.stringify(expectedValue)},actual=${JSON.stringify(actualValue)})`;
    }
  }

  if (args.expectPipecatRuntimeCheckLiveTelephonyRequired !== undefined) {
    const parsedExpectation = parseBooleanExpectation(
      'pipecat_runtime_check_live_telephony_required',
      args.expectPipecatRuntimeCheckLiveTelephonyRequired,
    );
    if (parsedExpectation.error) {
      return parsedExpectation.error;
    }

    const runtimeCheck = payload.pipecatFlow && typeof payload.pipecatFlow === 'object'
      && payload.pipecatFlow.runtimeCheck && typeof payload.pipecatFlow.runtimeCheck === 'object'
      ? payload.pipecatFlow.runtimeCheck
      : undefined;
    const actualValue = runtimeCheck ? runtimeCheck.liveTelephonyRequired : undefined;

    if (actualValue !== parsedExpectation.expectedValue) {
      return `json_pipecatFlow_runtimeCheck_liveTelephonyRequired_mismatch(expected=${JSON.stringify(parsedExpectation.expectedValue)},actual=${JSON.stringify(actualValue)})`;
    }
  }

  for (const rawExpectation of args.expectLatencyBudgetsMs) {
    const parsedExpectation = parseLatencyBudgetExpectation(rawExpectation);
    if (parsedExpectation.error) {
      return parsedExpectation.error;
    }

    const latencyBudgetsMs = payload.latencyBudgetsMs;
    const actualValue = latencyBudgetsMs && typeof latencyBudgetsMs === 'object'
      ? latencyBudgetsMs[parsedExpectation.name]
      : undefined;

    if (actualValue !== parsedExpectation.expectedValue) {
      return `json_latencyBudgetsMs_${parsedExpectation.name}_mismatch(expected=${JSON.stringify(parsedExpectation.expectedValue)},actual=${JSON.stringify(actualValue)})`;
    }
  }

  for (const rawExpectation of args.expectLatencyBudgetMaxMs) {
    const parsedExpectation = parseLatencyBudgetExpectation(rawExpectation);
    if (parsedExpectation.error) {
      return parsedExpectation.error;
    }

    const latencyBudgetsMs = payload.latencyBudgetsMs;
    const actualValue = latencyBudgetsMs && typeof latencyBudgetsMs === 'object'
      ? latencyBudgetsMs[parsedExpectation.name]
      : undefined;

    if (typeof actualValue !== 'number' || !Number.isFinite(actualValue) || actualValue > parsedExpectation.expectedValue) {
      return `json_latencyBudgetsMs_${parsedExpectation.name}_over_max(expected<=${JSON.stringify(parsedExpectation.expectedValue)},actual=${JSON.stringify(actualValue)})`;
    }
  }

  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { url, timeoutMs, intervalMs } = args;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer.');
  }

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('--interval-ms must be a positive integer.');
  }

  const invalidLatencyBudgetExpectation = validateLatencyBudgetExpectations(args);
  if (invalidLatencyBudgetExpectation) {
    throw new Error(invalidLatencyBudgetExpectation);
  }

  const invalidBooleanExpectation = validateBooleanExpectations(args);
  if (invalidBooleanExpectation) {
    throw new Error(invalidBooleanExpectation);
  }

  const invalidNumberExpectation = validateNumberExpectations(args);
  if (invalidNumberExpectation) {
    throw new Error(invalidNumberExpectation);
  }

  const invalidTimeoutMs = validatePositiveIntegerOption('timeout_ms', timeoutMs);
  if (invalidTimeoutMs) {
    throw new Error(invalidTimeoutMs);
  }

  const invalidIntervalMs = validatePositiveIntegerOption('interval_ms', intervalMs);
  if (invalidIntervalMs) {
    throw new Error(invalidIntervalMs);
  }

  const startedAt = Date.now();
  let attempts = 0;
  let lastFailure = 'probe_not_started';

  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    const remainingMs = timeoutMs - (Date.now() - startedAt);

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.max(1, remainingMs)),
      });
      const failureReason = await getFailureReason(response, args);

      if (!failureReason) {
        console.log(`Health probe succeeded for ${url} after ${attempts} attempt(s) in ${Date.now() - startedAt}ms.`);
        return;
      }

      lastFailure = failureReason;
    } catch (error) {
      const nextFailure = error instanceof Error ? error.message : String(error);

      // Preserve the last explicit health status when the overall probe budget expires
      // during a follow-up request; the timeout is transport noise, not a newer app state.
      if (!isAbortError(error) || lastFailure === 'probe_not_started') {
        lastFailure = nextFailure;
      }
    }

    await sleep(intervalMs);
  }

  console.error(`Timed out waiting for a healthy response from ${url} after ${attempts} attempt(s) in ${Date.now() - startedAt}ms. Last failure: ${lastFailure}.`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
