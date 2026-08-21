#!/usr/bin/env node
// Deterministic gate: a candidate patch only becomes proposable if it actually
// applies, passes, and passes again (flake check) against the SAME framework
// that produced the failure. Confidence is earned here — never a number the
// model states.
const fs = require('fs');
const { execSync, execFileSync } = require('child_process');

// The rerun command per framework, used when meta.testCommand (set by
// heal.js from the Docker agent's resolved .healer.json config) isn't
// present — i.e. on the GitHub Actions path, or against this repo's own
// default layout. PYTEST is overridable so a local venv
// (./.venv/bin/pytest) can be used; CI leaves it on PATH.
const RERUN_COMMAND = {
  playwright: ['npx', 'playwright', 'test'],
  pytest: [process.env.PYTEST || 'pytest'],
  vitest: ['npx', 'vitest', 'run'],
};

function sh(cmd) {
  return execSync(cmd, { stdio: 'pipe' }).toString();
}

// The rerun re-executes PR-authored test code (possibly via a command a
// target repo's .healer.json named itself) — strip the agent's own secrets
// so that code can never read them out of its environment. Duplicated from
// agent/workspace.js's sanitizedEnv rather than imported: scripts/ is the
// image's fixed, tamper-proof logic and must stay independent of agent/ so
// it also runs standalone under GitHub Actions.
function sanitizedEnv() {
  const { GITHUB_TOKEN, GEMINI_API_KEY, ...rest } = process.env;
  return rest;
}

// meta.testCommand is attacker-influenced (originates in a target repo's
// .healer.json) by the time it reaches here — validated at load time in
// agent/config.js, but re-checked defensively since this file also runs
// under GitHub Actions without that validation ever having run.
function resolveCommand(meta) {
  if (meta.testCommand !== undefined && meta.testCommand !== null) {
    if (!Array.isArray(meta.testCommand) || !meta.testCommand.every((v) => typeof v === 'string' && v)) {
      throw new Error('meta.testCommand is present but not a non-empty string array — refusing to run it.');
    }
    return meta.testCommand;
  }
  return RERUN_COMMAND[meta.framework];
}

function runCommand(cmd) {
  return execFileSync(cmd[0], cmd.slice(1), { stdio: 'pipe', env: sanitizedEnv() }).toString();
}

function main() {
  if (!fs.existsSync('candidate.diff')) {
    console.log('No candidate.diff — nothing to validate.');
    process.exit(1);
  }
  const meta = JSON.parse(fs.readFileSync('meta.json', 'utf8'));
  const command = resolveCommand(meta);
  if (!command) {
    console.log(`No rerun command for framework '${meta.framework}'.`);
    process.exit(1);
  }
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
      runCommand(command);
      signals[key] = true;
    } catch (e) {
      console.log(`Rerun failed (${key}) via '${command.join(' ')}':`, e.message);
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
  console.log(`Patch validated for ${meta.framework}: applies + passes twice (flake check).`);
}

if (require.main === module) {
  main();
}

module.exports = { resolveCommand, sanitizedEnv };
