import fs from 'node:fs';
import { normalize, readConfig, readTrustedAuthors, writeIndex, writePromotedIndex } from './index-utils.mjs';

const issueBody = process.env.ISSUE_BODY ?? '';
const issueAuthor = process.env.ISSUE_AUTHOR ?? '';
const issueNumber = process.env.ISSUE_NUMBER ?? '';
const githubOutput = process.env.GITHUB_OUTPUT;
const githubToken = process.env.GITHUB_TOKEN;

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
    'User-Agent': 'community-index-add-entry-workflow'
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

function markNeedsHuman(reason) {
  setOutput('result', 'needs-human');
  setOutput('reason', reason);
}

async function main() {
  const source = extractField(issueBody, 'Source');
  const checkStrategy = extractField(issueBody, 'Check strategy');
  const strategy = await loadCheckStrategy(checkStrategy);

  if (!source || !source.includes('/')) {
    markNeedsHuman('Issue form is missing a valid source in owner/repository format.');
    return;
  }

  if (!strategy) {
    markNeedsHuman(`Issue form has an unsupported check strategy: ${checkStrategy || 'missing value'}.`);
    return;
  }

  const trustedAuthors = readTrustedAuthors();
  const trustedSet = new Set(trustedAuthors.map(normalize));
  const sourceOwner = source.split('/')[0];
  const normalizedAuthor = normalize(issueAuthor);
  const isAuthorized = normalizedAuthor === normalize(sourceOwner) || trustedSet.has(normalizedAuthor);

  if (!isAuthorized) {
    markNeedsHuman(`Issue author @${issueAuthor} is not the source owner and is not present in index_trustedauthors.json.`);
    return;
  }

  const [owner, repo] = source.split('/');
  const repoMetadata = await githubRequest(`/repos/${owner}/${repo}`);
  const releases = await githubRequest(`/repos/${owner}/${repo}/releases?per_page=100`);

  const releaseContext = strategy.resolveReleaseContext(releases);

  if (!releaseContext) {
    markNeedsHuman(`No release in ${source} matched the ${checkStrategy} rules.`);
    return;
  }

  const existingIndex = JSON.parse(fs.readFileSync('./index.json', 'utf8'));
  const sourceExists = existingIndex.some((entry) => normalize(entry.source) === normalize(source));

  if (sourceExists) {
    markNeedsHuman(`Source ${source} already exists in index.json.`);
    return;
  }

  const entry = {
    source,
    description: repoMetadata.description ?? '',
    lastchecked: new Date().toISOString(),
    url: releaseContext.assetUrl,
    version: releaseContext.version,
    checkstrategy: checkStrategy,
    upvotes: 0
  };

  existingIndex.push(entry);
  const config = readConfig();
  writeIndex(existingIndex);
  writePromotedIndex(existingIndex, config.promotedMinUpvotes);

  const sanitizedSource = source.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const commitMessage = `Add entry for ${sanitizedSource}`;

  setOutput('result', 'ready');
  setOutput('reason', 'Entry excavated and index.json updated.');
  setOutput('commit_message', commitMessage);
}

main().catch((error) => {
  markNeedsHuman(error.message);
  console.error(error);
  process.exitCode = 0;
});
