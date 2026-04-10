import fs from 'node:fs';
import path from 'node:path';

const workspace = process.cwd();

export const configPath = path.join(workspace, 'config.json');
export const indexPath = path.join(workspace, 'index.json');
export const promotedIndexPath = path.join(workspace, 'index_promoted.json');
export const trustedAuthorsPath = path.join(workspace, 'index_trustedauthors.json');

export function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function readConfig() {
  const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const batchingCount = Number.parseInt(String(rawConfig.batching_count ?? ''), 10);
  const staleIntervalSeconds = Number.parseInt(String(rawConfig.stale_interval ?? ''), 10);
  const promotedMinUpvotes = Number.parseInt(String(rawConfig.promoted_min_upvotes ?? ''), 10);

  if (!Number.isFinite(batchingCount) || batchingCount <= 0) {
    throw new Error('config.json must define batching_count as a positive integer.');
  }

  if (!Number.isFinite(staleIntervalSeconds) || staleIntervalSeconds < 0) {
    throw new Error('config.json must define stale_interval as a non-negative integer number of seconds.');
  }

  if (!Number.isFinite(promotedMinUpvotes) || promotedMinUpvotes < 0) {
    throw new Error('config.json must define promoted_min_upvotes as a non-negative integer.');
  }

  return {
    batchingCount,
    staleIntervalSeconds,
    promotedMinUpvotes
  };
}

export function readIndex() {
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

export function writeIndex(entries) {
  fs.writeFileSync(indexPath, `${JSON.stringify(entries, null, 4)}\n`);
}

export function readTrustedAuthors() {
  return JSON.parse(fs.readFileSync(trustedAuthorsPath, 'utf8'));
}

export function buildPromotedIndex(indexEntries, promotedMinUpvotes) {
  return indexEntries.filter((entry) => Number(entry.upvotes ?? 0) >= promotedMinUpvotes);
}

export function writePromotedIndex(indexEntries, promotedMinUpvotes) {
  const promotedEntries = buildPromotedIndex(indexEntries, promotedMinUpvotes);
  fs.writeFileSync(promotedIndexPath, `${JSON.stringify(promotedEntries, null, 4)}\n`);
  return promotedEntries;
}