#!/usr/bin/env node
// Healer agent — one-shot CLI. Same classify -> heal -> validate -> propose ->
// apply pipeline as the GitHub Actions workflows, but run as a container the
// user invokes, not as event-triggered CI jobs.
//
//   healer-agent propose --repo <owner/name> --pr <number>
//   healer-agent apply   --repo <owner/name> --pr <number>
//
// Env: GITHUB_TOKEN (contents+PR write), GEMINI_API_KEY (propose only).
//
// The healing logic under scripts/ is the IMAGE's copy, run with cwd set to
// the cloned workspace. So the logic + prompts are fixed and tamper-proof,
// while file IO, git, and test runs operate on the PR's cloned files.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const gh = require('./github');
const ws = require('./workspace');
const { loadConfig } = require('./config');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const MARKER = '<!-- healer-bot:proposal -->';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, '');
    opts[key] = rest[i + 1];
  }
  return { command, opts };
}

/** Run an image script with cwd = workspace. Returns its exit code. */
function runScript(dir, args, extraEnv = {}) {
  try {
    execFileSync('node', [path.join(SCRIPTS, args[0]), ...args.slice(1)], {
      cwd: dir,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
    });
    return 0;
  } catch (e) {
    return typeof e.status === 'number' ? e.status : 1;
  }
}

function flagComment(framework, heading, detail) {
  return `${MARKER}\n## ${heading} (${framework})\n\n${detail}`;
}

// ---- Pure decision logic (exported for unit tests; no IO) -----------------

/** Two-layer RBAC exactly as heal-apply.yml checks it: coarse association +
 * authoritative permission API result. */
function isMaintainer(association, permission) {
  const associationOk = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association);
  const permissionOk = permission === 'admin' || permission === 'write';
  return associationOk && permissionOk;
}

const byCreatedAsc = (a, b) => new Date(a.created_at) - new Date(b.created_at);

/** Latest comment whose body starts with /approve, or undefined. */
function findLatestApprove(comments) {
  return comments.filter((c) => c.body.trim().startsWith('/approve')).sort(byCreatedAsc).pop();
}

/** Latest healer proposal comment, or undefined. */
function findLatestProposal(comments) {
  return comments.filter((c) => c.body.includes('healer-bot:proposal')).sort(byCreatedAsc).pop();
}

/** Has a later comment already recorded resolving this proposal id? */
function alreadyApplied(comments, proposalId) {
  return comments.some((c) => c.body.includes(`resolves proposal #${proposalId}`));
}

/** Parse the base64 healer-state block from a proposal body. Null if absent. */
function extractHealerState(body) {
  const m = body.match(/<!-- healer-state\n([\s\S]*?)\n-->/);
  if (!m) return null;
  return JSON.parse(Buffer.from(m[1].trim(), 'base64').toString('utf8'));
}

// ---- Commands ---------------------------------------------------------------

async function propose({ repo, pr, token, geminiKey }) {
  if (!geminiKey) throw new Error('GEMINI_API_KEY is required for propose.');
  const pull = await gh.getPull(repo, pr, token);
  let dir;
  try {
    dir = ws.cloneWorkspace(repo, pull.head.ref, token);
    // Read from the CLONED PR branch, so a repo can declare its own layout
    // (folder structure, test commands, install steps) via .healer.json at
    // its root; absent that file, this repo's own defaults apply unchanged.
    const config = loadConfig(dir);
    ws.installDeps(dir, config);
    for (const framework of Object.keys(config.frameworks)) {
      console.log(`\n=== ${framework} ===`);
      const report = config.frameworks[framework].report;

      let passed;
      try {
        passed = ws.runSuite(dir, framework, config);
      } catch (err) {
        // Toolchain/environment failure (no report produced) — never treat
        // this as "nothing to heal". Skip this framework, keep going.
        console.error(`${framework}: ${err.message}`);
        await gh.postComment(repo, pr, flagComment(framework, '⚠️ Could not run this suite in the agent',
          `The container failed to execute the ${framework} suite (environment/toolchain issue, not a test failure). No diagnosis was attempted. Details: ${err.message}`), token);
        continue;
      }
      if (passed) {
        console.log(`${framework}: suite passed — nothing to heal.`);
        continue;
      }

      const code = runScript(dir, ['classify.js', framework, report]);
      if (code === 22) {
        await gh.postComment(repo, pr, flagComment(framework, '⚙️ Infra/flake-shaped failure — not sent to the LLM',
          'Matches a known infra pattern (network/boot timeout). Re-run; escalate if it repeats.'), token);
        continue;
      }
      if (code === 21) {
        await gh.postComment(repo, pr, flagComment(framework, '🐛 Could not safely heal this failure',
          'Looks like a real application change (not a stale test). No code was modified — please investigate manually.'), token);
        continue;
      }
      if (code !== 20) {
        console.log(`${framework}: classify exited ${code} (no failures) — skipping.`);
        continue;
      }

      // test-fix: heal -> validate -> render -> post. HEALER_SOURCE_DIR lets
      // this repo's config override heal.js's built-in default; playwright
      // has no sourceDir (its context comes from error-context.md instead).
      // HEALER_TEST_COMMAND carries the resolved rerun command through to
      // validate.js's flake-check gate (via meta.json, written by heal.js) so
      // it reruns the SAME command that produced the failure, not a
      // hardcoded default that may not match this repo's config.
      const extraEnv = {
        GEMINI_API_KEY: geminiKey,
        HEALER_TEST_COMMAND: JSON.stringify(config.frameworks[framework].test),
      };
      if (config.frameworks[framework].sourceDir) {
        extraEnv.HEALER_SOURCE_DIR = config.frameworks[framework].sourceDir;
      }
      const healed = runScript(dir, ['heal.js'], extraEnv) === 0;
      // validate.js strips secrets from ITS OWN rerun subprocess internally
      // (see scripts/validate.js) — runScript here just runs our trusted
      // validate.js process, which needs no extra env of its own.
      const validated = healed && runScript(dir, ['validate.js']) === 0;
      if (!validated) {
        await gh.postComment(repo, pr, flagComment(framework, '🐛 Could not safely heal this failure',
          'A candidate fix failed validation (did not apply, or did not pass on rerun). No code was modified.'), token);
        continue;
      }
      runScript(dir, ['render-proposal.js']);
      const body = fs.readFileSync(path.join(dir, 'proposal.md'), 'utf8');
      await gh.postComment(repo, pr, body, token);
      console.log(`${framework}: proposal posted.`);
    }
  } finally {
    if (dir) ws.cleanup(dir);
  }
}

