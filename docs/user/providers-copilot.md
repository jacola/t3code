# GitHub Copilot

T3 Code runs your installed GitHub Copilot CLI through its Agent Client Protocol mode, so Copilot
keeps its own models, sign-in, skills, custom agents, instructions, MCP servers, and session
history.

## Set Up Copilot

1. Install the [GitHub Copilot CLI](https://github.com/features/copilot/cli) on the machine
   running the T3 Code server, for example with `brew install copilot-cli` or
   `npm install -g @github/copilot`. T3 Code supports Copilot CLI 1.0.98 or newer.
2. Run `copilot login`.
3. Open **Settings → Providers**, enable GitHub Copilot, and select **Refresh provider status**
   (the refresh icon above the provider list).

If `copilot` is not on the server's `PATH`, set its **Binary path**. To keep a second account
separate, add another GitHub Copilot provider and give it its own **COPILOT_HOME path**, then
run `COPILOT_HOME=<that path> copilot login`. Each account keeps its own sign-in, settings, and
sessions. Without its own `copilot login`, Copilot uses the GitHub CLI's (`gh`) sign-in, which every
provider without a login shares; the provider card then reports the sign-in as unchecked.

T3 Code ignores `GH_TOKEN`, `GITHUB_TOKEN`, and `COPILOT_GITHUB_TOKEN` inherited from the server's
environment, because Copilot would otherwise use that token instead of the account you signed in
with. To sign in with a token, add **GitHub token** in the provider's environment settings. The
token must be a fine-grained personal access token with the Copilot Requests permission, or an
OAuth token from the Copilot CLI or GitHub CLI.

Health checks read the CLI version and the signed-in account without starting a Copilot session,
so they never start your MCP servers or hooks. Copilot only lists its models inside a session.
T3 Code learns them when you select **Refresh provider status**, which opens one short session,
and from your threads.

## Models

The model picker shows the models your Copilot plan and organization allow, including **Auto**,
which lets Copilot pick a model for each request. The default is the model Copilot itself is
configured to use. Models that support it offer a **Reasoning effort** choice, and an **Agent**
choice selects one of your custom agents.

Commit messages, pull request text, and thread titles use GPT-5 mini by default. That model is
included in Copilot plans without premium requests. Those helper sessions run with every tool
removed.

## Plan Mode

The composer's **Plan** toggle switches Copilot to its plan mode. When Copilot saves its plan,
T3 Code shows it as a proposed plan you can implement.

## Commands and Skills

Copilot's slash commands and your Copilot skills appear in the composer's `/` menu. A skill runs
as Copilot's own `/skill-name` command. Commands that would change settings T3 Code manages for
the thread, such as `/model`, `/permissions`, `/allow-all`, `/autopilot`, `/plan`, and `/cwd`,
are not offered; use the composer's model, permission, and plan controls instead.

## Permission Modes

Copilot enforces the permission mode itself, through the flags it starts with. T3 Code ignores
`COPILOT_ALLOW_ALL` and `COPILOT_ASSISTED_APPROVAL`, so a standing grant cannot widen a thread's
mode:

- **Supervised** asks before commands, file changes, and access outside the workspace.
- **Auto-accept edits** allows file changes without asking. Commands still ask.
- **Full access** allows commands, file changes, paths, and URLs without asking.

Copilot has no **Auto** mode; a thread set to it runs in **Supervised**. An explicit approval or
sandbox policy also starts Copilot in **Supervised**, so every request reaches that policy.

## Usage

**Usage** includes Copilot's per-request token counts from each account's
`session-state` history. Copilot reports premium-request multipliers rather than prices, so costs
are estimated from public model rates where T3 Code knows them.

## Limits

- Copilot's `ask_user` tool is not available to clients, so Copilot asks questions in its
  replies.
- Copilot cannot truncate a conversation. Reverting a turn restores files, and the next turn
  starts a fresh Copilot session.
- Quota and rate-limit errors mark the thread as Limited so you can resume it later.
