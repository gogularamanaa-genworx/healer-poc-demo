#!/usr/bin/env node
// Job 2 (heal), one-shot Tier-1 call, framework-agnostic. Static prompts
// authored once (prompts/heal.<framework>.md) — only data is bound into them,
// never generated at runtime. One LLM call per failing test, no retry loop,
// for POC cost control.
//
// The model never authors diff syntax. It returns two exact lines
// (OLD_LINE/NEW_LINE); git generates the actual diff, so it is guaranteed
// well-formed. Exact-line replacement either matches or it doesn't — there is
// no malformed-hunk failure mode.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Flagship-tier per the request for "the better model." If this model id
// 404s, it fails loudly (not a silent wrong answer) — swap the one constant
// to whatever ai.google.dev/gemini-api/docs/models currently lists.
const MODEL = 'gemini-3.1-pro-preview';

// Where each framework's application source lives — included in the heal
// context for pytest/vitest so the model can see the renamed interface. (For
// Playwright the page snapshot in error-context.md already carries that truth.)
// This repo's own layout is the default; the Docker agent overrides it per
// target repo via HEALER_SOURCE_DIR, resolved from that repo's .healer.json
// (see agent/config.js). The GitHub Actions path never sets this env var, so
// it keeps using these defaults unchanged.
const DEFAULT_APP_SOURCE_DIR = { pytest: 'apps/py', vitest: 'apps/js' };

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 2048 },
    }),
  });
  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const candidate = data.candidates && data.candidates[0];
  if (!candidate || !candidate.content) {
    throw new Error(`Gemini returned no usable candidate (finishReason: ${candidate && candidate.finishReason}).`);
  }
  return candidate.content.parts.map((p) => p.text || '').join('');
}

function readSourceDir(dir) {
  if (!fs.existsSync(dir)) return '';
  return fs
    .readdirSync(dir)
    .filter((name) => fs.statSync(path.join(dir, name)).isFile())
    .map((name) => {
      const p = path.join(dir, name);
      return `## ${p}\n\`\`\`\n${fs.readFileSync(p, 'utf8')}\n\`\`\``;
    })
    .join('\n\n');
}

// Playwright's error-context.md already bundles test source + snapshot + error.
// pytest/vitest have no such artifact, so we assemble the equivalent context:
// the failing test source + the error + the current application source (which
// carries the renamed interface the test must be updated to match).
function buildContext(target) {
  if (target.framework === 'playwright') {
    if (!target.contextPath || !fs.existsSync(target.contextPath)) {
      throw new Error('No error-context.md attachment found — cannot safely diagnose.');
    }
    return fs.readFileSync(target.contextPath, 'utf8');
  }
  const testSource = fs.readFileSync(target.file, 'utf8');
  const sourceDir = process.env.HEALER_SOURCE_DIR || DEFAULT_APP_SOURCE_DIR[target.framework];
  const appSource = readSourceDir(sourceDir);
  return [
    `# Failing test file: ${target.file}`,
    '```',
    testSource,
    '```',
    '',
    '# Error',
    target.context || target.message,
    '',
    '# Application source (current, correct interface — DO NOT modify these files)',
    appSource,
  ].join('\n');
}

// Parse the model's constrained response into a decision. Pure — no IO — so it
// is unit-testable without the network.
function parseHealResponse(raw) {
  if (/^NO_SAFE_FIX/m.test(raw)) return { kind: 'no_fix', reason: raw };
  // [ \t]* (not \s*) so an empty "OLD_LINE:" cannot greedily swallow the
  // newline and capture the following NEW_LINE line's content instead.
  const oldMatch = raw.match(/^OLD_LINE:[ \t]*(.*)$/m);
  const newMatch = raw.match(/^NEW_LINE:[ \t]*(.*)$/m);
  if (!oldMatch || !newMatch) return { kind: 'malformed' };
  // An empty OLD_LINE would match blank lines in the target and could overwrite
  // an unrelated line — reject it as malformed rather than guess.
  if (!oldMatch[1].trim()) return { kind: 'malformed' };
  return { kind: 'ok', oldLine: oldMatch[1], newLine: newMatch[1] };
}

// How many lines of `content` equal `oldLine` (trimmed)? The heal only proceeds
// on an exact single match — never guessing which of several to change. Pure.
function countLineMatches(content, oldLine) {
  return content.split('\n').filter((l) => l.trim() === oldLine.trim()).length;
}

