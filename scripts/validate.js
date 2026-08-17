#!/usr/bin/env node
// Deterministic gate: a candidate patch only becomes proposable if it
// actually compiles, passes, and passes again (flake check). Confidence is
// earned here — never a number the model states.
const fs = require('fs');
const { execSync } = require('child_process');

function sh(cmd) {
  return execSync(cmd, { stdio: 'pipe' }).toString();
}

function main() {
  if (!fs.existsSync('candidate.diff')) {
    console.log('No candidate.diff — nothing to validate.');
    process.exit(1);
  }
  const meta = JSON.parse(fs.readFileSync('meta.json', 'utf8'));
  const signals = { applies: false, runOnePass: false, runTwoPass: false };

  try {
    sh('git apply --check candidate.diff');
    sh('git apply candidate.diff');
    signals.applies = true;
  } catch (e) {
    console.log('Patch does not apply cleanly:', e.message);
    fs.writeFileSync('meta.json', JSON.stringify({ ...meta, confidenceSignals: signals }, null, 2));
    process.exit(1);
  }

  for (const key of ['runOnePass', 'runTwoPass']) {
    try {
      sh('npx playwright test');
      signals[key] = true;
    } catch (e) {
      console.log(`Rerun failed (${key}):`, e.message);
      break;
    }
  }

  meta.confidenceSignals = signals;
  meta.highConfidence = signals.applies && signals.runOnePass && signals.runTwoPass;
  fs.writeFileSync('meta.json', JSON.stringify(meta, null, 2));

  if (!meta.highConfidence) {
    console.log('Patch failed validation — will not be proposed as commit-able.');
    process.exit(1);
  }
  console.log('Patch validated: applies + passes twice (flake check).');
}

main();
