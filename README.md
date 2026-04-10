# Community Index

Community Index is a GitOps-managed JSON index for Eagle plugin releases. It acts like a shared bucket of discoverable plugin metadata, with automated workflows that validate submissions and keep entries in sync with upstream releases.

<!-- README:SECTION:USERS:START -->
## For Users

If you just want to use the index, the main file is [index.json](index.json). Each entry describes a plugin source, the current published version, the release asset URL, and the strategy used to validate that release.

Typical consumers should treat this repository as read-only data:
- read [index.json](index.json) for the active index
- use the `url` field to download the current plugin artifact
- use the `version` field to compare installed versus published versions
- use the `source` field to trace the plugin back to its GitHub repository

The index is also refreshed automatically in scheduled batches, so entries can be updated even when nobody opens a manual issue.

Related files:
- [index_trustedauthors.json](index_trustedauthors.json): users or organizations allowed to submit entries for repositories they do not directly own
- [config.json](config.json): repository runtime settings such as scheduled batch size and stale interval
- [index_promoted.json](index_promoted.json): promoted subset of the index filtered by minimum trusted upvotes
- [LICENSE](LICENSE): repository license

If you are not contributing changes, you do not need to understand the workflows under `.github/`.
<!-- README:SECTION:USERS:END -->

<!-- README:SECTION:AUTHORS:START -->
## For Authors

Authors should not edit [index.json](index.json) directly through normal use. Instead, open GitHub issues that trigger the repository workflows.

### Add a New Entry

Use the `Add Entry` issue form in [.github/ISSUE_TEMPLATE/add-entry.yml](.github/ISSUE_TEMPLATE/add-entry.yml).

Required fields:
- `source`: GitHub repository in `owner/repository` format
- `checkstrategy`: the validation strategy to use

Current behavior:
- the issue must carry the `add-entry` label
- the workflow validates that the issue author is either the repository owner or listed in [index_trustedauthors.json](index_trustedauthors.json)
- the workflow loads the named strategy script from [.github/scripts/check-strategies](.github/scripts/check-strategies)
- if a valid release is found, the workflow appends a new entry to [index.json](index.json), commits directly to `main`, comments `done <commit-hash>`, and closes the issue
- if validation fails, the workflow adds `require-human-intervention` and comments the reason

### Report a Mismatched Version

Use the `Mismatched Version` issue form in [.github/ISSUE_TEMPLATE/mismatched-version.yml](.github/ISSUE_TEMPLATE/mismatched-version.yml).

Current behavior:
- the issue must carry the `mismatched-version` label
- the workflow identifies the existing entry in [index.json](index.json) by `source`
- it replies `source identified: <source>, checking...`
- it loads the entry's `checkstrategy` script and checks the latest matching upstream release
- if the upstream version or URL changed, it updates [index.json](index.json), commits directly to `main`, replies with a thank-you message including the commit hash, and closes the issue
- if there is no difference, it replies `no changes found for <source>`

### Scheduled Refresh

The repository also runs a scheduled update workflow in [.github/workflows/update-plugins.yml](.github/workflows/update-plugins.yml).

Current behavior:
- it runs every 6 hours
- it reads batching settings from [config.json](config.json)
- it selects up to `batching_count` entries from [index.json](index.json) with the oldest `lastchecked` values
- it skips entries checked within `stale_interval` seconds
- it loads the entry's `checkstrategy` script and checks the latest matching upstream release
- it updates `lastchecked` for successfully checked entries
- it updates `version` and `url` when upstream data changed
- after the batch, it rebuilds [index_promoted.json](index_promoted.json) using the configured promotion threshold
- it commits the batch directly to `main`

### Upvote An Entry

Use the `Upvote` issue form in [.github/ISSUE_TEMPLATE/upvote.yml](.github/ISSUE_TEMPLATE/upvote.yml).

