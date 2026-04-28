#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const CHANGELOG_PATH = path.join(ROOT_DIR, 'CHANGELOG.md');

if (require.main === module) {
  main();
}

function main() {
  const version = process.argv[2] || '';
  if (!version) {
    console.error('用法: node scripts/get-release-notes.js <version>');
    process.exit(1);
  }

  const normalizedVersion = version.replace(/^v/, '');
  const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
  const releaseNotes = extractReleaseNotes(changelog, normalizedVersion);

  if (!releaseNotes) {
    console.error(`未找到版本 v${normalizedVersion} 的发布记录`);
    process.exit(1);
  }

  process.stdout.write(`${releaseNotes}\n`);
}

function extractReleaseNotes(markdown, targetVersion) {
  const lines = markdown.split(/\r?\n/);
  const headingPattern = /^## \[([^\]]+)\]/;
  const startIndex = lines.findIndex((line) => {
    const match = line.match(headingPattern);
    return match?.[1] === targetVersion;
  });

  if (startIndex === -1) {
    return '';
  }

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (headingPattern.test(lines[index])) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n').trim();
}

module.exports = {
  extractReleaseNotes,
};
