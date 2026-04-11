import fs from 'node:fs';
import { normalize, readConfig, writeIndex, writePromotedIndex } from './index-utils.mjs';

const issueBody = process.env.ISSUE_BODY ?? '';
const githubOutput = process.env.GITHUB_OUTPUT;
const githubToken = process.env.GITHUB_TOKEN;
const mode = process.env.MODE ?? 'check';

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
 * Extract a field from an issue-form markdown body.
 */
function extractField(body, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`###\\s+${escapedHeading}\\s*\\r?\\n\\r?\\n([\\s\\S]*?)(?=\\r?\\n###\\s+|$)`, 'i');
  const match = body.match(pattern);
  return match?.[1]?.trim() ?? '';
}

/**
 * Query the GitHub API with the workflow token when available.
 */
async function githubRequest(apiPath) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'community-index-mismatched-version-workflow'
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

/**
 * Read the current index entries from disk.
 */
function readIndex() {
  return JSON.parse(fs.readFileSync('./index.json', 'utf8'));
}

/**
 * Find one index entry by its source string.
 */
function findEntry(source, indexEntries) {
  const entryIndex = indexEntries.findIndex((entry) => normalize(entry.source) === normalize(source));
  if (entryIndex === -1) {
    return null;
  }

  return {
    entryIndex,
    entry: indexEntries[entryIndex]
  };
}

/**
 * Identify the source referenced by a mismatched-version issue.
 */
async function identify() {
  const source = extractField(issueBody, 'Source');

  if (!source || !source.includes('/')) {
    setOutput('result', 'invalid-source');
    setOutput('reason', 'Issue form is missing a valid source in owner/repository format.');
    return;
  }

  const indexEntries = readIndex();
  const found = findEntry(source, indexEntries);

  if (!found) {
    setOutput('result', 'source-missing');
    setOutput('source', source);
    setOutput('reason', `No matching source was found in index.json for ${source}.`);
    return;
  }

  setOutput('result', 'identified');
  setOutput('source', source);
  setOutput('checkstrategy', found.entry.checkstrategy);
  setOutput('current_version', found.entry.version ?? '');
}

/**
 * Refresh one source and stop automation on manifest UUID drift.
 */
async function check() {
  const source = extractField(issueBody, 'Source');

  if (!source || !source.includes('/')) {
    setOutput('result', 'invalid-source');
    setOutput('reason', 'Issue form is missing a valid source in owner/repository format.');
    return;
  }

  const indexEntries = readIndex();
  const found = findEntry(source, indexEntries);

  if (!found) {
    setOutput('result', 'source-missing');
    setOutput('source', source);
    setOutput('reason', `No matching source was found in index.json for ${source}.`);
    return;
  }

  const checkStrategy = found.entry.checkstrategy;
  const strategy = await loadCheckStrategy(checkStrategy);

  if (!strategy) {
    setOutput('result', 'needs-human');
    setOutput('source', source);
    setOutput('reason', `Unsupported check strategy on existing entry: ${checkStrategy || 'missing value'}.`);
    return;
  }

  const [owner, repo] = source.split('/');
  const repoMetadata = await githubRequest(`/repos/${owner}/${repo}`);
  const releases = await githubRequest(`/repos/${owner}/${repo}/releases?per_page=100`);
  const releaseContext = await strategy.resolveReleaseContext(releases, {
    owner,
    repo,
    defaultBranch: repoMetadata.default_branch,
    githubToken
  });

  if (!releaseContext) {
    setOutput('result', 'needs-human');
    setOutput('source', source);
    setOutput('reason', `No release in ${source} matched the ${checkStrategy} rules.`);
    return;
  }

  const currentEntry = found.entry;
  if (currentEntry.uuid && normalize(currentEntry.uuid) !== normalize(releaseContext.uuid)) {
    setOutput('result', 'needs-human');
    setOutput('source', source);
    setOutput('reason', `UUID mismatch detected for ${source}. Stored UUID ${currentEntry.uuid} does not match repository manifest UUID ${releaseContext.uuid}.`);
    return;
  }

  indexEntries[found.entryIndex] = {
    ...currentEntry,
    lastchecked: new Date().toISOString(),
    url: releaseContext.assetUrl,
    version: releaseContext.version,
    uuid: releaseContext.uuid
  };

  const hasChanges = currentEntry.version !== releaseContext.version || currentEntry.url !== releaseContext.assetUrl;

  const config = readConfig();
  writeIndex(indexEntries);
  writePromotedIndex(indexEntries, config.promotedMinUpvotes);

  if (!hasChanges) {
    setOutput('result', 'no-change');
    setOutput('source', source);
    setOutput('version', currentEntry.version ?? '');
    setOutput('commit_message', `Refresh lastchecked for ${source.replace(/[^a-zA-Z0-9._-]+/g, '-')}`);
    setOutput('reason', `No changes found for ${source}.`);
    return;
  }

  const sanitizedSource = source.replace(/[^a-zA-Z0-9._-]+/g, '-');
  setOutput('result', 'updated');
  setOutput('source', source);
  setOutput('version', releaseContext.version);
  setOutput('commit_message', `Update entry for ${sanitizedSource} to v${releaseContext.version}`);
}

/**
 * Dispatch identify or check mode for the mismatched-version processor.
 */
async function main() {
  if (mode === 'identify') {
    await identify();
    return;
  }

  await check();
}

main().catch((error) => {
  setOutput('result', 'needs-human');
  setOutput('reason', error.message);
  console.error(error);
  process.exitCode = 0;
});