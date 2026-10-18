# Benchmark

A set of tasks drawn from the team's own closed Jira tickets, run against a release build of GeminiCode's agent path on a developer's Mac, under that developer's seat. It reports, per task and per release, whether the agent completed the task, how many tokens and requests it took, and how long. The plan that asks for it is [docs/AGENTIC-PLAN.md](../docs/AGENTIC-PLAN.md), section 5.

Nothing here runs in hosted CI: hosted runners cannot sign in to Gemini Code Assist, and this project owns no always-on machine. Run it on release day, by hand, from the release build.

## Tasks

One file per task in `tasks/`, named after the ticket:

```json
{
  "key": "ACME-412",
  "repo": "git@gitlab.acme.internal:shop/checkout.git",
  "baseSha": "3f9e2c1d…",
  "prompt": "Gift message at checkout\n\nAs a shopper I want to add a gift message…",
  "grader": { "command": "npm ci && npm test -- giftMessage", "timeoutMs": 600000 },
  "touchedFiles": ["src/checkout/GiftMessage.tsx", "src/checkout/__tests__/giftMessage.test.tsx"]
}
```

- `baseSha` is the commit the merge request started from, so the agent sees the code as the author did.
- `prompt` is the ticket as the agent reads it through `jira_get_issue`: summary, then description.
- `grader` is the merge request's own test command, run in the agent's working tree when the turn ends. Passing it is what "completed" means. The command runs through the shell, so it needs the tools the repository needs.
- `touchedFiles` is for the report only: which of the author's files the agent also changed.

`select.mts` writes these from Jira and GitLab:

```sh
node --experimental-transform-types gemini/bench/select.mts \
  --jira https://acme.atlassian.net --jira-email you@acme.example --jira-token "$JIRA_API_TOKEN" \
  --gitlab https://gitlab.acme.internal --gitlab-token "$GITLAB_PERSONAL_ACCESS_TOKEN" \
  --jql 'project = ACME AND statusCategory = Done AND resolved >= -180d' \
  --grader 'npm ci && npm test' --max 30
```

It keeps tickets whose merge request merged, changed between 20 and 400 lines, and touched at least one test file. Read each task file before keeping it: a ticket written for a person may need a line of context an agent will not have.

## Running

```sh
node --experimental-transform-types extensions/gemini/scripts/bench-run.mts --cli /Applications/GeminiCode.app/Contents/Resources/app/extensions/gemini/cli/0.64.0/bundle/gemini.js \
  --model gemini-3.8-flash --out gemini/bench/results/1.2.0-0.64.0.json
```

For each task it clones the repository at `baseSha` into a temporary worktree, starts `gemini --acp` with your saved sign-in and the project ID you use, opens a session there in Auto Edit mode on the named model, sends the prompt, allows the agent's tool calls, and when the turn ends runs the grader. It records the tokens the CLI reports for the turn, the number of model calls, the time to the first text and to the end, and the grader's result. One task at a time; about 15 requests per task, so 30 tasks on two models fit in a day's Enterprise quota with room to work.

The results file is added to `results/` by pull request. A page on the docs site that reads those files is not built yet; until then, compare the files by hand.

## Reading the results

| Column | Meaning |
| --- | --- |
| completed | the grader passed |
| requests | model calls in the turn, from the CLI |
| tokensIn, tokensOut | the turn's totals, from the CLI's `_meta.quota` |
| firstTextMs | from the prompt to the first streamed text |
| wallMs | from the prompt to the end of the turn |
| graderMs | the grader's run time, kept apart from the agent's |

Compare releases on the completion rate first, then on requests per completed task. A release that completes the same tasks with fewer requests is the one to ship.
