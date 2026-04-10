import fs from 'node:fs';
import { normalize, readConfig, writeIndex, writePromotedIndex } from './index-utils.mjs';

const issueBody = process.env.ISSUE_BODY ?? '';
const githubOutput = process.env.GITHUB_OUTPUT;
const githubToken = process.env.GITHUB_TOKEN;
const mode = process.env.MODE ?? 'check';

function setOutput(name, value) {
  if (!githubOutput) {
    return;
  }

  fs.appendFileSync(githubOutput, `${name}<<__OUTPUT__\n${value}\n__OUTPUT__\n`);
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

function extractField(body, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`###\\s+${escapedHeading}\\s*\\r?\\n\\r?\\n([\\s\\S]*?)(?=\\r?\\n###\\s+|$)`, 'i');
  const match = body.match(pattern);
  return match?.[1]?.trim() ?? '';
}

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

function readIndex() {
  return JSON.parse(fs.readFileSync('./index.json', 'utf8'));
}

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
  const releases = await githubRequest(`/repos/${owner}/${repo}/releases?per_page=100`);
  const releaseContext = strategy.resolveReleaseContext(releases);

  if (!releaseContext) {
    setOutput('result', 'needs-human');
    setOutput('source', source);
    setOutput('reason', `No release in ${source} matched the ${checkStrategy} rules.`);
    return;
  }

  const currentEntry = found.entry;
  const hasChanges = currentEntry.version !== releaseContext.version || currentEntry.url !== releaseContext.assetUrl;

  if (!hasChanges) {
    setOutput('result', 'no-change');
    setOutput('source', source);
    setOutput('version', currentEntry.version ?? '');
    setOutput('reason', `No changes found for ${source}.`);
    return;
  }

  indexEntries[found.entryIndex] = {
    ...currentEntry,
    lastchecked: new Date().toISOString(),
    url: releaseContext.assetUrl,
    version: releaseContext.version
  };

  const config = readConfig();
  writeIndex(indexEntries);
  writePromotedIndex(indexEntries, config.promotedMinUpvotes);

  const sanitizedSource = source.replace(/[^a-zA-Z0-9._-]+/g, '-');
  setOutput('result', 'updated');
  setOutput('source', source);
  setOutput('version', releaseContext.version);
  setOutput('commit_message', `Update entry for ${sanitizedSource} to v${releaseContext.version}`);
}

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