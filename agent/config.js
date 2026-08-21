// Per-repo config so the same image can diagnose/heal a repo with different
// folder layout, test commands, or install steps than this demo repo. A
// target repo opts in by committing a .healer.json at its root; anything it
// doesn't override falls back to these defaults (which match this repo's own
// layout, so healer-poc-demo needs no .healer.json to keep working).
//
// Config is read from the CLONED PR BRANCH, i.e. it is attacker-influenced
// content on a fork PR. installDeps/runSuite must never hand these commands
// the agent's own secrets (see agent/workspace.js's sanitizedEnv) — only
// which command to run should be configurable, never what it can see.
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  frameworks: {
    playwright: {
      install: ['npm', 'ci', '--ignore-scripts'],
      test: ['npx', 'playwright', 'test'],
      report: 'results.json',
    },
    pytest: {
      // pytest + pytest-json-report are baked into the image (see Dockerfile)
      // so no per-workspace install is needed for this repo's own suite.
      install: [],
      test: ['pytest', '--json-report', '--json-report-file=pytest-results.json'],
      report: 'pytest-results.json',
      sourceDir: 'apps/py',
    },
    vitest: {
      install: ['npm', 'ci', '--ignore-scripts'],
      test: ['npx', 'vitest', 'run', '--reporter=json', '--outputFile=vitest-results.json'],
      report: 'vitest-results.json',
      sourceDir: 'apps/js',
    },
  },
};

// Keys that would let a merge target the object's own prototype via bracket
// assignment (`frameworks[name] = ...`) instead of a data property. JSON.parse
// itself is safe (a literal "__proto__" key becomes an own data property, not
// the setter), but the subsequent bracket assignment below is not — reject
// these outright rather than rely on that being the only place it matters.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// .healer.json is read from the CLONED PR BRANCH — attacker-controlled on a
// fork PR. Only frameworks this pipeline actually has an adapter/prompt for
// may be named; a config-added framework key would otherwise get its
// install/test commands executed by workspace.js before classify.js's own
// allowlist ever gets a chance to reject it.
const KNOWN_FRAMEWORKS = new Set(Object.keys(DEFAULT_CONFIG.frameworks));

// `install: []` is valid (e.g. pytest's default — "nothing to do"); `test: []`
// is not (runSuite needs at least an executable name to run). A
// present-but-wrong-shaped value (wrong type, or any non-string/empty
// element) is rejected either way, before it can reach execFileSync.
function assertPlainStringArray(value, label, { allowEmpty = false } = {}) {
  if (value === undefined) return;
  const shapeOk = Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
  if (!shapeOk || (!allowEmpty && value.length === 0)) {
    throw new Error(`.healer.json: '${label}' must be a${allowEmpty ? 'n' : ' non-empty'} array of non-empty strings.`);
  }
}

function assertString(value, label) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !value) {
    throw new Error(`.healer.json: '${label}' must be a non-empty string.`);
  }
}

// sourceDir is read into readSourceDir() (scripts/heal.js) and its contents
// are sent to the LLM — a value that escapes the workspace (`../../etc`, an
// absolute path) would read and exfiltrate arbitrary container filesystem
// content. Confine it to the workspace root before it's ever trusted.
function assertConfinedToWorkspace(workspaceDir, sourceDir, label) {
  if (sourceDir === undefined) return;
  const root = path.resolve(workspaceDir) + path.sep;
  const resolved = path.resolve(workspaceDir, sourceDir);
  if (!resolved.startsWith(root)) {
    throw new Error(`.healer.json: '${label}' ('${sourceDir}') resolves outside the workspace — refusing.`);
  }
}

/**
 * Load `.healer.json` from a cloned workspace, merged over the defaults on a
 * per-framework, per-field basis. Absent file or absent framework key falls
 * back entirely to the default for that framework. A malformed file, an
 * unknown framework name, a wrong-shaped field, or a sourceDir that escapes
 * the workspace all throw — silently falling back or executing partial
 * garbage would hide a real config typo (or a hostile one) in the target repo.
 */
function loadConfig(dir) {
  const file = path.join(dir, '.healer.json');
  if (!fs.existsSync(file)) return DEFAULT_CONFIG;

  let userConfig;
  try {
    userConfig = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`.healer.json is not valid JSON: ${err.message}`);
  }

  const frameworks = { ...DEFAULT_CONFIG.frameworks };
  for (const [name, override] of Object.entries(userConfig.frameworks || {})) {
    if (UNSAFE_KEYS.has(name)) {
      throw new Error(`.healer.json: '${name}' is not a permitted framework key.`);
    }
    if (!KNOWN_FRAMEWORKS.has(name)) {
      throw new Error(`.healer.json: unknown framework '${name}' — this pipeline only has adapters for: ${[...KNOWN_FRAMEWORKS].join(', ')}.`);
    }
    assertPlainStringArray(override.install, `frameworks.${name}.install`, { allowEmpty: true });
    assertPlainStringArray(override.test, `frameworks.${name}.test`);
    assertString(override.report, `frameworks.${name}.report`);
    assertString(override.sourceDir, `frameworks.${name}.sourceDir`);
    assertConfinedToWorkspace(dir, override.sourceDir, `frameworks.${name}.sourceDir`);

    frameworks[name] = { ...DEFAULT_CONFIG.frameworks[name], ...override };
  }
  return { frameworks };
}

module.exports = { loadConfig, DEFAULT_CONFIG };
