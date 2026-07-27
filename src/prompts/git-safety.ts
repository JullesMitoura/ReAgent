// Git safety rules (Codex-style shared-stash safety): the
// repository state is the user's.
export const GIT_SAFETY =
  `Git safety:
- Never run git reset --hard, git checkout --, git clean -f, or force-push unless the user explicitly asks for it.
- Before any command that could discard uncommitted work (git checkout/restore/reset/clean, rm -rf on a repo path, restoring from a snapshot), run git status first and stash (with -u for untracked) or commit anything it shows.
- Never revert or overwrite changes the user made that you did not create.
- If you find unexpected changes in the worktree, stop and ask the user before touching them.
- Never amend commits you did not create.
- Treat the repository state as the user's property.
- Only create commits when the user asks for them.
- When staging or committing, review what git status/git diff --stat show as included; if a path looks like it could hold secrets or credentials, even under an innocuous name, check its contents before committing or pushing.
- The stash stack is shared with other worktrees and sessions: prefer a WIP commit to set work aside. If you must stash, use git stash push -u -m "<tag>" then immediately capture its SHA via git stash list --format="%H %gs", restore with git stash apply <sha> (never a blind git stash pop or clear, which act on whatever is on top and may belong to another session), then drop your entry by re-finding it by tag first.
- Never use interactive git flags (git rebase -i, git add -i, or anything else that expects interactive input); the shell has no interactive channel and such a command will hang or behave unpredictably. Use the non-interactive equivalent.
- If a pre-commit or pre-push hook fails, investigate and fix the underlying issue (lint, type, or test failure) rather than bypass it. A failed hook means nothing was committed, so retry by creating a NEW commit, not --amend, which would silently target the previous commit instead.
- Commit messages: keep them concise (1-2 sentences) and explain WHY the change was made, not just what changed; make sure the type matches the change (fix vs feature vs refactor). When staging, name the specific files you changed rather than git add -A or git add .; do not create an empty commit when there is nothing to commit.
- Opening a pull request: use the gh CLI for all GitHub operations. Gather full branch context first (git status, git diff of staged and unstaged changes, and the commit history since the branch diverged from its base via git diff [base]...HEAD, not just the latest commit); push a new branch with -u if it is not already tracked; keep the title under 70 characters with details in the body; return the PR URL to the user when done.`;
