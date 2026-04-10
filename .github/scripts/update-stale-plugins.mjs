import fs from 'node:fs';
import { indexPath, normalize, readConfig, writeIndex, writePromotedIndex } from './index-utils.mjs';

const githubOutput = process.env.GITHUB_OUTPUT;
const githubToken = process.env.GITHUB_TOKEN;
const dryRun = String(process.env.DRY_RUN ?? '').toLowerCase() === 'true';

function setOutput(name, value) {
  if (!githubOutput) {
    return;
  }

  fs.appendFileSync(githubOutput, `${name}<<__OUTPUT__\n${value}\n__OUTPUT__\n`);
}

function parseTimestamp(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

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
    throw new Error(`GitHub API request failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

function selectCandidates(indexEntries, maxBatchSize, staleIntervalSeconds) {
  const cutoff = Date.now() - staleIntervalSeconds * 1000;

  return indexEntries
    .map((entry, entryIndex) => ({ entry, entryIndex }))
    .filter(({ entry }) => parseTimestamp(entry.lastchecked) < cutoff)
    .sort((left, right) => parseTimestamp(left.entry.lastchecked) - parseTimestamp(right.entry.lastchecked))
    .slice(0, maxBatchSize);
}

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
  const releases = await githubRequest(`/repos/${owner}/${repo}/releases?per_page=100`);
  const releaseContext = strategy.resolveReleaseContext(releases);

  if (!releaseContext) {
    return {
      status: 'failed',
      source,
      reason: `No release in ${source} matched the ${entry.checkstrategy} rules.`
    };
  }

  const checkedAt = new Date().toISOString();
  const updatedEntry = {
    ...entry,
    lastchecked: checkedAt,
    url: releaseContext.assetUrl,
    version: releaseContext.version
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

async function main() {
  const config = readConfig();
  const indexEntries = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
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
  const failures = [];
  const updatedSources = [];
  const checkedSources = [];

  for (const candidate of candidates) {
    try {
      const result = await processEntry(candidate.entry);
      if (result.status !== 'checked') {
        failures.push(`${result.source || '<unknown>'}: ${result.reason}`);
        continue;
      }

      indexEntries[candidate.entryIndex] = result.updatedEntry;
      checkedCount += 1;
      checkedSources.push(result.source);

      if (result.changed) {
        updatedCount += 1;
        updatedSources.push(`${result.source}@${result.version}`);
      }
    } catch (error) {
      failures.push(`${candidate.entry.source || '<unknown>'}: ${error.message}`);
    }
  }

  if (checkedCount === 0) {
    setOutput('result', 'no-op');
    setOutput('reason', failures.join('\n') || 'No stale entries could be processed successfully.');
    setOutput('processed_count', '0');
    setOutput('updated_count', '0');
    return;
  }

  if (!dryRun) {
    writeIndex(indexEntries);
    writePromotedIndex(indexEntries, config.promotedMinUpvotes);
  }

  const commitMessage = updatedCount > 0
    ? `Refresh ${checkedCount} plugin entries (${updatedCount} updated)`
    : `Refresh ${checkedCount} plugin entries`;

  setOutput('result', 'ready');
  setOutput('reason', failures.length > 0 ? failures.join('\n') : 'Stale entries processed successfully.');
  setOutput('processed_count', String(checkedCount));
  setOutput('updated_count', String(updatedCount));
  setOutput('checked_sources', checkedSources.join('\n'));
  setOutput('updated_sources', updatedSources.join('\n'));
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
