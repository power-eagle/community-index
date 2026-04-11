# Community Index

Community Index is a GitOps-managed JSON index for Eagle plugin releases. It acts like a shared bucket of discoverable plugin metadata, with automated workflows that validate submissions and keep entries in sync with upstream releases.

<!-- README:SECTION:USERS:START -->
## For Users

If you just want to consume the index, use [index.json](index.json). Each entry gives you the plugin source repository, current version, download URL, check strategy, and stable `uuid` from the target repository manifest.

The repository is read-mostly for consumers. Scheduled workflows keep entries fresh in the background, and [index_promoted.json](index_promoted.json) exposes the promoted subset once an entry reaches the configured trusted-upvote threshold.
<!-- README:SECTION:USERS:END -->

<!-- README:SECTION:AUTHORS:START -->
## For Authors

Authors should not edit [index.json](index.json) directly through normal use. Instead, open GitHub issues that trigger the repository workflows.

### Add a New Entry

Use the `Add Entry` issue form in [.github/ISSUE_TEMPLATE/add-entry.yml](.github/ISSUE_TEMPLATE/add-entry.yml).

Required fields:
- `source`: GitHub repository in `owner/repository` format
- `checkstrategy`: the validation strategy to use

The workflow validates the requester, resolves the latest matching release with the selected strategy, reads the target repository `manifest.json`, writes the new entry to [index.json](index.json), commits directly to `main`, and closes the issue. Invalid or suspicious requests are routed to human intervention.

### Report a Mismatched Version

Use the `Mismatched Version` issue form in [.github/ISSUE_TEMPLATE/mismatched-version.yml](.github/ISSUE_TEMPLATE/mismatched-version.yml).

The workflow rechecks one indexed source against upstream releases and the repository manifest UUID. If the version or asset URL changed, it updates the entry. If nothing changed, it still refreshes `lastchecked`. UUID drift is treated as a stop-and-review condition.

### Scheduled Refresh

The repository also runs a scheduled update workflow in [.github/workflows/update-plugins.yml](.github/workflows/update-plugins.yml).

Every 6 hours, the scheduler selects the stalest eligible entries from [index.json](index.json), refreshes them with their configured strategy, rebuilds [index_promoted.json](index_promoted.json), and commits directly to `main`. Repeated missing repositories are tracked in [metadata.json](metadata.json), and UUID drift prevents automatic writes.

### Upvote An Entry

Use the `Upvote` issue form in [.github/ISSUE_TEMPLATE/upvote.yml](.github/ISSUE_TEMPLATE/upvote.yml).

Trusted authors can upvote an existing entry. The workflow increments `upvotes`, rebuilds [index_promoted.json](index_promoted.json), commits directly to `main`, and closes the issue.

### Current Strategy Contract

Each entry stores only the strategy name, for example `power-eagle-v1`. The behavior for that strategy lives in a dedicated script file under [.github/scripts/check-strategies](.github/scripts/check-strategies).

Current script contract:
- file path: `.github/scripts/check-strategies/<strategy-name>.mjs`
- required export: `resolveReleaseContext(releases, context)`
- return value: either `null` or an object containing the resolved release data, including the UUID resolved from the repository manifest

The current implementation for `power-eagle-v1` is in [.github/scripts/check-strategies/power-eagle-v1.mjs](.github/scripts/check-strategies/power-eagle-v1.mjs).
<!-- README:SECTION:AUTHORS:END -->

<!-- README:SECTION:MAINTAINERS:START -->
## For Maintainers And Future Agents

Keep this README brief and user-oriented. Durable maintainer detail now lives in zmem memory files such as [.zmem/memory/e50b.md](.zmem/memory/e50b.md) and [.zmem/memory/08bf.md](.zmem/memory/08bf.md).

### README Editing Contract

Preserve these section markers exactly:
- `<!-- README:SECTION:USERS:START -->` and `<!-- README:SECTION:USERS:END -->`
- `<!-- README:SECTION:AUTHORS:START -->` and `<!-- README:SECTION:AUTHORS:END -->`
- `<!-- README:SECTION:MAINTAINERS:START -->` and `<!-- README:SECTION:MAINTAINERS:END -->`

Update rules:
- keep the three top-level sections in the same order
- keep README changes short and move durable internal detail into zmem rather than expanding this file
- describe only behavior that actually exists in [.github/workflows](.github/workflows) and [.github/scripts](.github/scripts)
<!-- README:SECTION:MAINTAINERS:END -->
