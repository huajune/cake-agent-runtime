#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const CHANGELOG_PATH = path.join(ROOT_DIR, 'CHANGELOG.md');

const version = process.argv[2] || '';
if (!version) {
  console.error('用法: node scripts/get-release-notes.js <version>');
  process.exit(1);
}

const normalizedVersion = version.replace(/^v/, '');
const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
const pattern = new RegExp(
  `^## \\[${escapeRegExp(normalizedVersion)}\\][\\s\\S]*?(?=^## \\[|\\Z)`,
  'm',
);
const match = changelog.match(pattern);

if (!match) {
  console.error(`未找到版本 v${normalizedVersion} 的发布记录`);
  process.exit(1);
}

process.stdout.write(`${match[0].trim()}\n`);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
