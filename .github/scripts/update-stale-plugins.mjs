import fs from 'node:fs';
import { indexPath, normalize, readConfig, readMetadata, writeIndex, writeMetadata, writePromotedIndex } from './index-utils.mjs';

const githubOutput = process.env.GITHUB_OUTPUT;
const githubToken = process.env.GITHUB_TOKEN;
const dryRun = String(process.env.DRY_RUN ?? '').toLowerCase() === 'true';

/**
 * Write a named value to the GitHub Actions output file.
 */
function setOutput(name, value) {
  if (!githubOutput) {
    return;
  }

  fs.appendFileSync(githubOutput, `${name}<<__OUTPUT__\n${value}\n__OUTPUT__\n`);
}

/**
 * Parse a timestamp string into milliseconds for stale-entry sorting.
 */
function parseTimestamp(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Load a strategy implementation by checkstrategy name.
 */
async function loadCheckStrategy(name) {
  if (!/^[a-z0-9-]+$/i.test(name)) {
    return null;
  }

  try {
    const module = await import(`./check-strategies/${name}.mjs`);
    if (typeof module.resolveReleaseContext !== 'function') {
      return null;
    }

    return module;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') {
      return null;
    }

    throw error;
  }
}

/**
 * Query the GitHub API with the workflow token when available.
 */
