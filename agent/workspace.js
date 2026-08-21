// Workspace lifecycle for the agent: clone the PR branch into a throwaway temp
// dir, install its deps, run test suites, and (for apply) commit/push. All git
// state lives in the temp clone — never the user's checkout.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Strip the agent's own secrets from the env handed to install/test
// commands. Those commands run PR-authored code (test files, fixtures,
// package.json scripts even with --ignore-scripts, conftest.py, vitest
// setup files) — none of it needs GITHUB_TOKEN or GEMINI_API_KEY, and since
// config-driven mode lets a target repo's .healer.json choose the command
// itself, that code must never be able to read these out of its own
// environment.
function sanitizedEnv() {
  const { GITHUB_TOKEN, GEMINI_API_KEY, ...rest } = process.env;
  return rest;
}

// GitHub's smart-HTTP auth header. Passed via `-c` on the SPECIFIC git
// invocation that needs it, never embedded in the remote URL — `-c` is a
// one-shot override and is not written to the resulting repo's .git/config,
// so a credential never sits on disk where untrusted PR-authored install
// scripts (npm ci lifecycle hooks) could read it.
function authHeaderArg(token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.extraheader=AUTHORIZATION: basic ${basic}`];
}

function git(dir, args, opts = {}) {
  return execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', ...opts }).toString();
}

// A ref sourced from the GitHub API is attacker-influenced (a PR author names
// their own branch) — reject anything that could be parsed as a git option
// instead of a ref.
function assertSafeRef(ref) {
  if (!ref || ref.startsWith('-')) {
    throw new Error(`Unsafe ref rejected: ${JSON.stringify(ref)}`);
  }
}

/**
 * Clone `repo`@`ref` into a fresh temp dir. Cleans up its own partial state
 * on failure.
 *
 * `git clone -c <key>=<value>` is documented git behaviour that PERSISTS the
 * given config into the new repo's local .git/config (unlike -c on most other
 * subcommands, which is invocation-scoped only) — so the auth header would
 * otherwise sit on disk, base64-decodable, in the exact directory where
 * untrusted PR-authored `npm ci` lifecycle scripts run next. Strip it
 * immediately after clone, before returning control to the caller.
 */
function cloneWorkspace(repo, ref, token) {
  assertSafeRef(ref);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healer-'));
  try {
    execFileSync('git', ['clone', '--no-tags', ...authHeaderArg(token), `https://github.com/${repo}.git`, dir], { stdio: 'inherit' });
    execFileSync('git', ['-C', dir, 'config', '--local', '--unset-all', 'http.extraheader']);
    execFileSync('git', ['-C', dir, 'checkout', ref], { stdio: 'inherit' });
    return dir;
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Run each configured framework's install command once. Commands come from
 * the resolved per-repo config (see agent/config.js) — dedupes identical
 * commands (e.g. playwright and vitest both default to `npm ci`) so it only
 * runs once, and skips frameworks with no install step (e.g. pytest, whose
 * deps are baked into the image). `--ignore-scripts` in the default npm
 * command matters because this runs BEFORE classify.js has looked at
 * anything — the PR is still unvetted, and npm lifecycle scripts are exactly
 * the kind of PR-authored code that must never run with credentials nearby.
 */
function installDeps(dir, config) {
  const seen = new Set();
  for (const fw of Object.values(config.frameworks)) {
    if (!fw.install || fw.install.length === 0) continue;
    const key = JSON.stringify(fw.install);
    if (seen.has(key)) continue;
    seen.add(key);
    execFileSync(fw.install[0], fw.install.slice(1), { cwd: dir, stdio: 'inherit', env: sanitizedEnv() });
  }
}

/**
 * Run one framework's suite using the resolved per-repo config. Returns true
 * if it PASSED, false if it ran and some tests failed. Throws if the suite
 * never produced a report at all (a toolchain/environment failure) — that
 * must never be silently read by the caller as "nothing to heal."
 */
function runSuite(dir, framework, config) {
  const fw = config.frameworks[framework];
  if (!fw) throw new Error(`No config entry for framework '${framework}'.`);
  try {
    execFileSync(fw.test[0], fw.test.slice(1), { cwd: dir, stdio: 'inherit', env: sanitizedEnv() });
    return true;
  } catch (err) {
    if (fs.existsSync(path.join(dir, fw.report))) return false;
    throw new Error(`${framework} suite did not produce a report (toolchain/environment failure, not a test failure): ${err.message}`);
  }
}

/** git apply --3way --check: does the patch still apply to the current tree? */
function patchApplies(dir) {
  try {
    git(dir, ['apply', '--3way', '--check', 'candidate.diff']);
    return true;
  } catch {
    return false;
  }
}

/** Apply candidate.diff, commit as healer-bot, push to `ref`. Returns new sha. */
function applyCommitPush(dir, ref, baseSha, token) {
  assertSafeRef(ref);
  try {
    git(dir, ['apply', '--3way', 'candidate.diff']);
  } catch {
    git(dir, ['apply', 'candidate.diff']);
  }
  git(dir, [
    '-c', 'user.name=healer-bot',
    '-c', 'user.email=healer-bot@users.noreply.github.com',
    'commit', '-am', `fix(test): apply approved heal [auto-healed against ${baseSha}]`,
  ]);
  execFileSync('git', ['-C', dir, ...authHeaderArg(token), 'push', 'origin', `HEAD:${ref}`], { stdio: 'inherit' });
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  cloneWorkspace,
  installDeps,
  runSuite,
  patchApplies,
  applyCommitPush,
  cleanup,
  sanitizedEnv,
};
