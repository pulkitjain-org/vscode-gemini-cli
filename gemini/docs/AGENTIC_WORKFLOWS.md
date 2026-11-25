# Agentic development workflows: proposal

Status: phase 1 (Verify) is built, in 1.9; phases 2 to 6 are a proposal and wait until Verify has been used. GeminiCode has been in a feature freeze since 31 October 2026, lifted on 25 November 2026 for Verify and the model-results work alone.

How phase 1 was built differs from its section below in four places. The guide ([Verify an agent's work](guide/agents.md#verify-an-agents-work)) and [ARCHITECTURE.md](ARCHITECTURE.md#verify) describe what shipped:

- The second run uses a clone of the agent's whole folder, ignored files included, since checks need what git does not carry (`node_modules`, a build folder).
- A result is kept for the window, not across a restart, and "changed since" follows the agent's edits; Try, Merge Back and Open Merge Request show it through the card above them.
- `ask` means the card offers **Run Checks**; nothing asks after each turn.
- **Keep going until checks pass** is also offered from the chat's **+** menu with a command of your own, and the benchmark has its loop (`checkRounds`), though not yet the protected-file overlay on its grader.

GeminiCode so far gathers context: Jira, Confluence, GitLab, SonarQube, Snyk, Figma, the browser and the workspace index all reach the agent. The next step is to close the loop around the agent's work, so that what it produces is checked, reviewed and verified before a person spends time on it. This page proposes that work, and assesses what the APAC Agentic Toolkit (`apac-agentic-toolkit` and its acceptance repository `apac-agentic-toolkit-test`) offers towards it.

## What is missing today

GeminiCode can start an agent on a ticket, give it its own branch, try its work in your checkout, open a merge request and fix a red pipeline. What happens between "the agent finished its turn" and "a person reviews the merge request" is left to the person:

- **Nothing verifies an agent's change.** No checks run when a turn ends, and Try in Workspace, Merge Back and Open Merge Request don't know whether the tests pass. A thread's "Done, tests pass" is free text.
- **Nothing notices weakened tests.** An agent that edits a failing test until it passes looks the same as one that fixed the code.
- **An agent's changes get no second reader.** **Review > An Agent's Changes** opens the diff only. **Review My Changes** answers in chat, with no findings on lines.
- **There is no security audit flow.** Snyk and SonarQube cover dependencies and known rules; a question such as "do these handlers check authorisation?" has only the general `research` tool.
- **A red main branch is invisible.** Pipelines are read for merge requests only.
- **Tickets aren't checked for readiness.** An agent starts on a ticket with no acceptance criteria as readily as on one with them.

## The APAC Agentic Toolkit, assessed

The toolkit runs the Cursor CLI inside GitHub Actions. It turns an issue labelled `agent:ready` into a draft pull request, reviews pull requests, audits chosen folders for security defects, fixes one verified finding, and repairs a failed default-branch CI run. Each task is generated in a locked-down container, validated on a separate VM and published by a third job. The test repository holds planted-defect fixtures and an independent verifier that checks every release against them.

Every file in both repositories was read. Most of the code exists because three CI jobs with different permissions must prove to each other that they saw the same artifact; a desktop app with one process and local git has no such boundary. A few mechanisms are small, well tested and carry over directly.

### Worth taking

| Toolkit mechanism | Where it lives | What it becomes in GeminiCode |
| --- | --- | --- |
| **Protected-baseline overlay.** After the candidate's own checks pass, the repository's original tests and test configuration are written back over the candidate, and the acceptance checks run again. A change that only passed by editing tests fails. | `src/validation.mjs` (`executeValidation`), `src/preflight.mjs` | The core of **Verify** (phase 1). |
| **Regression contract.** A task names the tests that must fail before and pass after; anything else failing, or zero tests running, doesn't count. | `scripts/acceptance-outcome.mjs`, the fixture policies in `-test/.github/*.json` | **Test-first tickets** (phase 3). |
| **Published bytes equal tested bytes.** The verifier compares each pushed blob with the bytes that passed validation. | `scripts/acceptance-outcome.mjs` | Checks bind to a git tree; Open Merge Request and Merge Back warn when the tree changed since checks last passed (phase 1). |
| **Findings schema, re-checked against the file.** Each finding has a path, a line, a severity, a title and evidence with a concrete trigger. Before anything is shown, the line must exist in the file read back from git, and findings on unchanged lines go to the summary. | `src/policy.mjs` (`validateFindings`), `src/review-lines.mjs` | Review of an agent's changes with findings on lines (phase 2), and the audit report (phase 4). |
| **Coverage stated, never implied.** A review that left files out lists them with the reason, and the prompt forbids claiming the whole change is clean. | `src/review.mjs`, `src/runtime/instructions.mjs` | The same line in every review and audit GeminiCode writes, including merge request reviews. |
| **Procedures that ask for evidence.** Four short prompts: name the trigger, the impact and the line; prefer a few supported findings to guesses; "suspected from inspection, not reproduced"; never weaken tests. | `procedures/*.md` | The wording of the reviewer, auditor and fixer prompts in phases 1 to 4. |
| **Audit, then fix one verified finding.** Audit never edits; remediation takes one finding, first checks it still applies, and must keep a regression test. | `procedures/audit.md`, `procedures/remediate.md`, the audit and remediation fixtures | **Security audit** (phase 4). |
| **Repair a red default branch,** only for the latest commit, with a bounded tail of each failed job's log. | `src/events.mjs` (`ciTask`), `src/github.mjs` | **Red main on Home** (phase 5), for GitLab pipelines. |
| **Planted-defect fixtures with a clean control.** A defect file and a behaviour-preserving twin; a false positive fails the case as much as a miss; expected severities are a set, declared before the run. | `-test/acceptance/review/`, `-test/src/query.mjs` and `safe-query.mjs` | Review and audit cases in `gemini/bench`, run when a prompt or the CLI changes (phase 2). |

### Already covered in GeminiCode

- **Untrusted text framed as data.** The toolkit puts task text and diffs in a file the model is told to treat as data. GeminiCode wraps everything from Jira, GitLab, Confluence and Figma in `<external>` and says so in the server's instructions.
- **A branch's own agent configuration can't run.** The toolkit hides `.cursor/`, `AGENTS.md` and `.mcp.json` from the model. GeminiCode reviews merge requests in `~/.geminicode/reviews`, which the CLI never trusts, so a branch's settings, hooks and MCP servers never load.
- **Idempotent, audited writes.** The toolkit reuses its branch and edits one status comment per request. GeminiCode records an intent before every team write, reports a half-done two-step write as such, and keeps review drafts until you post them.
- **The toolkit's own skill.** Its `.agents/skills/apac-agent-toolkit` skill already loads in GeminiCode, which reads `.agents/skills`, so a repository that installed the toolkit can start its hosted tasks from a GeminiCode chat with nothing built.

### Left out, and why

- **Event-triggered and background runs** (labels, pull request events, failed CI starting work by themselves). ADR 0009 keeps GeminiCode desktop-only: nothing runs while the app is closed. Home can show what is ready or red; a person starts the work.
- **GitHub.** The toolkit is built on GitHub; GeminiCode's teams use GitLab and have no GitHub integration. Adding one is a project of its own and belongs only on a team's request.
- **The container, the receipt chain and the release-evidence gate.** They prove one CI job's output to another and replace a cross-repository token. Locally, one tree hash does the job.
- **The xAI gateway and request recorder.** They exist because Cursor can't report usage for a key brought from elsewhere. The Gemini CLI reports usage itself, and GeminiCode shows only what it reports.
- **Delivery declarations** (`owner`, `providerApproval`, `data: synthetic`). These are organisational controls for a hosted bot, and GeminiCode has no admin policy.
- **Path allow-lists for the model.** GeminiCode already limits an agent to its folder and keeps secrets and ignored files out. Prefix-only read and write lists would add a second, weaker policy.

## Proposed work

Six phases, each its own pull request, in the order that gives each one the most to build on. Phase 1 is the foundation the others use.

### Phase 1: Verify

**What.** When an agent's turn changes files, GeminiCode can run the repository's checks in the agent's folder and show the result on the Changes panel, before you try, merge or open a merge request.

- **Checks** come from the team defaults, `.gemini/geminicode-tools.json`, in a new `checks` section: the commands (such as `npm test`), the paths whose original version counts (`protected`, default: test folders and files, `package.json`, the lockfile and test configuration), and when to run (`afterTurn`: `always`, `ask` or `never`; default `ask`). A repository's commands are shown and asked for once, **Don't Run**, **Run Once** or **Run and Remember**, as the worktree setup script is, and run only in a trusted folder.
- **Two runs.** First the commands run on the agent's work as it is. When those pass and the agent changed a protected file, they run again with the protected files put back as they were at the agent's base commit, in a scratch copy of the tree. The panel then says, for example, **Passes with the agent's test changes, fails with the original tests**, and lists the test files it changed.
- **Bound to a tree.** A result records the git tree it ran on (`snapshotTree` in `src/acp/worktreeApply.ts` already makes one without touching the index). **Open Merge Request**, **Merge Back** and **Try in Workspace** show the last result, and say so when the agent changed files after it, such as **Checks passed on an earlier version**. They never refuse: the person decides.
- **Fix failures.** A failed run offers **Send Failures to Agent**: the command, its exit code and the last 200 lines, wrapped as external data, as **Send Output to Gemini** does today. An opt-in **Keep going until checks pass** sends them by itself, at most `gemini.verify.maxRounds` times (default 2), and stops early when a round changes nothing. Each round is an ordinary turn, so its tokens show as any turn's do.
- **Projects.** A thread that ends a turn with changes runs its checks, and its card and the coordinator's next wake carry the result in place of free text.

**Where.** The decisions (which run, what counts as protected, how a result relates to a tree, the round limit) go in a new editor-free `src/acp/verify.ts`; running commands goes through the existing terminal and task plumbing on the host side, loaded on demand in `dist/onDemand.js`. The result shows in the Changes panel (`src/host/changesPanel.ts`, `webview-src/changes.ts`), beside the merge request card, not in a new view. The team defaults reader is `src/acp/teamDefaults.ts`; the file is a versioned contract under ADR 0008, so the new section needs its version and migration noted.

**Why first.** It answers the most common question about an agent's work, is the cheapest to build on existing parts, and every later phase relies on it.

**Risks.** Checks run with your permissions, as the agent's commands do; the trust prompt and the same risky-command rules apply. Long test suites: runs never block the chat, start only after the turn ends, and a new turn cancels a run that hasn't finished.

### Phase 2: A second reader for an agent's changes

**What.** **Review > An Agent's Changes** and **Review My Changes** start a reviewer agent in Plan mode, in a fresh session that didn't write the code, and turn its findings into comments on the lines of the diff: Bug, Should fix, Question or Nit, each with a trigger and evidence. Instead of **Post**, the actions are **Send to Agent** (the ticked findings go to the agent that wrote the change, or to a new agent for your own changes) and **Dismiss**.

- Findings follow the toolkit's schema and are checked against the file read back from git; a finding on a line that doesn't exist is dropped, one on an unchanged line goes to the summary.
- When the diff was too large to send whole, the review names what it left out.
- Phase 1's check results go in the reviewer's prompt, so it doesn't spend findings on what a test already caught.

**Where.** The merge request review already turns a JSON findings block into a draft with comments on lines (`src/acp/reviewDraft.ts`, `src/host/reviewComments.ts`, `src/acp/contextPack.ts`). This phase points the same draft at a local diff and replaces the GitLab post with a prompt to an agent. `src/acp/reviewPrompt.ts` gains the procedures' wording.

**Bench.** Add review and audit cases to `gemini/bench`: each a planted defect with a clean twin, expected path and line, and a set of accepted severities, run by hand when a reviewer prompt or the CLI version changes. A false positive on the clean twin fails the case. The bench's existing grader also runs in the agent's tree; it should gain the protected-file overlay from phase 1, so a task the agent "completed" by editing its tests isn't counted.

### Phase 3: Test-first tickets

**What.** Starting an agent on a Jira ticket offers **Test First**:

1. The agent reads the ticket and writes the tests its acceptance criteria describe, and nothing else, then stops.
2. GeminiCode runs them on the base commit. They must fail, and the run lists which. Tests that already pass are reported, since they don't describe the change.
3. You approve the tests (or ask for changes), and they become protected for this agent.
4. The agent implements. Phase 1's two runs then show whether the named tests now pass, whether anything else broke, and whether the agent touched the approved tests.

Before step 1, a **readiness check** reads the ticket. When it has no testable acceptance criteria, the agent drafts the questions instead, for you to post as a Jira comment through the usual permission card, or to answer yourself.

**Where.** A new start option beside Plan first in `Start Agent on Jira Ticket` (the ticket prompts in `src/acp/teamFlowLogic.ts`); the contract (named tests, before and after) in `src/acp/verify.ts`. Telling which named tests failed needs a test report; the first version reads JUnit XML where the repository's runner writes it, and falls back to exit codes only, saying so.

### Phase 4: Security audit and fix

**What.** **Review > Security Audit...** asks for a scope and a question, such as "the API handlers: missing authorisation and injection". Read-only workers, the same as the `research` tool's, read the scope; a verifier rereads each finding; the result is a findings report with path, line, severity, trigger and impact, each marked "suspected from reading the code, not reproduced". Snyk's and SonarQube's open issues in the same paths can be included.

The report stays on your Mac, like a review draft. Each finding has **Dismiss**, **Mark Verified** and **Fix**. Fix starts an agent on its own branch with that one finding. The agent first checks the finding still applies, then makes a focused change with a regression test, and phase 1 verifies it.

**Where.** `src/acp/research.ts` already plans slices, runs read-only workers four at a time and verifies; this phase gives it the audit procedure and the findings schema, and stores the report as review drafts are stored (`src/acp/reviewStore.ts`). Entry is one more choice in `Gemini: Review...` (`src/host/agentsView.ts`), so the command palette budget in `test/perf/surface.test.ts` doesn't grow.

### Phase 5: Red main on Home

**What.** When the latest pipeline on the default branch, or the release branch Quality already watches, has failed, Home says so with the failed jobs and **Fix**. Fix starts an agent on its own branch named after the pipeline, with the failed jobs' names and a bounded tail of each log as its first prompt; phase 1 verifies the fix, and Open Merge Request links the pipeline. A pipeline that isn't on the branch's latest commit isn't offered, since it may already be fixed.

**Where.** `gitlab_job_log` and the pipeline reads exist for merge requests (`src/acp/gitlab.ts`); the MR panel's **Fix Pipeline** prompt is the model. Home's card shows only while a pipeline is red, so it adds nothing to Home's controls the rest of the time.

### Phase 6, later: Best of N

**What.** For a ticket where the approach is open, **Try Two Ways** forks the agent after its plan into two threads on their own branches, optionally on different models. When both finish, a comparison card shows each one's phase 1 result, phase 2 findings and diff size, with **Keep This One**. It is built entirely from Fork, Projects and the earlier phases.

**Why later.** It doubles the quota a ticket uses, and is worth building only once phases 1 and 2 make the two attempts comparable without reading both diffs.

## Cross-cutting rules

- **Performance first.** Nothing runs in the chat's path: checks start after a turn ends, reviews and audits in their own sessions. New code loads on demand (`dist/onDemand.js`, `dist/pages.js`), and the `dist/extension.js` budget doesn't grow.
- **One place per job.** Check results live in the Changes panel, reviews and audits under **Review**, red pipelines on Home. Any new command or setting raises a budget in `test/perf/surface.test.ts` on purpose.
- **Only the CLI's numbers.** Token and time figures come from what the Gemini CLI reports. Check results are counts GeminiCode observed, such as exit codes and named tests.
- **Nothing is refused for you.** Verify, review and audit inform Try, Merge Back and Open Merge Request; they never block them. The confirm class is unchanged.
- **Testable logic in `src/acp`.** Each phase's decisions live in editor-free modules with Vitest tests, against the fake agent; the real app is checked with the `geminicode-real-app` skill.
- **Docs in the same pull request.** `guide/review.md`, `guide/agents.md`, `guide/projects.md` and `guide/team-tools.md` describe each phase as it lands, and `ARCHITECTURE.md` gets its module notes.

## Decisions needed

1. Lift the feature freeze for which phases.
2. Whether checks after a turn default to **Ask** or **Always**.
3. Whether **Keep going until checks pass** belongs in phase 1, or waits until phase 1 has been used for a while.
