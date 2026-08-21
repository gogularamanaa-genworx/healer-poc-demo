const { test } = require('node:test');
const assert = require('node:assert');
const { resolveCommand, sanitizedEnv } = require('../../scripts/validate.js');

test('resolveCommand: uses meta.testCommand when present (Docker agent, config-driven)', () => {
  const cmd = resolveCommand({ framework: 'pytest', testCommand: ['pytest', '-x'] });
  assert.deepEqual(cmd, ['pytest', '-x']);
});

test('resolveCommand: falls back to the per-framework default when testCommand is absent (GitHub Actions path)', () => {
  const cmd = resolveCommand({ framework: 'vitest' });
  assert.deepEqual(cmd, ['npx', 'vitest', 'run']);
});

test('resolveCommand: falls back to default when testCommand is explicitly null', () => {
  const cmd = resolveCommand({ framework: 'playwright', testCommand: null });
  assert.deepEqual(cmd, ['npx', 'playwright', 'test']);
});

test('resolveCommand: rejects a malformed (non-array) testCommand rather than passing it to execFileSync', () => {
  assert.throws(() => resolveCommand({ framework: 'pytest', testCommand: 'pytest -x' }), /not a non-empty string array/);
});

test('resolveCommand: rejects a testCommand containing a non-string element', () => {
  assert.throws(() => resolveCommand({ framework: 'pytest', testCommand: ['pytest', 42] }), /not a non-empty string array/);
});

const SECRET_ENV_KEYS = ['GITHUB_TOKEN', 'GEMINI_API_KEY'];

test('sanitizedEnv: strips the agent secret env vars from the rerun subprocess env', () => {
  const saved = {};
  for (const key of SECRET_ENV_KEYS) {
    saved[key] = process.env[key];
    process.env[key] = ['placeholder', 'value', key].join('-');
  }
  try {
    const env = sanitizedEnv();
    for (const key of SECRET_ENV_KEYS) {
      assert.equal(key in env, false, `${key} should be stripped`);
    }
  } finally {
    for (const key of SECRET_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
