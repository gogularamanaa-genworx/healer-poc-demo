const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizedEnv } = require('../../agent/workspace.js');

const SECRET_ENV_KEYS = ['GITHUB_TOKEN', 'GEMINI_API_KEY'];

test('sanitizedEnv: strips the agent secret env vars', () => {
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

test('sanitizedEnv: leaves other env vars untouched', () => {
  process.env.HEALER_TEST_MARKER = 'still-here';
  try {
    assert.equal(sanitizedEnv().HEALER_TEST_MARKER, 'still-here');
  } finally {
    delete process.env.HEALER_TEST_MARKER;
  }
});
