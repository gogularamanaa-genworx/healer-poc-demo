#!/usr/bin/env node
// Builds the single PR comment that IS the durable state for this POC.
// The visible part is for the human; the hidden HTML-comment block at the
// bottom carries the base64 diff + metadata so the apply workflow can
// rehydrate everything from the comment it was triggered by — no external
// artifact lookup needed at this scale. (At real diff sizes this would move
// to a workflow artifact; see README.)
const fs = require('fs');

const meta = JSON.parse(fs.readFileSync('meta.json', 'utf8'));
const diff = fs.readFileSync('candidate.diff', 'utf8');

const signals = meta.confidenceSignals || {};
const checklist = [
  ['applies', 'Patch applies cleanly'],
  ['runOnePass', 'Passes on first rerun'],
  ['runTwoPass', 'Passes on second rerun (flake check)'],
]
  .map(([key, label]) => `- [${signals[key] ? 'x' : ' '}] ${label}`)
  .join('\n');

const statePayload = Buffer.from(
  JSON.stringify({ baseSha: meta.baseSha, targetFile: meta.targetFile, diff }),
).toString('base64');

const body = `<!-- healer-bot:proposal:v1 -->
## 🩹 Test fix proposed — \`${meta.targetTest}\`

**Framework:** ${meta.framework}
**File:** \`${meta.targetFile}\`
**Tier:** ${meta.tier} (mechanical)
**Model:** ${meta.model}

**Confidence signals**
${checklist}

<details>
<summary>Proposed diff</summary>

\`\`\`diff
${diff}
\`\`\`
</details>

**Base commit:** \`${meta.baseSha}\`

---
Comment \`/approve\` to apply and commit this fix to this branch.
Comment \`/reject\` to discard it.

<!-- healer-state
${statePayload}
-->
`;

fs.writeFileSync('proposal.md', body);
console.log('proposal.md written.');
