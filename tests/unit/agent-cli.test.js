const { test } = require('node:test');
const assert = require('node:assert');
const { isMaintainer, findLatestApprove, findLatestProposal, alreadyApplied, extractHealerState } = require('../../agent/cli.js');

// RBAC — two layers, both required, exactly as heal-apply.yml checks them.
test('isMaintainer: owner + write -> true', () => {
  assert.equal(isMaintainer('OWNER', 'write'), true);
});
test('isMaintainer: collaborator + admin -> true', () => {
  assert.equal(isMaintainer('COLLABORATOR', 'admin'), true);
});
test('isMaintainer: none association -> false even with write permission', () => {
  // author_association is the cheap first filter; a spoofed/unexpected value must not bypass it.
  assert.equal(isMaintainer('NONE', 'write'), false);
});
test('isMaintainer: member association but read-only permission -> false', () => {
  // Confirms the permission API is authoritative, not the coarse association alone.
  assert.equal(isMaintainer('MEMBER', 'read'), false);
});
test('isMaintainer: contributor association -> false', () => {
  assert.equal(isMaintainer('CONTRIBUTOR', 'write'), false);
});

// Latest-comment pickers — order matters (a later /approve or proposal wins).
test('findLatestApprove: picks the most recent /approve, ignores non-approve comments', () => {
  const comments = [
    { body: 'looks good', created_at: '2026-01-01T00:00:00Z' },
    { body: '/approve', created_at: '2026-01-01T00:01:00Z', user: { login: 'a' } },
    { body: 'unrelated', created_at: '2026-01-01T00:02:00Z' },
    { body: '/approve', created_at: '2026-01-01T00:03:00Z', user: { login: 'b' } },
  ];
  assert.equal(findLatestApprove(comments).user.login, 'b');
});
test('findLatestApprove: undefined when no /approve present', () => {
  assert.equal(findLatestApprove([{ body: 'hi', created_at: '2026-01-01T00:00:00Z' }]), undefined);
});
test('findLatestProposal: picks the most recent healer-bot:proposal comment', () => {
  const comments = [
    { id: 1, body: '<!-- healer-bot:proposal --> first', created_at: '2026-01-01T00:00:00Z' },
    { id: 2, body: '<!-- healer-bot:proposal --> second', created_at: '2026-01-01T00:05:00Z' },
  ];
  assert.equal(findLatestProposal(comments).id, 2);
});

// Idempotency — a resolution comment referencing THIS id blocks a re-apply.
test('alreadyApplied: true when a matching resolution comment exists', () => {
  const comments = [{ body: 'resolves proposal #42 -> commit abc' }];
  assert.equal(alreadyApplied(comments, 42), true);
});
test('alreadyApplied: false for a different proposal id (no false positive)', () => {
  const comments = [{ body: 'resolves proposal #43 -> commit abc' }];
  assert.equal(alreadyApplied(comments, 42), false);
});
test('alreadyApplied: false when no resolution comment exists', () => {
  assert.equal(alreadyApplied([{ body: 'unrelated' }], 42), false);
});

// healer-state extraction — the base64 block apply() rehydrates from.
test('extractHealerState: parses a valid state block', () => {
  const state = { baseSha: 'abc123', targetFile: 'tests/x.py', diff: '--- a\n+++ b\n' };
  const encoded = Buffer.from(JSON.stringify(state)).toString('base64');
  const body = `proposal text\n<!-- healer-state\n${encoded}\n-->\n`;
  assert.deepEqual(extractHealerState(body), state);
});
test('extractHealerState: null when no state block is present (flag-only comment)', () => {
  assert.equal(extractHealerState('just a flag comment, no state block'), null);
});
