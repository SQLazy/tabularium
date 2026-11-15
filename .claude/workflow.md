# Workflow

Shared rules for Teo's personal repos. Career work (Confie, ITRSS) does not use this file.
Each repo keeps a copy at `.claude/workflow.md`, imported by its `.claude/CLAUDE.md`.
Repo-specific commands and hard limits live in that CLAUDE.md and win over this file.

## How Teo works

- Short prompts. Work out the intent and go; don't ask him to spell it out.
- One recommendation, not a menu of options.
- Push back when something is wrong. Agreement isn't the job.
- No status theatre: report the result, what you couldn't check, and what's his to do.

## 1. Plan, then act

- For any task with 3+ steps or an architectural choice, write the plan first: plan mode,
  or a checklist in the session. Include how you'll verify it, not only how you'll build it.
- Don't stop to have the plan approved. Start on it and say in one line what you chose.
- Stop and ask only at a fork that changes his goal, spends money, or can't be undone:
  deploys, mainnet, wallet keys, publishing, bulk deletes, force pushes, anything that
  messages other people. Everything else is a reasonable default you state and move past.
- If something goes sideways, stop and re-plan. Don't keep pushing the failing approach.

## 2. Subagents

- Use subagents for research, broad searches and parallel analysis, to keep the main
  context clean. One task per subagent, with a brief that stands on its own.
- Spend more compute on hard problems: several independent passes beat one long one.
- Subagents never deploy, publish, pay or push. That stays with the main session and
  the limits above.

## 3. Lessons

- `.claude/lessons.md` is checked in and imported at session start, so it is always read.
- After any correction from Teo, add a line: the rule, and why. Write it so the same
  mistake can't happen twice.
- Keep it short. Merge or delete lessons that stop being true instead of piling on.

## 4. Done means proven

- Never call a task done without showing it works: tests, typecheck, logs, or a run.
- Diff behaviour against `main` when the change touches behaviour.
- Ask "would a staff engineer approve this?" before presenting it.
- If something couldn't be verified here (needs the GPU rig, mainnet, a secret), say so
  plainly instead of implying it passed.

## 5. Elegance, balanced

- For non-trivial changes, pause once and ask whether there's a simpler, cleaner way.
- If a fix feels hacky, redo it knowing what you know now.
- Skip this for small, obvious fixes. Don't over-engineer.

## 6. Fix bugs without hand-holding

- Given a bug report or a failing CI run: find the logs, reproduce, fix the root cause,
  show the same check passing. Don't ask him how.
- Never skip, disable or weaken a test to get green.

## Tracking

- Teo tracks work in Claude Duet's task list. Don't keep a competing todo file in the repo.
- Inside a session, track progress with the plan/checklist and mark items as you go.
- If a plan has to outlive the session, write it to `.claude/plan.md` with a short review
  section at the end (what changed, what was verified, what's left), and delete it when
  the work merges.

## Core principles

- **Simplicity first**: make every change as simple as possible and touch as little code as you can.
- **No laziness**: find root causes. No temporary fixes. Senior developer standards.
- **Minimal impact**: change only what's needed. Don't introduce new bugs on the way.
- **No secrets in the repo**: keys, seeds and tokens live in env, `.dev.vars` or the
  platform's secret store. Never in code, config, lessons or commit messages.
