<!--
name: "Data: VCS state changed event schema"
description: "Schema description for the vcs_state_changed system event as a best-effort repository cache-invalidation signal"
ccVersion: "2.1.216"
-->
@internal A harness-observed shell command mutated repository state (git commit/cherry-pick, push, merge, rebase — dry runs excluded). A cache-invalidation signal, deliberately payload-free beyond classification: it says the repo changed, not what it changed to, so consumers re-read state (branch, head, PR status) instead of decoding the event. Derived from the same detection as the tool result's structured gitOperation data, so the two always agree. A compound command can emit more than one kind (a merge and a rebase in one command collapse to the latter); coalesce freely. Best-effort, not exhaustive: only foreground mutations run through the Bash/PowerShell tools are observed — a backgrounded command whose confirming output had not printed at capture time emits nothing.
