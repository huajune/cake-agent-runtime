#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildReleasePrContent } = require('./build-release-pr-body');

if (require.main === module) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = args.base || 'master';
  const head = args.head || 'develop';
  const content = buildReleasePrContent({ base, head });

  if (args.dryRun) {
    process.stdout.write(`${content.title}\n\n${content.body}\n`);
    return;
  }

  ensureGhAvailable();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cake-release-pr-'));
  const bodyFile = path.join(tempDir, 'body.md');
  fs.writeFileSync(bodyFile, `${content.body}\n`);

  try {
    const existing = findOpenReleasePr({ base, head });
    if (existing) {
      runGh([
        'pr',
        'edit',
        String(existing.number),
        '--title',
        content.title,
        '--body-file',
        bodyFile,
      ]);
      process.stdout.write(`Updated release PR: ${existing.url}\n`);
      return;
    }

    const url = runGh([
      'pr',
      'create',
      '--base',
      base,
      '--head',
      head,
      '--title',
      content.title,
      '--body-file',
      bodyFile,
    ]).trim();
    process.stdout.write(`${url}\n`);
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

function findOpenReleasePr({ base, head }) {
  const raw = runGh([
    'pr',
    'list',
    '--base',
    base,
    '--head',
    head,
    '--state',
    'open',
    '--json',
    'number,url',
    '--limit',
    '1',
  ]);

  const prs = JSON.parse(raw);
  return prs[0] || null;
}

function ensureGhAvailable() {
  try {
    runGh(['--version']);
  } catch (error) {
    throw new Error(
      'GitHub CLI 未安装或未登录，无法创建 release PR。请先安装并执行 gh auth login。',
    );
  }
}

function runGh(args) {
  return execFileSync('gh', args, {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--base':
        args.base = argv[++index];
        break;
      case '--head':
        args.head = argv[++index];
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

module.exports = {
  findOpenReleasePr,
};
