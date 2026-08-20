// Playwright adapter: --reporter=json output -> common Failure schema.
// Schema fields (suites[].specs[].tests[].results[], error-context attachment)
// were confirmed against a real failing run, not inferred — Playwright's JSON
// reporter shape is undocumented upstream.
const fs = require('fs');
const path = require('path');
const { stripAnsi } = require('../schema');

const TEST_DIR = 'tests/playwright';

// suite.file comes back relative to testDir (e.g. 'click-submit.spec.js').
// Normalize to a repo-relative path the healer can open and patch.
function repoRel(file) {
  if (!file) return file;
  if (path.isAbsolute(file)) return path.relative(process.cwd(), file);
  if (file.startsWith(TEST_DIR)) return file;
  return path.join(TEST_DIR, file);
}

function walk(suite, inheritedFile, out) {
  const file = suite.file || inheritedFile;
  for (const spec of suite.specs || []) {
    if (spec.ok) continue;
    for (const t of spec.tests || []) {
      const last = t.results[t.results.length - 1];
      if (!last || last.status === 'passed') continue;
      const errorContext = (last.attachments || []).find((a) => a.name === 'error-context');
      const contextPath = errorContext ? errorContext.path : null;
      // Playwright's error.message for a locator timeout is only "Test timeout
      // of 30000ms exceeded." — the "waiting for <locator>" signal that proves
      // it's a stale selector (not a real app hang) lives in error-context.md.
      // Surface it in `context` so the classifier can require that signal
      // instead of treating every timeout as healable.
      let context = null;
      if (contextPath && fs.existsSync(contextPath)) {
        context = fs.readFileSync(contextPath, 'utf8');
      }
      out.push({
        framework: 'playwright',
        file: repoRel(file),
        title: spec.title,
        status: last.status,
        message: stripAnsi((last.error && last.error.message) || ''),
        contextPath,
        context,
      });
    }
  }
  for (const child of suite.suites || []) walk(child, file, out);
}

function collect(reportPath) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const out = [];
  for (const suite of report.suites || []) walk(suite, suite.file, out);
  return out;
}

module.exports = { collect };