async function apply({ repo, pr, token }) {
  const comments = await gh.listIssueComments(repo, pr, token);

  // The approving comment drives RBAC — check the REAL approver's permission,
  // exactly as heal-apply.yml checks the comment author.
  const approve = findLatestApprove(comments);
  if (!approve) throw new Error('No /approve comment found on this PR.');
  const approver = approve.user.login;
  const permission = await gh.getPermission(repo, approver, token);
  if (!isMaintainer(approve.author_association, permission)) {
    throw new Error(`@${approver} (association '${approve.author_association}', permission '${permission}') is not a maintainer — refusing.`);
  }

  const proposal = findLatestProposal(comments);
  if (!proposal) {
    await gh.postComment(repo, pr, 'ℹ️ No healer proposal found on this PR to approve.', token);
    return;
  }
  const id = proposal.id;
  if (alreadyApplied(comments, id)) {
    await gh.postComment(repo, pr, `ℹ️ Proposal #${id} was already applied — this \`/approve\` is a no-op.`, token);
    return;
  }

  const state = extractHealerState(proposal.body);
  if (!state) {
    await gh.postComment(repo, pr, `⚠️ Proposal #${id} has no applyable state block (it may be a flag-only comment).`, token);
    return;
  }

  const pull = await gh.getPull(repo, pr, token);
  let dir;
  try {
    dir = ws.cloneWorkspace(repo, pull.head.ref, token);
    fs.writeFileSync(path.join(dir, 'candidate.diff'), state.diff);

    // Race check: unchanged head, or the patch still 3-way applies.
    const clean = pull.head.sha === state.baseSha || ws.patchApplies(dir);
    if (!clean) {
      await gh.postComment(repo, pr,
        `⚠️ This branch changed since proposal #${id} was posted and the patch no longer applies cleanly. A fresh proposal will run on the next push.`, token);
      return;
    }

    let sha;
    try {
      sha = ws.applyCommitPush(dir, pull.head.ref, state.baseSha, token);
    } catch (err) {
      // Most likely a concurrent apply already pushed (non-fast-forward) —
      // there's no per-PR lock in this one-shot CLI (unlike heal-apply.yml's
      // concurrency group), so this is expected under concurrent invocations.
      await gh.postComment(repo, pr,
        `⚠️ Could not push the fix for proposal #${id} — the branch may have just changed (e.g. a concurrent apply). No partial state was left on GitHub. Details: ${err.message}`, token);
      return;
    }
    await gh.postComment(repo, pr,
      `✅ Applied — approved by @${approver}. resolves proposal #${id} → commit \`${sha}\`.`, token);
    console.log(`Applied proposal #${id} as ${sha}.`);
  } finally {
    if (dir) ws.cleanup(dir);
  }
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN env var is required.');
  if (!opts.repo || !opts.pr) throw new Error('Usage: <propose|apply> --repo <owner/name> --pr <number>');
  const ctx = { repo: opts.repo, pr: opts.pr, token, geminiKey: process.env.GEMINI_API_KEY };

  if (command === 'propose') return propose(ctx);
  if (command === 'apply') return apply(ctx);
  throw new Error(`Unknown command '${command}'. Expected 'propose' or 'apply'.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { isMaintainer, findLatestApprove, findLatestProposal, alreadyApplied, extractHealerState };
