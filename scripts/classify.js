#!/usr/bin/env node
// Reads Playwright's JSON reporter output and classifies each failure as
// infra | app-bug | test-fix. Schema fields below were confirmed by running
// --reporter=json against a real failure, not inferred (see project notes:
// Playwright's JSON reporter schema is undocumented upstream).
const fs = require('fs');

const INFRA_PATTERNS = [/ECONNREFUSED/i, /net::ERR_/i, /getaddrinfo/i, /timed out waiting for/i /* webServer boot */];

function collectFailures(resultsPath) {
  const report = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  const failures = [];
  for (const suite of report.suites || []) {
    for (const spec of suite.specs || []) {
      if (spec.ok) continue;
      for (const t of spec.tests || []) {
        const last = t.results[t.results.length - 1];
        if (!last || last.status === 'passed') continue;
        const errorContext = (last.attachments || []).find((a) => a.name === 'error-context');
        failures.push({
          file: suite.file,
          title: spec.title,
          status: last.status,
          message: (last.error && last.error.message || '').replace(/\[[0-9;]*m/g, ''),
          errorContextPath: errorContext ? errorContext.path : null,
        });
      }
    }
  }
  return failures;
}

function classify(failure) {
  if (INFRA_PATTERNS.some((re) => re.test(failure.message))) {
    return { class: 'infra', reason: 'Matches a known infra/network failure pattern.' };
  }
  // Anything that timed out waiting on a locator, or a strict-mode violation,
  // is a candidate test-fix (mechanical, Tier 1). Everything else — a real
  // assertion mismatch on a value the app returned — is treated as a
  // possible app bug and must never be auto-healed.
  const looksLikeLocatorIssue = /waiting for|strict mode violation|locator\./i.test(failure.message)
    || failure.status === 'timedOut';
  return looksLikeLocatorIssue
    ? { class: 'test-fix', reason: 'Timed out waiting on a locator — likely a stale selector.' }
    : { class: 'app-bug', reason: 'Failure is an assertion/value mismatch, not a locator timeout — needs human judgment.' };
}

const resultsPath = process.argv[2] || 'results.json';
const failures = collectFailures(resultsPath).map((f) => ({ ...f, ...classify(f) }));
fs.writeFileSync('classification.json', JSON.stringify(failures, null, 2));
console.log(`Classified ${failures.length} failure(s):`);
for (const f of failures) console.log(`  - ${f.title}: ${f.class} (${f.reason})`);

// Exit code communicates the dominant path to the workflow (bash-friendly).
if (failures.some((f) => f.class === 'test-fix')) process.exit(20);
if (failures.some((f) => f.class === 'app-bug')) process.exit(21);
if (failures.length) process.exit(22); // infra only
process.exit(0); // no failures
