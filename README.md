# Healer POC Demo

A throwaway sandbox proving the HITL (human-in-the-loop) test-healing design
end to end, live, in a real GitHub repo — across **three frameworks**
(Playwright e2e, pytest, vitest) through one shared pipeline. See
`../Healer_agent.md` in the main project for the full design this demonstrates
a slice of.

## Framework-agnostic by construction

Each runner's raw report is normalized to one **common failure schema** by a
small adapter (`scripts/lib/adapters/{playwright,pytest,vitest}.js`); the rest
of the pipeline — classify → heal → validate → render → apply — only ever sees
that schema. Adding a fourth runner (Jest, Cypress) is one adapter file + one
heal prompt, not a new pipeline. The only per-framework pieces are:

| Piece | Playwright | pytest | vitest |
|---|---|---|---|
| Failure adapter | JSON reporter | pytest-json-report | `--reporter=json` |
| Heal context | `error-context.md` (DOM snapshot) | test src + traceback + app source | test src + error + app source |
| Validate rerun | `npx playwright test` | `pytest` | `npx vitest run` |

Everything else (RBAC, race-check, `/approve` apply, comment audit trail) is
shared and framework-blind — `heal-apply.yml` just applies whatever diff the
proposal carries.

## Two ways to run the same pipeline

The exact same `scripts/` logic (classify → heal → validate → render → apply)
runs in two harnesses:

1. **GitHub Actions** (`.github/workflows/`) — event-triggered, wired per repo.
   This is the zero-infrastructure path.
2. **Docker agent** (`agent/` + `Dockerfile`) — a container you run yourself,
   detached from a repo's CI. This is the step toward an install-once GitHub
   App: the agent clones the PR branch, runs the suites and heals it *itself*,
   and talks to GitHub over REST with a token you pass in. The `test.yml` CI
   gate still runs independently as the normal check.

The agent runs the **image's** copy of `scripts/` against the **cloned**
workspace (image logic is fixed and tamper-proof; only app/test files come from
the PR), so both harnesses are behaviourally identical.

### Running the agent

```bash
docker build -t healer-agent:poc .

# 1. Diagnose + propose fixes for a PR (posts proposal comments)
docker run --rm \
  -e GITHUB_TOKEN=<pat-with-contents+pr-write> \
  -e GEMINI_API_KEY=<key> \
  healer-agent:poc propose --repo <owner/name> --pr <N>

# 2. After a maintainer comments /approve, apply it (RBAC-checked, race-checked)
docker run --rm \
  -e GITHUB_TOKEN=<pat-with-contents+pr-write> \
  healer-agent:poc apply --repo <owner/name> --pr <N>
```

`propose` runs all three suites, and for each failing one classifies →
(if a stale-reference) heals → validates → posts a proposal, or posts a
flag-only comment for app-bugs/infra/failed-validation. `apply` finds the
latest `/approve`, verifies that commenter is a maintainer via the permission
API, checks the branch hasn't moved since the proposal, then commits the fix as
`healer-bot` and posts a resolution comment. `GITHUB_TOKEN` can be the same PAT
value already stored as the `HEALER_PAT` secret.

### Pointing the agent at a different repo

The agent's `--repo`/`--pr` flags already work against any GitHub repo. What's
still specific to *this* repo, by default, is where source lives, what command
runs each suite, and how deps get installed — a real FE/BE repo won't share
this repo's `apps/py` / `apps/js` layout or exact CLI invocations.

