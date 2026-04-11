import { readRepositoryManifest } from '../repository-manifest.mjs';

/**
 * Extract the version portion from a release name.
 */
function extractVersionFromReleaseName(releaseName) {
  const versionMatch = /^v(.+)$/.exec(String(releaseName ?? '').trim());
  return versionMatch ? versionMatch[1] : null;
}

/**
 * Resolve a release and repository manifest UUID for the power-eagle-v1 strategy.
 */
export async function resolveReleaseContext(releases, context) {
  const manifest = await readRepositoryManifest(context.owner, context.repo, context.defaultBranch, context.githubToken);

  for (const release of releases) {
    const version = extractVersionFromReleaseName(release.name);
    if (!version) {
      continue;
    }

    const expectedReleaseName = `v${version}`;
    const expectedAssetName = `v${version}-release.eagleplugin`;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find((candidate) => candidate.name.endsWith(expectedAssetName));

    if (!asset) {
      continue;
    }

    if (String(release.name).trim() !== expectedReleaseName) {
      continue;
    }

    if (String(manifest.version).trim() !== version) {
      continue;
    }

    return {
      version,
      releaseName: expectedReleaseName,
      assetName: asset.name,
      assetUrl: asset.browser_download_url,
      uuid: String(manifest.id).trim()
    };
  }

  return null;
}