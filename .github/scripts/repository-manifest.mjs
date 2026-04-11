/**
 * Build GitHub API headers for repository manifest requests.
 */
function buildGitHubHeaders(githubToken) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'community-index-repository-manifest-reader'
  };

  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }

  return headers;
}

/**
 * Fetch and parse manifest.json from the target repository default branch.
 */
export async function readRepositoryManifest(owner, repo, defaultBranch, githubToken) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/manifest.json?ref=${encodeURIComponent(defaultBranch)}`, {
    headers: buildGitHubHeaders(githubToken)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to read repository manifest.json (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  const encodedContent = String(payload.content ?? '').replace(/\s+/g, '');
  const manifest = JSON.parse(Buffer.from(encodedContent, 'base64').toString('utf8'));

  if (!manifest || typeof manifest.id !== 'string' || typeof manifest.version !== 'string') {
    throw new Error('Repository manifest.json must include string id and version fields.');
  }

  return manifest;
}