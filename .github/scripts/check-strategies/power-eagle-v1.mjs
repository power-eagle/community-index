function extractVersionFromReleaseName(releaseName) {
  const versionMatch = /^v(.+)$/.exec(String(releaseName ?? '').trim());
  return versionMatch ? versionMatch[1] : null;
}

export function resolveReleaseContext(releases) {
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

    return {
      version,
      releaseName: expectedReleaseName,
      assetName: asset.name,
      assetUrl: asset.browser_download_url
    };
  }

  return null;
}