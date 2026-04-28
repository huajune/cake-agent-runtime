#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { formatReleaseText, isEmptyReleaseLine } = require('./release-note-formatters');

const ROOT_DIR = path.resolve(__dirname, '..');
const CHANGELOG_PATH = path.join(ROOT_DIR, 'CHANGELOG.md');
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');
const PENDING_START = '<!-- release:pending:start -->';
const PENDING_END = '<!-- release:pending:end -->';

if (require.main === module) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const content = buildReleasePrContent({
    base: args.base || 'master',
    head: args.head || 'develop',
  });

  if (args.titleFile) {
    fs.writeFileSync(args.titleFile, `${content.title}\n`);
  }

  if (args.bodyFile) {
    fs.writeFileSync(args.bodyFile, `${content.body}\n`);
  }

  if (args.stdout || (!args.titleFile && !args.bodyFile)) {
    process.stdout.write(`${content.title}\n\n${content.body}\n`);
  }
}

function buildReleasePrContent({ base, head }) {
  const changelog = readText(CHANGELOG_PATH);
  const pending = extractPendingSection(changelog);
  const fallbackVersion = readPackageVersion();
  const version = extractExpectedVersion(pending) || `v${fallbackVersion}`;
  const updateSummary = extractBulletSection(pending, '更新摘要');
  const envReminder = extractBulletSection(pending, '环境变量提醒');
  const verification = extractBulletSection(pending, '验证记录', { preserveCode: true });

  return {
    title: `chore(release): 发布 ${version}`,
    body: [
      '<!-- release-pr-autofill -->',
      '## 发版说明',
      '',
      `- 发布版本：\`${version}\``,
      `- 合并方向：\`${head}\` → \`${base}\``,
      '- 合并后动作：固化正式版本记录、创建 Git Tag / GitHub Release，并触发部署工作流',
      '',
      '## 更新摘要',
      ...renderLines(updateSummary, '- 暂无待发布摘要'),
      '',
      '## 发布前确认',
      '- [ ] GitHub CI 已通过',
      '- [ ] 生产数据库 migration 已确认（如本次包含 Supabase migration）',
      '- [ ] 生产环境变量已同步（如有环境变量提醒）',
      '',
      '## 环境变量提醒',
      ...renderLines(envReminder, '- 无'),
      '',
      '## 验证记录',
      ...renderLines(verification, '- 暂无'),
    ].join('\n'),
  };
}

function extractPendingSection(changelog) {
  const start = changelog.indexOf(PENDING_START);
  const end = changelog.indexOf(PENDING_END);
  if (start === -1 || end === -1 || end <= start) {
    return '';
  }

  return changelog.slice(start + PENDING_START.length, end).trim();
}

function extractExpectedVersion(markdown) {
  const match = markdown.match(/\*\*预计版本\*\*:\s*`?(v?\d+\.\d+\.\d+)`?/);
  if (!match) {
    return '';
  }

  return match[1].startsWith('v') ? match[1] : `v${match[1]}`;
}

function extractBulletSection(markdown, headingText, options = {}) {
  const section = extractMarkdownSection(markdown, headingText);
  if (!section) {
    return [];
  }

  return uniqueList(
    section
      .split('\n')
      .map((line) => normalizeBullet(line, options))
      .filter(Boolean),
  );
}

function extractMarkdownSection(markdown, headingText) {
  const escapedHeading = escapeRegExp(headingText);
  const heading = new RegExp(`^### ${escapedHeading}\\s*\\n`, 'm').exec(markdown);
  if (!heading) {
    return '';
  }

  const rest = markdown.slice(heading.index + heading[0].length);
  const nextHeadingIndex = rest.search(/^### /m);
  return (nextHeadingIndex === -1 ? rest : rest.slice(0, nextHeadingIndex)).trim();
}

function normalizeBullet(line, options = {}) {
  const match = line.trim().match(/^(?:[-*+]\s+|\d+\.\s+)(.+)$/);
  if (!match) {
    return '';
  }

  const raw = match[1].trim();
  if (isEmptyReleaseLine(raw)) {
    return '';
  }

  if (options.preserveCode) {
    return stripPrReference(raw);
  }

  return formatReleaseText(raw, { includePrReference: false });
}

function renderLines(lines, fallback) {
  return lines.length > 0 ? lines.map((line) => `- ${line}`) : [fallback];
}

function stripPrReference(value) {
  return value.replace(/^PR\s+#\d+\s*/i, '').trim();
}

function readText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function uniqueList(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--title-file':
        args.titleFile = argv[++index];
        break;
      case '--body-file':
        args.bodyFile = argv[++index];
        break;
      case '--base':
        args.base = argv[++index];
        break;
      case '--head':
        args.head = argv[++index];
        break;
      case '--stdout':
        args.stdout = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

module.exports = {
  buildReleasePrContent,
};
