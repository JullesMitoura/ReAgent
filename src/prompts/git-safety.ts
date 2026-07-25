// Git safety rules (Codex style + Claude Code shared-stash safety): the
// repository state is the user's.
export const GIT_SAFETY =
  `Git safety:
- Never run git reset --hard, git checkout --, git clean -f, or force-push unless the user explicitly asks for it.
- Never revert or overwrite changes the user made that you did not create.
- If you find unexpected changes in the worktree, stop and ask the user before touching them.
- Never amend commits you did not create.
- Treat the repository state as the user's property.
- Only create commits when the user asks for them.
- The stash stack is shared with other worktrees and sessions: prefer a WIP commit to set work aside. If you must stash, use git stash push -u -m "<tag>" then immediately capture its SHA via git stash list --format="%H %gs", restore with git stash apply <sha> (never a blind git stash pop or clear, which act on whatever is on top and may belong to another session), then drop your entry by re-finding it by tag first.`;
