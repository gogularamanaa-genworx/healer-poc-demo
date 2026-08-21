const { test } = require('node:test');
const assert = require('node:assert');
const { listIssueComments } = require('../../agent/github.js');

function stubFetch(pages) {
  let call = 0;
  return async () => {
    const body = pages[call++] || [];
    return { ok: true, status: 200, json: async () => body };
  };
}

test('listIssueComments: stops paginating once a page is short of 100', async (t) => {
  const originalFetch = global.fetch;
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  const page2 = [{ id: 100 }, { id: 101 }];
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    const body = url.includes('page=2') ? page2 : page1;
    return { ok: true, status: 200, json: async () => body };
  };
  t.after(() => { global.fetch = originalFetch; });

  const comments = await listIssueComments('o/r', 1, 'tok');
  assert.equal(comments.length, 102);
  assert.equal(calls, 2, 'must stop after the short page, not request a third');
});

test('listIssueComments: a single short page makes exactly one request', async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = stubFetch.call(null, [[{ id: 1 }]]);
  const wrapped = global.fetch;
  global.fetch = async (...args) => { calls++; return wrapped(...args); };
  t.after(() => { global.fetch = originalFetch; });

  const comments = await listIssueComments('o/r', 1, 'tok');
  assert.equal(comments.length, 1);
  assert.equal(calls, 1);
});