A target repo opts into different behavior by committing a `.healer.json` at
its root (see this repo's own, which just documents the defaults):

```json
{
  "frameworks": {
    "pytest": {
      "install": ["pip", "install", "-r", "requirements.txt"],
      "test": ["pytest", "--json-report", "--json-report-file=pytest-results.json"],
      "report": "pytest-results.json",
      "sourceDir": "backend/app"
    }
  }
}
```

Any field left out falls back to the built-in default (`agent/config.js`);
any framework left out of the file falls back entirely. This generalizes the
agent to **any repo using Playwright, pytest, or vitest**, regardless of
folder layout or npm scripts — it does not add support for a different test
runner (Jest, Cypress, JUnit, ...). That needs a new adapter
(`scripts/lib/adapters/<name>.js`) + `TEST_FIX_SIGNALS` entry + heal prompt,
following the same pattern as the three already built.

Install/test commands read from `.healer.json` run with `GITHUB_TOKEN` and
`GEMINI_API_KEY` stripped from their environment (`agent/workspace.js`'s
`sanitizedEnv`) — that file is attacker-influenced content on a fork PR, so
the agent's own secrets must never be reachable from a command it names.

## What this proves

1. A code change breaks a test (a stale locator, or a renamed function/export
   a test still calls) in any of the three frameworks.
2. The healer diagnoses it (real LLM call, Gemini) and **posts a new**
   structured proposal comment — root cause, confidence checklist,
   collapsible diff — instead of silently fixing anything.
3. A maintainer reviews the diff in the PR and comments `/approve`.
4. A second workflow verifies the commenter is actually a maintainer, checks
   the branch hasn't moved since the proposal, applies the patch, and
   commits it to the **same PR branch** as `healer-bot`.
5. CI reruns automatically on that commit and goes green. A separate
   confirmation comment records what happened — the original proposal is
   never edited or deleted, so the full history of every diagnosis and
   every decision stays visible in the PR's comment timeline forever.

Plus two edge cases that prove the safety claims aren't just theoretical:

6. A non-maintainer comments `/approve` → rejected.
7. A new commit lands on the branch while a proposal is pending → the apply
   step detects the mismatch and refuses instead of blind-applying a stale
   patch.

## What this POC simplifies vs. the full design (read before judging scale)

- **State lives in the PR comment, not a workflow artifact.** The diff here
  is one line, so it's base64-encoded directly into a hidden HTML comment
  block in the proposal. At real diff sizes this should move to
  `actions/upload-artifact` + cross-run `download-artifact` — comments have
  a size limit and aren't meant for binary-ish payloads.
- **One repo, three frameworks — but no cross-repo localization.** The three
  runners share one pipeline here, but root-cause localization still assumes
  the failure is in the repo under test; cross-repo diagnosis is a separate,
  larger piece of the full design.
- **One LLM attempt, no bounded retry loop.** Real Tier-2 structural fixes
  need an iteration cap; this POC only demonstrates the Tier-1 one-shot
  path.
- **One target healed per framework per run.** `heal.js` picks the first
  `test-fix` failure for its framework; if a run produces several, the rest
  surface on the next CI run after the first is applied. A production version
  would loop (one proposal each), matching the per-framework matrix pattern.
- **Same-repo-branch trust model.** `heal-propose` runs on `pull_request` (not
  `pull_request_target`) and executes the PR's test suites across three
  runners. Fork PRs get secrets redacted by GitHub, so the LLM call fails
  closed rather than leaking `GEMINI_API_KEY` — but contributor code still runs
  under a `pull-requests: write` token. Point this at a repo taking external
  contributions only after adding an explicit trust gate (e.g. a
  maintainer-label check before the heal step).
- **No recursion guard by actor.** Not needed here because `heal-propose`
  only acts `if: steps.test.outcome == 'failure'` — a successful heal makes
  the rerun pass, so nothing re-fires. Add an explicit
  `github.actor != 'healer-bot'` guard before reusing this against a repo
  where that assumption might not hold.

## Why every comment is new, never edited (history tracking)

Earlier versions of this POC found-and-replaced a single "proposal" comment
in place. That meant every subsequent event — a re-diagnosis, an applied
fix — **overwrote and destroyed** whatever diagnosis was there before, so
there was no way to look back at what the healer actually found or decided.
Now `heal-propose` and `heal-apply` only ever `gh pr comment` (create), never
edit — GitHub's own comment timeline on the PR becomes the permanent audit
trail. To stop a second `/approve` from re-applying an already-resolved
proposal, `heal-apply` searches existing comments for one that already says
`resolves proposal #<id>` before doing anything, rather than relying on the
proposal comment itself having been mutated to signal "done."

## Why you may see "workflows awaiting approval" after `/approve`

`heal-apply` pushes the fix commit, which re-triggers `test` and
`heal-propose` on the PR (as it should — that's how you see it go green).
If that push authenticates as the default `GITHUB_TOKEN`, GitHub attributes
it to the `github-actions[bot]` actor, and — per a GitHub Actions security
change rolled out mid-2026 — bot-triggered PR re-runs on public repos get
gated behind manual "Approve workflows to run," even though a human already
typed `/approve`. This isn't something a workflow setting fixes; it's fixed
by pushing as an actual maintainer account instead of the bot token — see
`HEALER_PAT` below.

## One-time setup

```bash
gh repo create <your-username>/healer-poc-demo --public --source=. --remote=origin
gh secret set GEMINI_API_KEY --repo <your-username>/healer-poc-demo
# A personal access token from a maintainer account (classic PAT, `repo`
# scope, or fine-grained with Contents: write + Pull requests: write on
# this repo) — used only for heal-apply's push, so the resulting re-run is
# attributed to a human, not github-actions[bot]. See note above.
gh secret set HEALER_PAT --repo <your-username>/healer-poc-demo
# ^ paste each secret at the prompt — they never touch git history or chat logs
git push -u origin main
```

Branch protection (recommended, matches the design's safety claim):
Settings → Branches → protect `main` (or whichever branch PRs target) →
enable "Require a pull request before merging" and, if you want to also
exercise the "approvals get reset" property discussed in the main design,
"Dismiss stale pull request approvals when new commits are pushed."

## Demo script

### Scenario 1 — happy path (pick any framework)

`main` is the green baseline (every test matches its app). Each mutation below
renames something the app exposes *on purpose*, leaving one framework's test
stale. Push it, open a PR, and that framework's `heal-propose` matrix job posts
a proposal. Do one, or do all three in a single branch to watch three
independent proposals appear on one PR.

```bash
git checkout -b demo/heal

# Playwright — rename the button the test clicks
sed -i '' 's/>Save changes</>Submit</' apps/web/index.html

# pytest — rename the BFF facade function the test calls
sed -i '' 's/def get_menu/def list_menu/' apps/py/bff.py

# vitest — rename the exported facade function the test calls
sed -i '' 's/export function getMenu/export function listMenu/' apps/js/bff.js

git commit -am "rename facades — leaves tests stale"
git push -u origin demo/heal
gh pr create --fill
```

Watch: `test` workflow fails → each affected `heal-propose` job posts its own
proposal comment (labelled with its framework). Comment `/approve` on a
proposal. Watch `heal-apply` run → new commit appears → `test` reruns → green.
A new "✅ Applied" comment appears below — the original proposal comment stays
exactly as it was, untouched. (`/approve` applies the **latest** proposal; with
several pending, approve after each apply reruns and supersedes the rest.)

### Scenario 2 — RBAC rejection

Using a second GitHub account that is **not** a collaborator on this repo,
comment `/approve` on the same PR (before or after scenario 1 — doesn't
matter, it's a stateless check per comment). Watch the `heal-apply` job fail
at the "Verify commenter is a maintainer" step — no branch is touched.

```bash
gh auth switch --hostname github.com --user <your-second-account>
gh pr comment <PR_NUMBER> --body "/approve"
gh auth switch --hostname github.com --user <your-primary-account>
```

### Scenario 3 — race condition

After the proposal comment appears (scenario 1, before you `/approve`),
push an unrelated second commit to the same branch:

```bash
echo "<!-- demo: unrelated change -->" >> apps/web/index.html
git commit -am "unrelated follow-up change"
git push
```

This re-triggers `heal-propose` (a fresh proposal replaces the old one, new
base SHA). Now comment `/approve` — if you approve the *new* proposal it
just works normally. To specifically exercise the race guard, approve
before the new proposal finishes updating the comment, or manually replay
an old `/approve` — the apply job's SHA comparison will refuse to apply a
patch whose recorded base no longer matches the branch head (unless a
3-way merge still resolves cleanly, in which case it says so explicitly).
