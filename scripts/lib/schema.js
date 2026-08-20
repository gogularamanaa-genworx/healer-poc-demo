// The common failure schema every framework adapter normalizes to. The rest
// of the pipeline (classify -> heal -> validate -> render) only ever sees this
// shape, never a runner's raw report — that is what keeps the pipeline
// framework-agnostic and lets a new runner be added as one adapter file.
//
// @typedef {Object} Failure
// @property {'playwright'|'pytest'|'vitest'} framework
// @property {string}      file         Repo-relative path to the FAILING TEST file.
// @property {string}      title        Human-readable test name.
// @property {string}      status       Runner status (failed | timedOut | error).
// @property {string}      message      First/most relevant error line(s), ANSI-stripped.
// @property {string|null} contextPath  Path to a rich context file (Playwright's
//                                      error-context.md); null when context is inline.
// @property {string|null} context      Inline context (pytest traceback / vitest
//                                      failure messages); null when it's a file.
// @property {string}     [class]       Added by classify: 'test-fix'|'app-bug'|'infra'.
// @property {string}     [reason]      Added by classify.

// Infra/network patterns are framework-independent — a DNS or connection
// failure looks the same whichever runner surfaced it. Matched before any
// test-fix heuristic so a boot failure is never mistaken for a stale test.
const INFRA_PATTERNS = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /net::ERR_/i,
  /getaddrinfo/i,
  /config\.webServer/i, // Playwright web server never came up
];

function stripAnsi(s) {
  return (s || '').replace(/\[[0-9;]*m/g, '');
}

module.exports = { INFRA_PATTERNS, stripAnsi };
