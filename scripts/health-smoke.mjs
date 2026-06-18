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
    expectPipecatScriptCompleted: undefined,
    expectRuntimeSeams: [],
    expectPipecatTools: [],
    expectLatencyBudgetsMs: [],
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
    '--expect-pipecat-script-completed',
    '--expect-runtime-seam',
    '--expect-pipecat-tool',
    '--expect-latency-budget-ms',
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
      args.timeoutMs = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (arg === '--interval-ms' && next) {
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

    if (arg === '--expect-pipecat-script-completed' && next) {
      args.expectPipecatScriptCompleted = next;
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
    args.expectPipecatScriptCompleted,
  ].some((expectedValue) => expectedValue !== undefined)
    || args.expectRuntimeSeams.length > 0
    || args.expectPipecatTools.length > 0
    || args.expectLatencyBudgetsMs.length > 0;
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

function validateLatencyBudgetExpectations(args) {
  for (const rawExpectation of args.expectLatencyBudgetsMs) {
    const parsedExpectation = parseLatencyBudgetExpectation(rawExpectation);
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

  for (const expectedPipecatTool of args.expectPipecatTools) {
    const toolCoverage = payload.pipecatFlow && typeof payload.pipecatFlow === 'object'
      ? payload.pipecatFlow.toolCoverage
      : undefined;

    if (!Array.isArray(toolCoverage) || !toolCoverage.includes(expectedPipecatTool)) {
      return `json_pipecatFlow_toolCoverage_missing(expected=${JSON.stringify(expectedPipecatTool)},actual=${JSON.stringify(toolCoverage)})`;
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
