# Benchmark

The benchmark is a set of tasks drawn from the team's own closed Jira tickets. It runs against a release build of GeminiCode's agent path on a developer's Mac, under that developer's seat, and reports per task and per release whether the agent completed the task, how many tokens and requests it took, and how long it took.

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
  "check": { "command": "npm ci && npm run typecheck && npm test -- --exclude giftMessage" },
  "touchedFiles": ["src/checkout/GiftMessage.tsx", "src/checkout/__tests__/giftMessage.test.tsx"]
}
```

- `baseSha` is the commit the merge request started from, so the agent sees the code as the author did.
- `prompt` is the ticket as the agent reads it through `jira_get_issue`: summary, then description.
- `grader` is the merge request's own test command, run in the agent's working tree when the turn ends. Passing it is what "completed" means. The command runs through the shell, so it needs the tools the repository needs.
- `check` is optional: the repository's own check as it stood before the ticket (its type check, its existing tests). A variant with `checkRounds` runs it after each turn and sends its failures back to the agent, as **Keep going until checks pass** does. Never put the grader here: an agent shown the answer is no longer being measured.
- `touchedFiles` is for the report only: which of the author's files the agent also changed.

`select.mts` writes these from Jira and GitLab:

```sh
node --experimental-transform-types gemini/bench/select.mts \
  --jira https://acme.atlassian.net --jira-email you@acme.example --jira-token "$JIRA_API_TOKEN" \
  --gitlab https://gitlab.acme.internal --gitlab-token "$GITLAB_PERSONAL_ACCESS_TOKEN" \
  --jql 'project = ACME AND statusCategory = Done AND resolved >= -180d' \
  --grader 'npm ci && npm test' --max 30
```

It keeps tickets whose merge request merged, changed between 20 and 400 lines (`--min-lines` and `--max-lines` change the range), and touched at least one test file. Read each task file before keeping it: a ticket written for a person may need a line of context an agent will not have.

## Running

In the release build, turn on `gemini.developer.showTools`, then run **Gemini: Run Benchmark...** from the Command Palette or the Gemini status menu.

1. It uses `gemini/bench/tasks` when the window has this repository open, or asks for a tasks folder.
2. It asks for the model and confirms the run.
3. It starts the CLI the app runs, as the app starts it, and writes `<GeminiCode version>-<CLI version>-<model>.json` into `results/` beside the tasks folder.

Cancel it from its notification. A cancelled run writes nothing.

The same run as a script takes any CLI, here the one the app bundles:

```sh
node --experimental-transform-types extensions/gemini/scripts/bench-run.mts --cli /Applications/GeminiCode.app/Contents/Resources/app/extensions/gemini/cli/0.71.1/bundle/gemini.js \
  --model gemini-3.8-flash --version <GeminiCode version>
```

It writes the results file into `gemini/bench/results/` under the same name the command uses; `--out` names another file. `--only` runs some of the tasks by key, `--project` sets the Google Cloud project, and `--timeout` caps each turn (20 minutes by default).

### Variants

To learn what a change is worth, run the same tasks with and without it. `--variants` names a JSON file of variants; each one is a full run, written to its own results file (`...-<model>-<variant>.json`, in the folder `--out` names), and a table at the end sets them side by side:

```json
[
  { "name": "base" },
  { "name": "verify-2", "checkRounds": 2 },
  { "name": "compress-0.3", "settings": { "model": { "compressionThreshold": 0.3 } } }
]
```

- `settings` are CLI settings the run forces. They are written to a file the CLI reads as its system settings (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`), which override your own for that run only.
- `env` adds environment variables for the CLI.
- `checkRounds` (0 to 10) is how many times a task's `check` may send its failures back. Tasks without a `check` take one turn whatever it says.

```text
variant       completed  rate  median turns  median s  tokens in / task  tokens out / task  requests / completed
base          11/30      37%   1             212       184000            5200               14.2
verify-2      15/30      50%   2             301       241000            6900               17.8
```

`variants.example.json` beside this file holds a baseline and one variant for each number the Settings page lets you tune (the request timeout, the compression threshold, the tries and the tool-output cap), ready to run:

```sh
node --experimental-transform-types extensions/gemini/scripts/bench-run.mts --cli <gemini.js> --model <id> --variants gemini/bench/variants.example.json
```

The numbers above only show the table's shape. Run the variants on the sign-in and Google Cloud project your team uses, so they describe the models you have.

For each task, the run:

1. clones the repository at `baseSha` into a temporary folder;
2. starts `gemini --acp` with your saved sign-in and the project ID you use;
3. opens a session there in Auto Edit mode on the named model and sends the prompt;
4. allows the agent's tool calls;
5. runs the grader when the turn ends.

It records the tokens the CLI reports for each turn, the number of turns and model calls, the time to the first text and to the end, and the grader's result. Tasks run one at a time. A task takes about 15 requests, so 30 tasks on two models fit in a day's Enterprise quota with room left to work.

Add the results files to `results/` by pull request. When a stable release is published, the release workflow opens an issue titled `Benchmark <version>` as the reminder; with the repository's Issues off, it leaves a warning on the run instead.

The site has no Benchmark page. `gemini/site/bench.mts` can write the results files as a Markdown page (`benchmarkMarkdown`), but `build.mts` does not use it, and the Pages workflow does not run when a results file changes.

## Reading the results

| Column | Meaning |
| --- | --- |
| completed | the grader passed |
| turns | the prompts the agent got: the task, then one each time its check failed (variants with `checkRounds`) |
| requests | model calls in the task's turns, from the CLI |
| tokensIn, tokensOut | the turns' totals, from the CLI's `_meta.quota` |
| firstTextMs | from the prompt to the first streamed text |
| wallMs | from the prompt to the end of the last turn, the checks between turns included |
| graderMs | the grader's run time, kept apart from the agent's |

Compare releases on the completion rate first, then on requests per completed task. A release that completes the same tasks with fewer requests is the one to ship. Compare variants the same way, with tokens per task beside it: a variant that completes more tasks at twice the tokens is a choice to make, not a win to assume.
