#!/usr/bin/env node
// Job 2 (heal), one-shot Tier-1 call. Static prompt authored once
// (prompts/heal.md) — only data is bound into it, never generated at
// runtime. One LLM call per failing test, no retry loop, for POC cost
// control.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MODEL = 'claude-haiku-4-5-20251001';
const PROMPT_TEMPLATE = fs.readFileSync(path.join(__dirname, 'prompts/heal.md'), 'utf8');

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.content.map((b) => b.text || '').join('');
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

  const raw = await callClaude(prompt);
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
