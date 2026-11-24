---
name: stress-test-plan
description: Stress-test a plan or design through a structured decision-tree interview before any implementation begins; use when the user asks to stress-test, grill, challenge, or sharpen a plan, spec, or architecture.
---

# Stress-test a plan

Surface hidden assumptions, trade-offs, and unmade choices in a plan or design before any code or artifact is written. Produce a settled, mutually confirmed specification—never start implementation during the interview.

## Decision-tree loop

1. **Map the decision tree.** Break the subject into discrete design choices and track which choices depend on others. Root architectural or scope choices sit above downstream details.
2. **Resolve facts yourself.** Whenever a question can be answered from the codebase, docs, logs, or environment, look it up using a sub-agent or terminal commands instead of asking the user. Reserve user questions strictly for decisions, priorities, and constraints that cannot be verified from evidence.
3. **Ask the full frontier.** In each round, ask every unsettled decision whose prerequisites are already resolved—do not ask downstream questions that depend on an unanswered parent choice.
   - Number every question in the round (`1.`, `2.`, ...).
   - Pair each question with a concise recommended answer phrased so the user can accept it by agreeing (for example, "Recommendation: keep X in-process so we avoid a new queue—confirm or specify an alternative").
   - When a structured question tool (such as `AskUserQuestion`) is available, deliver the round through it; otherwise ask directly in chat.
4. **Wait and recompute.** Stop after posing the round and wait for the user's reply. Incorporate their answers, prune branches that no longer apply, verify any newly exposed facts yourself, and compute the next frontier.
5. **Close on a confirmed summary.** When no open decisions or unverified assumptions remain, present a concise summary of the agreed decisions, boundaries, and open non-goals, and ask the user to confirm the shared understanding.

## Boundaries

- **Decisions belong to the user; facts belong to you.** Never invent product, scope, or trade-off decisions on the user's behalf, and never burden the user with factual lookups you can run yourself.
- **No premature execution.** Do not edit project files, run state-changing commands, or begin implementation until the user explicitly confirms the final summary and asks to proceed.
- **Self-contained.** Run the interview directly in this session without delegating to another skill.
