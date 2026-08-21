const { test } = require('node:test');
const assert = require('node:assert');
const { parseHealResponse, countLineMatches, buildContext } = require('../../scripts/heal.js');

test('parseHealResponse parses OLD/NEW lines', () => {
  const r = parseHealResponse('OLD_LINE: a.foo()\nNEW_LINE: a.bar()');
  assert.deepEqual(r, { kind: 'ok', oldLine: 'a.foo()', newLine: 'a.bar()' });
});

test('parseHealResponse detects NO_SAFE_FIX', () => {
  assert.equal(parseHealResponse('NO_SAFE_FIX: value changed').kind, 'no_fix');
});

test('parseHealResponse detects malformed', () => {
  assert.equal(parseHealResponse('here is your fix').kind, 'malformed');
});

test('parseHealResponse rejects empty OLD_LINE as malformed', () => {
  // Would otherwise match blank lines and overwrite an unrelated one.
  assert.equal(parseHealResponse('OLD_LINE:   \nNEW_LINE: a.bar()').kind, 'malformed');
});

test('countLineMatches: exactly one', () => {
  assert.equal(countLineMatches('x\n  a.foo()\ny', 'a.foo()'), 1);
});

test('countLineMatches: ambiguous returns 2', () => {
  assert.equal(countLineMatches('a.foo()\na.foo()', 'a.foo()'), 2);
});

test('countLineMatches: no match returns 0', () => {
  assert.equal(countLineMatches('nothing', 'a.foo()'), 0);
});

test('buildContext (pytest) includes test source, error, and renamed app iface', () => {
  const ctx = buildContext({
    framework: 'pytest',
    file: 'tests/pytest/test_bff.py',
    message: 'AttributeError',
    context: 'has no attribute fetch_menu',
  });
  assert.ok(ctx.includes('bff.get_menu()'), 'test source');
  assert.ok(ctx.includes('has no attribute fetch_menu'), 'error');
  assert.ok(ctx.includes('def get_menu'), 'app source shows current interface');
  assert.ok(ctx.includes('DO NOT modify'), 'guardrail present');
});

test('buildContext (vitest) includes renamed app iface', () => {
  const ctx = buildContext({
    framework: 'vitest',
    file: 'tests/vitest/bff.test.js',
    message: 'not a function',
    context: 'fetchMenu is not a function',
  });
  assert.ok(ctx.includes('export function getMenu'), 'app source shows current interface');
});

test('buildContext (playwright) throws when error-context file is missing', () => {
  assert.throws(() => buildContext({ framework: 'playwright', contextPath: 'nope.md' }));
});

test('buildContext (pytest): HEALER_SOURCE_DIR overrides the built-in default', () => {
  const original = process.env.HEALER_SOURCE_DIR;
  // A repo-relative dir that actually exists but is NOT the pytest default
  // (apps/py) — proves the override is honored, not silently ignored.
  process.env.HEALER_SOURCE_DIR = 'apps/js';
  try {
    const ctx = buildContext({
      framework: 'pytest',
      file: 'tests/pytest/test_bff.py',
      message: 'AttributeError',
      context: 'has no attribute fetch_menu',
    });
    assert.ok(ctx.includes('export function getMenu'), 'reads from the overridden dir, not the pytest default');
  } finally {
    if (original === undefined) delete process.env.HEALER_SOURCE_DIR; else process.env.HEALER_SOURCE_DIR = original;
  }
});