async function main() {
  const classification = JSON.parse(fs.readFileSync('classification.json', 'utf8'));
  const target = classification.find((f) => f.class === 'test-fix');
  if (!target) {
    console.log('No test-fix class failure found — nothing to heal.');
    process.exit(0);
  }

  const promptPath = path.join(__dirname, 'prompts', `heal.${target.framework}.md`);
  if (!fs.existsSync(promptPath)) {
    console.log(`No prompt for framework '${target.framework}' — cannot heal.`);
    process.exit(1);
  }

  let context;
  try {
    context = buildContext(target);
  } catch (err) {
    console.log(err.message, 'Skipping.');
    fs.writeFileSync('heal-result.json', JSON.stringify({ healed: false, reason: 'no-context', detail: err.message }, null, 2));
    process.exit(1);
  }
  const prompt = fs.readFileSync(promptPath, 'utf8').replace('{{CONTEXT}}', context);

  const raw = (await callGemini(prompt)).trim();
  fs.writeFileSync('heal-raw-response.txt', raw); // kept for debugging, gitignored

  const parsed = parseHealResponse(raw);
  if (parsed.kind === 'no_fix') {
    console.log(`Model declined to heal: ${raw}`);
    fs.writeFileSync('heal-result.json', JSON.stringify({ healed: false, reason: raw }, null, 2));
    process.exit(1);
  }
  if (parsed.kind === 'malformed') {
    console.log('Model response had neither NO_SAFE_FIX nor OLD_LINE/NEW_LINE — treating as unsafe.');
    fs.writeFileSync('heal-result.json', JSON.stringify({ healed: false, reason: 'malformed-response', raw }, null, 2));
    process.exit(1);
  }
  const { oldLine, newLine } = parsed;

  // target.file is already repo-relative (the adapter normalized it).
  const targetPath = target.file;
  const content = fs.readFileSync(targetPath, 'utf8');
  const lines = content.split('\n');
  const matchCount = countLineMatches(content, oldLine);
  if (matchCount !== 1) {
    console.log(`OLD_LINE matched ${matchCount} time(s) in ${targetPath} — need exactly 1. Refusing to guess.`);
    fs.writeFileSync('heal-result.json', JSON.stringify({ healed: false, reason: 'ambiguous-or-missing-old-line', oldLine }, null, 2));
    process.exit(1);
  }

  const patched = lines
    .map((l) => (l.trim() === oldLine.trim() ? l.replace(oldLine.trim(), newLine.trim()) : l))
    .join('\n');
  fs.writeFileSync(targetPath, patched);

  // execFileSync (array args, no shell) so a test file path containing spaces
  // or shell metacharacters can never be interpreted as a command.
  const diff = execFileSync('git', ['diff', '--', targetPath]).toString();
  execFileSync('git', ['checkout', '--', targetPath]); // restore clean tree; validate.js re-applies the diff fresh

  if (!diff.trim()) {
    console.log('NEW_LINE was identical to OLD_LINE — no actual change produced.');
    fs.writeFileSync('heal-result.json', JSON.stringify({ healed: false, reason: 'no-op-replacement' }, null, 2));
    process.exit(1);
  }

  fs.writeFileSync('candidate.diff', diff);
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
  // Carries the resolved rerun command (from this repo's .healer.json, via
  // the Docker agent's HEALER_TEST_COMMAND env var) through to validate.js's
  // flake-check gate, so it reruns the SAME command that produced this
  // failure. Absent on the GitHub Actions path, where validate.js falls back
  // to its own per-framework defaults unchanged.
  const testCommand = process.env.HEALER_TEST_COMMAND ? JSON.parse(process.env.HEALER_TEST_COMMAND) : null;
  const meta = {
    baseSha,
    tier: 1,
    framework: target.framework,
    targetTest: target.title,
    targetFile: target.file,
    model: MODEL,
    testCommand,
    confidenceSignals: {}, // filled in by validate.js
  };
  fs.writeFileSync('meta.json', JSON.stringify(meta, null, 2));
  console.log(`Candidate patch written to candidate.diff (git-generated, guaranteed valid) for ${target.framework}.`);
}

// Only run the pipeline when invoked as a script; exporting the pure helpers
// keeps them unit-testable without the network or a git tree.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { parseHealResponse, countLineMatches, buildContext };
