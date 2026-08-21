const { test } = require('node:test');
const assert = require('node:assert');
const { classify } = require('../../scripts/classify.js');

// The safety invariant: only a stale-reference *signal* makes a failure
// healable. A value mismatch or an unexplained hang must fall through to
// app-bug (human investigates) — never auto-heal.

test('playwright locator timeout (signal in error-context) -> test-fix', () => {
  const f = {
    framework: 'playwright',
    status: 'timedOut',
    message: 'Test timeout of 30000ms exceeded.',
    context: 'Call log:\n  - waiting for getByText(\'Submit\', { exact: true })',
  };
  assert.equal(classify(f).class, 'test-fix');
});

test('playwright bare timeout with NO locator signal -> app-bug (safety)', () => {
  // Regression for the "any timeout is auto-healed" hole: a real app hang
  // times out the same way but carries no waiting-for signal.
  const f = {
    framework: 'playwright',
    status: 'timedOut',
    message: 'Test timeout of 30000ms exceeded.',
    context: null,
  };
  assert.equal(classify(f).class, 'app-bug');
});

test('pytest AttributeError (renamed symbol) -> test-fix', () => {
  const f = { framework: 'pytest', status: 'failed', message: "AttributeError: module 'bff' has no attribute 'fetch_menu'", context: '' };
  assert.equal(classify(f).class, 'test-fix');
});

test('pytest AssertionError (value mismatch) -> app-bug', () => {
  const f = { framework: 'pytest', status: 'failed', message: 'AssertionError: assert 100 == 250', context: 'assert order.total() == 250' };
  assert.equal(classify(f).class, 'app-bug');
});

test('vitest "is not a function" (renamed export) -> test-fix', () => {
  const f = { framework: 'vitest', status: 'failed', message: 'TypeError: bff.fetchMenu is not a function', context: '' };
  assert.equal(classify(f).class, 'test-fix');
});

test('vitest expected/received (value mismatch) -> app-bug', () => {
  const f = { framework: 'vitest', status: 'failed', message: 'AssertionError: expected 100 to be 250', context: '' };
  assert.equal(classify(f).class, 'app-bug');
});

test('infra network failure -> infra (any framework)', () => {
  const f = { framework: 'playwright', status: 'failed', message: 'Error: connect ECONNREFUSED 127.0.0.1:4173', context: null };
  assert.equal(classify(f).class, 'infra');
});
