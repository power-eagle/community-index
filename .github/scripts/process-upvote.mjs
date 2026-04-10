import fs from 'node:fs';
import { normalize, readConfig, readIndex, readTrustedAuthors, writeIndex, writePromotedIndex } from './index-utils.mjs';

const issueBody = process.env.ISSUE_BODY ?? '';
const issueAuthor = process.env.ISSUE_AUTHOR ?? '';
const githubOutput = process.env.GITHUB_OUTPUT;

function setOutput(name, value) {
  if (!githubOutput) {
    return;
  }

  fs.appendFileSync(githubOutput, `${name}<<__OUTPUT__\n${value}\n__OUTPUT__\n`);
}

function extractField(body, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`###\\s+${escapedHeading}\\s*\\r?\\n\\r?\\n([\\s\\S]*?)(?=\\r?\\n###\\s+|$)`, 'i');
  const match = body.match(pattern);
  return match?.[1]?.trim() ?? '';
}

async function main() {
  const source = extractField(issueBody, 'Source');

  if (!source || !source.includes('/')) {
    setOutput('result', 'needs-human');
    setOutput('reason', 'Issue form is missing a valid source in owner/repository format.');
    return;
  }

  const trustedAuthors = new Set(readTrustedAuthors().map(normalize));
  if (!trustedAuthors.has(normalize(issueAuthor))) {
    setOutput('result', 'needs-human');
    setOutput('reason', `Issue author @${issueAuthor} is not present in index_trustedauthors.json.`);
    return;
  }

  const indexEntries = readIndex();
  const entryIndex = indexEntries.findIndex((entry) => normalize(entry.source) === normalize(source));

  if (entryIndex === -1) {
    setOutput('result', 'needs-human');
    setOutput('reason', `No matching source was found in index.json for ${source}.`);
    return;
  }

  const currentEntry = indexEntries[entryIndex];
  const nextUpvotes = Number(currentEntry.upvotes ?? 0) + 1;
  indexEntries[entryIndex] = {
    ...currentEntry,
    upvotes: nextUpvotes
  };

  const config = readConfig();
  writeIndex(indexEntries);
  const promotedEntries = writePromotedIndex(indexEntries, config.promotedMinUpvotes);
  const promoted = promotedEntries.some((entry) => normalize(entry.source) === normalize(source));

  setOutput('result', 'ready');
  setOutput('source', source);
  setOutput('upvotes', String(nextUpvotes));
  setOutput('promoted', promoted ? 'true' : 'false');
  setOutput('commit_message', `Upvote ${source} to ${nextUpvotes}`);
}

main().catch((error) => {
  setOutput('result', 'needs-human');
  setOutput('reason', error.message);
  console.error(error);
  process.exitCode = 0;
});