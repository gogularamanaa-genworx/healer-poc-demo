# Healer POC Demo

A throwaway sandbox proving the HITL (human-in-the-loop) test-healing design
end to end, live, in a real GitHub repo. See `../Healer_agent.md` in the main
project for the full design this demonstrates a slice of.

## What this proves

1. A code change breaks an e2e test.
2. The healer diagnoses it (real LLM call, Gemini) and posts a
   structured proposal comment — root cause, confidence checklist,
   collapsible diff — instead of silently fixing anything.
3. A maintainer reviews the diff in the PR and comments `/approve`.
4. A second workflow verifies the commenter is actually a maintainer, checks
   the branch hasn't moved since the proposal, applies the patch, and
   commits it to the **same PR branch** as `healer-bot`.
5. CI reruns automatically on that commit and goes green.

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
- **One repo, one framework (Playwright).** No cross-repo root-cause
  localization, no pytest/vitest slice — those are separate, larger pieces
  of the full design.
- **One LLM attempt, no bounded retry loop.** Real Tier-2 structural fixes
  need an iteration cap; this POC only demonstrates the Tier-1 one-shot
  path.
- **No recursion guard by actor.** Not needed here because `heal-propose`
  only acts `if: steps.test.outcome == 'failure'` — a successful heal makes
  the rerun pass, so nothing re-fires. Add an explicit
  `github.actor != 'healer-bot'` guard before reusing this against a repo
  where that assumption might not hold.

## One-time setup

```bash
gh repo create <your-username>/healer-poc-demo --public --source=. --remote=origin
gh secret set GEMINI_API_KEY --repo <your-username>/healer-poc-demo
# ^ paste your key at the prompt — it never touches git history or chat logs
git push -u origin main
```

Branch protection (recommended, matches the design's safety claim):
Settings → Branches → protect `main` (or whichever branch PRs target) →
enable "Require a pull request before merging" and, if you want to also
exercise the "approvals get reset" property discussed in the main design,
"Dismiss stale pull request approvals when new commits are pushed."

## Demo script

### Scenario 1 — happy path

```bash
git checkout -b demo/rename-button
sed -i '' 's/>Submit</>Save changes</' index.html
git commit -am "rename Submit button to Save changes"
git push -u origin demo/rename-button
gh pr create --fill
```

Watch: `test` workflow fails → `heal-propose` posts the proposal comment.
Comment `/approve` on the PR. Watch `heal-apply` run → new commit appears →
`test` reruns → green. Comment updates to "✅ Applied."

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
echo "<!-- demo: unrelated change -->" >> index.html
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
