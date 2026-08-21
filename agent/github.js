// Minimal GitHub REST client (fetch-based, no SDK). Replaces the `gh` CLI and
// the ambient GITHUB_TOKEN the workflows relied on — the agent runs outside
// GitHub Actions, so it talks to the API directly with a token passed in.
const API = 'https://api.github.com';

async function gh(pathname, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'healer-agent',
      'x-github-api-version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`GitHub ${method} ${pathname} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Resolve a PR's head ref + sha (issue_comment/CLI has no PR ref otherwise). */
async function getPull(repo, pr, token) {
  return gh(`/repos/${repo}/pulls/${pr}`, { token });
}

/** All issue comments on a PR, following pagination. */
async function listIssueComments(repo, prNumber, token) {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`, { token });
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

async function postComment(repo, prNumber, bodyText, token) {
  return gh(`/repos/${repo}/issues/${prNumber}/comments`, { method: 'POST', body: { body: bodyText }, token });
}

/** Authoritative permission ('admin'|'write'|'read'|'none') for RBAC. */
async function getPermission(repo, username, token) {
  const r = await gh(`/repos/${repo}/collaborators/${username}/permission`, { token });
  return r.permission;
}

module.exports = { getPull, listIssueComments, postComment, getPermission };
