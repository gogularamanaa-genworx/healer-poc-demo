// vitest adapter: `vitest run --reporter=json` output -> common Failure schema.
// Confirmed shape: report.testResults[] (per file) with { name (absolute path),
// assertionResults[] { fullName, title, status, failureMessages[] } }.
const fs = require('fs');
const path = require('path');
const { stripAnsi } = require('../schema');

function collect(reportPath) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const out = [];
  for (const file of report.testResults || []) {
    const rel = path.isAbsolute(file.name) ? path.relative(process.cwd(), file.name) : file.name;
    for (const a of file.assertionResults || []) {
      if (a.status !== 'failed') continue;
      const messages = (a.failureMessages || []).map(stripAnsi);
      out.push({
        framework: 'vitest',
        file: rel,
        title: a.fullName || a.title,
        status: a.status,
        message: (messages[0] || '').split('\n')[0],
        contextPath: null,
        context: messages.join('\n\n'),
      });
    }
  }
  return out;
}

module.exports = { collect };
