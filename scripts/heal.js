#!/usr/bin/env node
// Job 2 (heal), one-shot Tier-1 call. Static prompt authored once
// (prompts/heal.md) — only data is bound into it, never generated at
// runtime. One LLM call per failing test, no retry loop, for POC cost
// control.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Flagship-tier per the user's request for "the better model." Confirmed
// mechanics (endpoint shape, ?key= auth, contents/parts request body,
// candidates[0].content.parts[0].text response) against Google's own API
// reference. The exact model ID below is the most current one found there
// at write time — Google's model lineup moves fast, so if this 404s, it
// fails loudly and cleanly (not a silent wrong answer); swap the one
// constant to whatever ai.google.dev/gemini-api/docs/models lists.
const MODEL = 'gemini-3.1-pro-preview';
const PROMPT_TEMPLATE = fs.readFileSync(path.join(__dirname, 'prompts/heal.md'), 'utf8');

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

async function main() {
  const classification = JSON.parse(fs.readFileSync('classification.json', 'utf8'));
  const target = classification.find((f) => f.class === 'test-fix');
  if (!target) {
    console.log('No test-fix class failure found — nothing to heal.');
    process.exit(0);
  }
  if (!target.errorContextPath || !fs.existsSync(target.errorContextPath)) {
    console.log('No error-context.md attachment found — cannot safely diagnose. Skipping.');
    process.exit(1);
  }

  const errorContext = fs.readFileSync(target.errorContextPath, 'utf8');
  const prompt = PROMPT_TEMPLATE.replace('{{ERROR_CONTEXT}}', errorContext);

  const raw = await callGemini(prompt);
  const trimmed = raw.trim();
  fs.writeFileSync('heal-raw-response.txt', trimmed); // always kept for debugging, gitignored

  if (/^NO_SAFE_FIX/m.test(trimmed)) {
    console.log(`Model declined to heal: ${trimmed}`);
    fs.writeFileSync('heal-result.json', JSON.stringify({ healed: false, reason: trimmed }, null, 2));
    process.exit(1);
  }

  // The model only has to reproduce two exact lines, not author valid diff
  // syntax — git generates the actual diff below, so it's guaranteed
  // well-formed. (Earlier version asked the model for a raw unified diff
  // directly; that failed in practice — Gemini's hunk header didn't match
  // its own content and `git apply` rejected it as corrupt. Exact-line
  // replacement has no such failure mode: it either matches or it doesn't.)
  const oldMatch = trimmed.match(/^OLD_LINE:\s*(.*)$/m);
  const newMatch = trimmed.match(/^NEW_LINE:\s*(.*)$/m);
  if (!oldMatch || !newMatch) {
    console.log('Model response had neither NO_SAFE_FIX nor OLD_LINE/NEW_LINE — treating as unsafe.');
    fs.writeFileSync('heal-result.json', JSON.stringify({ healed: false, reason: 'malformed-response', raw: trimmed }, null, 2));
    process.exit(1);
  }
  const oldLine = oldMatch[1];
  const newLine = newMatch[1];

  const targetPath = path.join('tests', target.file);
  const content = fs.readFileSync(targetPath, 'utf8');
  const lines = content.split('\n');
  const matches = lines.filter((l) => l.trim() === oldLine.trim());
  if (matches.length !== 1) {
    console.log(`OLD_LINE matched ${matches.length} time(s) in ${targetPath} — need exactly 1. Refusing to guess.`);
    fs.writeFileSync('heal-result.json', JSON.stringify({ healed: false, reason: 'ambiguous-or-missing-old-line', oldLine }, null, 2));
    process.exit(1);
  }

  const patched = lines.map((l) => (l.trim() === oldLine.trim() ? l.replace(oldLine.trim(), newLine.trim()) : l)).join('\n');
  fs.writeFileSync(targetPath, patched);

  const diff = execSync(`git diff -- ${targetPath}`).toString();
  execSync(`git checkout -- ${targetPath}`); // restore clean tree; validate.js re-applies the diff fresh

  if (!diff.trim()) {
    console.log('NEW_LINE was identical to OLD_LINE — no actual change produced.');
    fs.writeFileSync('heal-result.json', JSON.stringify({ healed: false, reason: 'no-op-replacement' }, null, 2));
    process.exit(1);
  }

  fs.writeFileSync('candidate.diff', diff);
  const baseSha = execSync('git rev-parse HEAD').toString().trim();
  const meta = {
    baseSha,
    tier: 1,
    targetTest: target.title,
    targetFile: target.file,
    model: MODEL,
    confidenceSignals: {}, // filled in by validate.js
  };
  fs.writeFileSync('meta.json', JSON.stringify(meta, null, 2));
  console.log('Candidate patch written to candidate.diff (git-generated, guaranteed valid).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