async function githubRequest(apiPath) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'community-index-scheduled-update-workflow'
  };

  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }

  const response = await fetch(`https://api.github.com${apiPath}`, {
    headers
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`GitHub API request failed (${response.status}): ${errorText}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

/**
 * Select the oldest eligible entries outside the stale interval.
 */
function selectCandidates(indexEntries, maxBatchSize, staleIntervalSeconds) {
  const cutoff = Date.now() - staleIntervalSeconds * 1000;

  return indexEntries
    .map((entry, entryIndex) => ({ entry, entryIndex }))
    .filter(({ entry }) => parseTimestamp(entry.lastchecked) < cutoff)
    .sort((left, right) => parseTimestamp(left.entry.lastchecked) - parseTimestamp(right.entry.lastchecked))
    .slice(0, maxBatchSize);
}

  /**
   * Check one scheduled entry and return its refreshed release state.
   */
async function processEntry(entry) {
  const source = String(entry.source ?? '').trim();
  if (!source.includes('/')) {
    return {
      status: 'failed',
      source,
      reason: 'Entry source is missing or invalid.'
    };
  }

  const strategy = await loadCheckStrategy(entry.checkstrategy);
  if (!strategy) {
    return {
      status: 'failed',
      source,
      reason: `Unsupported check strategy: ${entry.checkstrategy || 'missing value'}.`
    };
  }

  const [owner, repo] = source.split('/');
  let repoMetadata;
  let releases;

  try {
    repoMetadata = await githubRequest(`/repos/${owner}/${repo}`);
    releases = await githubRequest(`/repos/${owner}/${repo}/releases?per_page=100`);
  } catch (error) {
    if (error?.status === 404) {
      return {
        status: 'missing-repo',
        source,
        reason: `Repository ${source} returned 404.`
      };
    }

    throw error;
  }

  const releaseContext = await strategy.resolveReleaseContext(releases, {
    owner,
    repo,
    defaultBranch: repoMetadata.default_branch,
    githubToken
  });

  if (!releaseContext) {
    return {
      status: 'failed',
      source,
      reason: `No release in ${source} matched the ${entry.checkstrategy} rules.`
    };
  }

  if (entry.uuid && normalize(entry.uuid) !== normalize(releaseContext.uuid)) {
    return {
      status: 'failed',
      source,
      reason: `UUID mismatch detected for ${source}. Stored UUID ${entry.uuid} does not match repository manifest UUID ${releaseContext.uuid}.`
    };
  }

  const checkedAt = new Date().toISOString();
  const updatedEntry = {
    ...entry,
    lastchecked: checkedAt,
    url: releaseContext.assetUrl,
    version: releaseContext.version,
    uuid: releaseContext.uuid
  };
  const changed = normalize(entry.version) !== normalize(releaseContext.version) || normalize(entry.url) !== normalize(releaseContext.assetUrl);

  return {
    status: 'checked',
    source,
    changed,
    updatedEntry,
    version: releaseContext.version
  };
}

/**
 * Read per-source scheduled status from metadata with defaults.
 */
function getSourceStatus(metadata, source) {
  return metadata.source_status[source] ?? {
    missing_repo_404_streak: 0,
    issue_opened: false,
    last_missing_repo_404_at: null
  };
}

/**
 * Store per-source scheduled status in metadata.
 */
function setSourceStatus(metadata, source, nextStatus) {
  metadata.source_status[source] = nextStatus;
}

/**
 * Remove per-source scheduled status after recovery.
 */
function clearSourceStatus(metadata, source) {
  delete metadata.source_status[source];
}

/**
 * Process one scheduled refresh batch and emit workflow outputs.
 */
async function main() {
  const config = readConfig();
  const indexEntries = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const metadata = readMetadata();
  const candidates = selectCandidates(indexEntries, config.batchingCount, config.staleIntervalSeconds);

  if (candidates.length === 0) {
    setOutput('result', 'no-op');
    setOutput('reason', 'No stale entries were eligible for processing.');
    setOutput('processed_count', '0');
    setOutput('updated_count', '0');
    return;
  }

  let checkedCount = 0;
  let updatedCount = 0;
  let metadataChanged = false;
  const failures = [];
  const updatedSources = [];
  const checkedSources = [];
  const missingRepoIssues = [];

  for (const candidate of candidates) {
    const source = String(candidate.entry.source ?? '').trim();

    try {
      const result = await processEntry(candidate.entry);
      if (result.status === 'missing-repo') {
        failures.push(`${result.source || '<unknown>'}: ${result.reason}`);
        const currentStatus = getSourceStatus(metadata, source);
        const nextStatus = {
          missing_repo_404_streak: currentStatus.missing_repo_404_streak + 1,
          issue_opened: currentStatus.issue_opened,
          last_missing_repo_404_at: new Date().toISOString()
        };

        if (nextStatus.missing_repo_404_streak >= config.missingRepoConsecutiveThreshold && !nextStatus.issue_opened) {
          nextStatus.issue_opened = true;
          missingRepoIssues.push({
            source,
            streak: nextStatus.missing_repo_404_streak
          });
        }

        setSourceStatus(metadata, source, nextStatus);
        metadataChanged = true;
        continue;
      }

      if (result.status !== 'checked') {
        failures.push(`${result.source || '<unknown>'}: ${result.reason}`);
        if (metadata.source_status[source]) {
          clearSourceStatus(metadata, source);
          metadataChanged = true;
        }
        continue;
      }

      indexEntries[candidate.entryIndex] = result.updatedEntry;
      checkedCount += 1;
      checkedSources.push(result.source);

      if (metadata.source_status[source]) {
        clearSourceStatus(metadata, source);
        metadataChanged = true;
      }

      if (result.changed) {
        updatedCount += 1;
        updatedSources.push(`${result.source}@${result.version}`);
      }
    } catch (error) {
      failures.push(`${source || '<unknown>'}: ${error.message}`);
      if (metadata.source_status[source]) {
        clearSourceStatus(metadata, source);
        metadataChanged = true;
      }
    }
  }

  if (checkedCount === 0 && !metadataChanged) {
    setOutput('result', 'no-op');
    setOutput('reason', failures.join('\n') || 'No stale entries could be processed successfully.');
    setOutput('processed_count', '0');
    setOutput('updated_count', '0');
    setOutput('missing_repo_issues', '');
    return;
  }

  if (!dryRun) {
    writeIndex(indexEntries);
    writePromotedIndex(indexEntries, config.promotedMinUpvotes);
    if (metadataChanged) {
      writeMetadata(metadata);
    }
  }

  const commitMessage = checkedCount > 0
    ? updatedCount > 0
      ? `Refresh ${checkedCount} plugin entries (${updatedCount} updated)`
      : `Refresh ${checkedCount} plugin entries`
    : 'Record scheduled plugin status changes';

  setOutput('result', 'ready');
  setOutput('reason', failures.length > 0 ? failures.join('\n') : 'Stale entries processed successfully.');
  setOutput('processed_count', String(checkedCount));
  setOutput('updated_count', String(updatedCount));
  setOutput('checked_sources', checkedSources.join('\n'));
  setOutput('updated_sources', updatedSources.join('\n'));
  setOutput('missing_repo_issues', missingRepoIssues.map((entry) => `${entry.source}|${entry.streak}`).join('\n'));
  setOutput('commit_message', commitMessage);
}

main().catch((error) => {
  setOutput('result', 'no-op');
  setOutput('reason', error.message);
  setOutput('processed_count', '0');
  setOutput('updated_count', '0');
  console.error(error);
  process.exitCode = 0;
});
