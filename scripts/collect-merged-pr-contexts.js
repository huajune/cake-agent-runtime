#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT_DIR, '.release');

if (require.main === module) {
  main();
}

function main() {
  const prNumbers = normalizePrNumbers(process.argv.slice(2));
  if (prNumbers.length === 0) {
    throw new Error('Usage: node scripts/collect-merged-pr-contexts.js <pr-number...>');
  }

  fs.mkdirSync(RELEASE_DIR, { recursive: true });

  const contexts = [];
  const skipped = [];
  for (const prNumber of prNumbers) {
    try {
      const context = fetchMergedPrContext(prNumber);
      if (context) {
        contexts.push(context);
      } else {
        skipped.push(`#${prNumber}`);
      }
    } catch (error) {
      skipped.push(`#${prNumber}: ${error.message}`);
      console.warn(`Skipping PR #${prNumber}: ${error.message}`);
    }
  }
  if (contexts.length === 0) {
    throw new Error('No eligible merged develop PRs were found');
  }
  for (const context of contexts) {
    fs.writeFileSync(
      path.join(RELEASE_DIR, `merged-pr-context-${context.pullRequest.number}.json`),
      `${JSON.stringify(context, null, 2)}\n`,
    );
  }

  fs.writeFileSync(
    path.join(RELEASE_DIR, 'merged-pr-contexts.json'),
    `${JSON.stringify(contexts, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(RELEASE_DIR, 'merged-pr-numbers.txt'),
    `${contexts.map((context) => context.pullRequest.number).join('\n')}\n`,
  );

  if (contexts.length === 1) {
    fs.writeFileSync(
      path.join(RELEASE_DIR, 'merged-pr-context.json'),
      `${JSON.stringify(contexts[0], null, 2)}\n`,
    );
  }

  console.log(
    `Collected ${contexts.length} merged PR context(s): ${contexts
      .map((context) => context.pullRequest.number)
      .join(', ')}`,
  );
  if (skipped.length > 0) {
    console.warn(`Skipped ${skipped.length} PR(s): ${skipped.join('; ')}`);
  }
}

function normalizePrNumbers(values) {
  return Array.from(
    new Set(
      values
        .flatMap((value) => String(value || '').split(/[,\s]+/))
        .map((value) => value.trim().replace(/^#/, ''))
        .filter((value) => /^\d+$/.test(value)),
    ),
  );
}

function fetchMergedPrContext(prNumber) {
  const raw = execFileSync(
    'gh',
    [
      'pr',
      'view',
      prNumber,
      '--json',
      'number,title,body,url,author,mergedAt,baseRefName,headRefName,state,files,commits',
    ],
    {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const pullRequest = JSON.parse(raw);

  if (pullRequest.state !== 'MERGED' && !pullRequest.mergedAt) {
    console.warn(`Skipping PR #${prNumber}: not merged`);
    return null;
  }
  if (pullRequest.baseRefName !== 'develop') {
    console.warn(`Skipping PR #${prNumber}: base is ${pullRequest.baseRefName}, expected develop`);
    return null;
  }
  if (isReleaseMetadataPr(pullRequest)) {
    console.warn(`Skipping PR #${prNumber}: release metadata PR`);
    return null;
  }

  return {
    pullRequest: {
      number: String(pullRequest.number || prNumber),
      title: pullRequest.title || '',
      url: pullRequest.url || '',
      author: pullRequest.author?.login || '',
      mergedAt: pullRequest.mergedAt || '',
    },
    body: pullRequest.body || '',
    files: normalizeFiles(pullRequest.files),
    commits: normalizeCommits(pullRequest.commits),
  };
}

function isReleaseMetadataPr(pullRequest) {
  return (
    String(pullRequest.headRefName || '').startsWith('chore/release-metadata/') ||
    String(pullRequest.title || '').startsWith('chore(release): 更新待发布版本信息') ||
    String(pullRequest.body || '').includes('<!-- release-metadata-pr -->')
  );
}

function normalizeFiles(files) {
  return Array.isArray(files)
    ? files.map((file) => file?.path).filter((filePath) => typeof filePath === 'string')
    : [];
}

function normalizeCommits(commits) {
  return Array.isArray(commits)
    ? commits
        .map((commit) => ({
          subject: commit?.messageHeadline || '',
          body: commit?.messageBody || '',
        }))
        .filter((commit) => commit.subject)
    : [];
}

module.exports = {
  normalizePrNumbers,
};
