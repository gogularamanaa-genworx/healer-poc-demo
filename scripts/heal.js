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

  if (trimmed.startsWith('NO_SAFE_FIX')) {
    console.log(`Model declined to heal: ${trimmed}`);
    fs.writeFileSync('heal-result.json', JSON.stringify({ healed: false, reason: trimmed }, null, 2));
    process.exit(1);
  }

  if (!trimmed.startsWith('--- a/')) {
    console.log('Model response was not a diff — treating as unsafe to apply.');
    fs.writeFileSync('heal-result.json', JSON.stringify({ healed: false, reason: 'malformed-response', raw: trimmed }, null, 2));
    process.exit(1);
  }

  fs.writeFileSync('candidate.diff', trimmed + '\n');
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
  console.log('Candidate patch written to candidate.diff');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
