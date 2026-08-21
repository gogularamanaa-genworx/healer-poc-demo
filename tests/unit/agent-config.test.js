const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, DEFAULT_CONFIG } = require('../../agent/config.js');

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'healer-config-test-'));
}

test('loadConfig: no .healer.json -> returns defaults untouched', () => {
  const dir = tmpWorkspace();
  assert.deepEqual(loadConfig(dir), DEFAULT_CONFIG);
});

test('loadConfig: overriding one field on one framework leaves the rest at defaults', () => {
  const dir = tmpWorkspace();
  fs.writeFileSync(
    path.join(dir, '.healer.json'),
    JSON.stringify({ frameworks: { pytest: { sourceDir: 'backend/app' } } })
  );
  const config = loadConfig(dir);
  assert.equal(config.frameworks.pytest.sourceDir, 'backend/app');
  // Untouched field on the same framework keeps its default.
  assert.deepEqual(config.frameworks.pytest.test, DEFAULT_CONFIG.frameworks.pytest.test);
  // Untouched framework is unaffected.
  assert.deepEqual(config.frameworks.vitest, DEFAULT_CONFIG.frameworks.vitest);
});

test('loadConfig: a framework absent from the file falls back entirely to its default', () => {
  const dir = tmpWorkspace();
  fs.writeFileSync(path.join(dir, '.healer.json'), JSON.stringify({ frameworks: { vitest: { sourceDir: 'web/src' } } }));
  const config = loadConfig(dir);
  assert.deepEqual(config.frameworks.playwright, DEFAULT_CONFIG.frameworks.playwright);
  assert.deepEqual(config.frameworks.pytest, DEFAULT_CONFIG.frameworks.pytest);
});

test('loadConfig: malformed JSON throws rather than silently falling back', () => {
  const dir = tmpWorkspace();
  fs.writeFileSync(path.join(dir, '.healer.json'), '{ not valid json');
  assert.throws(() => loadConfig(dir), /not valid JSON/);
});

test("loadConfig: this repo's own .healer.json round-trips to exactly the defaults", () => {
  // Guards against the checked-in example drifting from the code defaults it documents.
  const repoRoot = path.join(__dirname, '..', '..');
  assert.deepEqual(loadConfig(repoRoot), DEFAULT_CONFIG);
});

test('loadConfig: sourceDir escaping the workspace via relative traversal throws', () => {
  const dir = tmpWorkspace();
  fs.writeFileSync(path.join(dir, '.healer.json'), JSON.stringify({ frameworks: { pytest: { sourceDir: '../../../etc' } } }));
  assert.throws(() => loadConfig(dir), /resolves outside the workspace/);
});

test('loadConfig: sourceDir as an absolute path outside the workspace throws', () => {
  const dir = tmpWorkspace();
  fs.writeFileSync(path.join(dir, '.healer.json'), JSON.stringify({ frameworks: { vitest: { sourceDir: '/etc' } } }));
  assert.throws(() => loadConfig(dir), /resolves outside the workspace/);
});

test('loadConfig: sourceDir confined to the workspace (including nested) is accepted', () => {
  const dir = tmpWorkspace();
  fs.writeFileSync(path.join(dir, '.healer.json'), JSON.stringify({ frameworks: { pytest: { sourceDir: 'backend/app/src' } } }));
  assert.equal(loadConfig(dir).frameworks.pytest.sourceDir, 'backend/app/src');
});

test('loadConfig: unknown framework name is rejected, not silently executed', () => {
  const dir = tmpWorkspace();
  fs.writeFileSync(path.join(dir, '.healer.json'), JSON.stringify({ frameworks: { jest: { test: ['npx', 'jest'] } } }));
  assert.throws(() => loadConfig(dir), /unknown framework 'jest'/);
});

test('loadConfig: a "__proto__" framework key is rejected', () => {
  const dir = tmpWorkspace();
  fs.writeFileSync(path.join(dir, '.healer.json'), '{"frameworks": {"__proto__": {"test": ["x"]}}}');
  assert.throws(() => loadConfig(dir), /not a permitted framework key/);
});

test('loadConfig: install as a non-array (string) is rejected rather than reaching execFileSync', () => {
  const dir = tmpWorkspace();
  fs.writeFileSync(path.join(dir, '.healer.json'), JSON.stringify({ frameworks: { vitest: { install: 'npm ci' } } }));
  assert.throws(() => loadConfig(dir), /must be an array of non-empty strings/);
});

test('loadConfig: install as an empty array is accepted ("nothing to install")', () => {
  const dir = tmpWorkspace();
  fs.writeFileSync(path.join(dir, '.healer.json'), JSON.stringify({ frameworks: { vitest: { install: [] } } }));
  assert.deepEqual(loadConfig(dir).frameworks.vitest.install, []);
});

test('loadConfig: test as an empty array is rejected (a suite needs a command to run)', () => {
  const dir = tmpWorkspace();
  fs.writeFileSync(path.join(dir, '.healer.json'), JSON.stringify({ frameworks: { playwright: { test: [] } } }));
  assert.throws(() => loadConfig(dir), /must be a non-empty array/);
});
