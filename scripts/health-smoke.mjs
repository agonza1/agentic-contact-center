function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:8026/health',
    timeoutMs: 10000,
    intervalMs: 250,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

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
    }
  }

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFailureReason(response) {
  const contentType = response.headers.get('content-type') || '';

  if (!response.ok) {
    return `http_${response.status}`;
  }

  if (!contentType.toLowerCase().includes('application/json')) {
    return null;
  }

  try {
    const payload = await response.json();

    if (payload && typeof payload === 'object' && 'ok' in payload && payload.ok !== true) {
      return 'json_ok_false';
    }

    return null;
  } catch {
    return 'invalid_json';
  }
}

async function main() {
  const { url, timeoutMs, intervalMs } = parseArgs(process.argv.slice(2));

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer.');
  }

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('--interval-ms must be a positive integer.');
  }

  const startedAt = Date.now();
  let attempts = 0;
  let lastFailure = 'probe_not_started';

  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;

    try {
      const response = await fetch(url);
      const failureReason = await getFailureReason(response);

      if (!failureReason) {
        console.log(`Health probe succeeded for ${url} after ${attempts} attempt(s) in ${Date.now() - startedAt}ms.`);
        return;
      }

      lastFailure = failureReason;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
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
