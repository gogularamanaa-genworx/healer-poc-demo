#!/usr/bin/env node
// Framework-agnostic classifier. Usage:
//   node scripts/classify.js <framework> <reportPath>
// Delegates report parsing to the per-framework adapter, then applies one
// shared triage: infra -> app-bug -> test-fix. Only 'test-fix' is ever sent to
// the LLM; 'app-bug' (a real value/behaviour change) is flagged, never healed.
const fs = require('fs');
const { INFRA_PATTERNS } = require('./lib/schema');

const adapters = {
  playwright: require('./lib/adapters/playwright'),
  pytest: require('./lib/adapters/pytest'),
  vitest: require('./lib/adapters/vitest'),
};

// A stale *test* reference (renamed selector / symbol / export) is mechanical
// and healable. A value/assertion mismatch is a suspected app change and must
// never be auto-healed — it falls through to 'app-bug'.
const TEST_FIX_SIGNALS = {
  playwright: /waiting for|strict mode violation|locator\./i,
  pytest: /AttributeError|ImportError|ModuleNotFoundError|NameError|has no attribute/i,
  vitest: /is not a function|does not provide an export named|Cannot find module|is not defined/i,
};

function classify(failure) {
  const text = `${failure.message}\n${failure.context || ''}`;
  if (INFRA_PATTERNS.some((re) => re.test(text))) {
    return { class: 'infra', reason: 'Matches a known infra/network failure pattern.' };
  }
  const signal = TEST_FIX_SIGNALS[failure.framework];
  // A stale-reference signal in the text is what makes a failure healable. A
  // bare timeout with NO such signal is treated as a suspected app hang
  // (app-bug, the safe default) — never auto-healed. `timedOut` only counts as
  // mechanical as a tiebreaker when there is no diagnostic text at all.
  const hasSignal = signal ? signal.test(text) : false;
  const looksMechanical =
    hasSignal || (failure.status === 'timedOut' && !text.trim());
  return looksMechanical
    ? { class: 'test-fix', reason: 'Stale test reference (renamed selector/symbol/export) — mechanically healable.' }
    : { class: 'app-bug', reason: 'No stale-reference signal — suspected real app change; needs human judgment.' };
}

function main() {
  const framework = process.argv[2];
  const reportPath = process.argv[3];

  if (!adapters[framework]) {
    console.error(`Unknown framework '${framework}'. Expected one of: ${Object.keys(adapters).join(', ')}`);
    process.exit(2);
  }
  if (!reportPath || !fs.existsSync(reportPath)) {
    console.log(`No report at '${reportPath}' — treating as no failures.`);
    process.exit(0);
  }

  const failures = adapters[framework].collect(reportPath).map((f) => ({ ...f, ...classify(f) }));
  fs.writeFileSync('classification.json', JSON.stringify(failures, null, 2));
  console.log(`[${framework}] Classified ${failures.length} failure(s):`);
  for (const f of failures) console.log(`  - ${f.title}: ${f.class} (${f.reason})`);

  // Exit code communicates the dominant path to the workflow (bash-friendly):
  // 20=test-fix 21=app-bug 22=infra-only 0=no failures.
  if (failures.some((f) => f.class === 'test-fix')) process.exit(20);
  if (failures.some((f) => f.class === 'app-bug')) process.exit(21);
  if (failures.length) process.exit(22);
  process.exit(0);
}

// Run as CLI; export classify so its safety-critical routing is unit-testable.
if (require.main === module) main();

module.exports = { classify };