Current behavior:
- the issue must carry the `upvote` label
- the issue author must already be listed in [index_trustedauthors.json](index_trustedauthors.json)
- the workflow finds the existing entry in [index.json](index.json) by `source`
- it increments the entry's `upvotes`
- it rebuilds [index_promoted.json](index_promoted.json)
- it commits directly to `main`, replies with the commit hash, and closes the issue

### Current Strategy Contract

Each entry stores only the strategy name, for example `power-eagle-v1`. The behavior for that strategy lives in a dedicated script file under [.github/scripts/check-strategies](.github/scripts/check-strategies).

Current script contract:
- file path: `.github/scripts/check-strategies/<strategy-name>.mjs`
- required export: `resolveReleaseContext(releases)`
- return value: either `null` or an object containing the resolved release data used to update the index

The current implementation for `power-eagle-v1` is in [.github/scripts/check-strategies/power-eagle-v1.mjs](.github/scripts/check-strategies/power-eagle-v1.mjs).
<!-- README:SECTION:AUTHORS:END -->

<!-- README:SECTION:MAINTAINERS:START -->
## For Maintainers And Future Agents

This section documents the repository's advanced patterns and the rules for editing this README safely.

### README Editing Contract

Preserve these section markers exactly:
- `<!-- README:SECTION:USERS:START -->` and `<!-- README:SECTION:USERS:END -->`
- `<!-- README:SECTION:AUTHORS:START -->` and `<!-- README:SECTION:AUTHORS:END -->`
- `<!-- README:SECTION:MAINTAINERS:START -->` and `<!-- README:SECTION:MAINTAINERS:END -->`

Update rules:
- keep the three top-level sections in the same order
- add new content inside the appropriate marked section instead of moving sections around
- do not rename headings unless the repository owner explicitly requests it
- do not replace repository-specific workflow descriptions with generic GitHub boilerplate
- when documenting automation, describe the behavior that actually exists in files under [.github/workflows](.github/workflows) and [.github/scripts](.github/scripts)

### Advanced Patterns In This Repository

The repository intentionally separates data, workflow orchestration, and strategy-specific release detection.

Pattern summary:
- [index.json](index.json) is the canonical machine-readable plugin index
- [config.json](config.json) stores runtime batch settings for scheduled refresh behavior
- [index_promoted.json](index_promoted.json) is a filtered, higher-trust subset based on upvote threshold
- issue forms under [.github/ISSUE_TEMPLATE](.github/ISSUE_TEMPLATE) collect structured requests from contributors
- workflows under [.github/workflows](.github/workflows) translate issues into validated GitOps actions
- strategy logic under [.github/scripts/check-strategies](.github/scripts/check-strategies) decides how to detect a valid upstream release for a given naming convention
- processor scripts under [.github/scripts](.github/scripts) handle parsing, validation, index mutation, and workflow outputs
- the scheduled updater batches stale entries by `lastchecked` so the repo refreshes gradually instead of checking every source on every run

### How To Extend The System

To add a new check strategy:
1. Create a new script at `.github/scripts/check-strategies/<name>.mjs`.
2. Export `resolveReleaseContext(releases)`.
3. Return `null` when no release matches the strategy.
4. Return the resolved fields when a match is found.
5. Add the new strategy name to the add-entry issue form if contributors should be able to select it.

To update automation behavior:
1. Update the relevant processor script in [.github/scripts](.github/scripts).
2. Update the corresponding workflow in [.github/workflows](.github/workflows).
3. Update [config.json](config.json) if the runtime thresholds or batch sizing changed.
4. Update this README only in the section whose contract changed.

Promotion behavior is controlled by [config.json](config.json):
- `promoted_min_upvotes` decides when an entry is included in [index_promoted.json](index_promoted.json)

### Agent Guidance

Future agents updating this README should prefer minimal edits:
- update only the section affected by the repository change
- preserve the markers and section ordering
- keep user-facing explanations simple in the first section
- keep operational details in the author and maintainer sections
- avoid turning this file into a changelog or dumping raw workflow YAML into it
<!-- README:SECTION:MAINTAINERS:END -->
