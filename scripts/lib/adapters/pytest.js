// pytest adapter: pytest-json-report output -> common Failure schema.
// Confirmed shape: report.tests[] with { nodeid, outcome, <phase>.crash.message,
// <phase>.longrepr } where <phase> is setup|call|teardown. nodeid is
// 'path/to/test.py::test_name' (file before '::'). Collection-time failures
// (e.g. an ImportError before any test runs) are NOT in report.tests — they
// live in report.collectors — so both are walked.
const fs = require('fs');
const { stripAnsi } = require('../schema');

// Pull crash/longrepr from whichever phase actually failed. An assertion fails
// in 'call'; a fixture error fails in 'setup'. Reading only 'call' would emit
// an empty message for setup/teardown failures.
function phaseDetail(t) {
  for (const phase of ['call', 'setup', 'teardown']) {
    const p = t[phase];
    if (p && (p.crash || p.longrepr)) {
      const crash = p.crash || {};
      return {
        message: crash.message || '',
        longrepr: (typeof p.longrepr === 'string' ? p.longrepr : JSON.stringify(p.longrepr)) || crash.message || '',
      };
    }
  }
  return { message: '', longrepr: '' };
}

function collect(reportPath) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const out = [];

  for (const t of report.tests || []) {
    if (t.outcome === 'passed' || t.outcome === 'skipped') continue;
    const nodeid = String(t.nodeid || '');
    const { message, longrepr } = phaseDetail(t);
    out.push({
      framework: 'pytest',
      file: nodeid.split('::')[0],
      title: nodeid.split('::').slice(1).join('::') || nodeid,
      status: t.outcome,
      message: stripAnsi(message),
      contextPath: null,
      context: stripAnsi(longrepr),
    });
  }

  // Collection errors (import failures, syntax errors in a test module) never
  // reach report.tests — surface them so a red CI check is never met with
  // silence from the healer.
  for (const c of report.collectors || []) {
    if (c.outcome !== 'failed') continue;
    const longrepr = typeof c.longrepr === 'string' ? c.longrepr : JSON.stringify(c.longrepr || '');
    out.push({
      framework: 'pytest',
      file: String(c.nodeid || '').split('::')[0],
      title: `collection error: ${c.nodeid}`,
      status: 'error',
      message: stripAnsi((longrepr || '').split('\n').pop() || longrepr),
      contextPath: null,
      context: stripAnsi(longrepr),
    });
  }

  return out;
}

module.exports = { collect };
