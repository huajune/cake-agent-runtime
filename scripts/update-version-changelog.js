#!/usr/bin/env node

/**
 * 自动维护版本号与 CHANGELOG。
 *
 * 模式：
 * - prepare: 在 PR 合并到 develop 后，累计生成中文“待发布”记录
 * - finalize: 在 release PR 合并到 master 后，固化为正式版本记录
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG = {
  packageJsonPath: path.join(ROOT_DIR, 'package.json'),
  changelogPath: path.join(ROOT_DIR, 'CHANGELOG.md'),
  pendingStatePath: path.join(ROOT_DIR, '.release', 'pending-release.json'),
  commitLimit: 100,
};

const CHANGELOG_HEADER = [
  '# Changelog',
  '',
  '所有重要的项目更改都将记录在此文件中。',
  '',
  '本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/) 规范。',
  '版本号由 GitHub Actions 自动维护，发布说明统一使用中文记录。',
  '',
  '---',
].join('\n');

const PENDING_START = '<!-- release:pending:start -->';
const PENDING_END = '<!-- release:pending:end -->';

const SECTION_ALIASES = new Map([
  ['更新摘要', 'summary'],
  ['本次更新摘要', 'summary'],
  ['发布摘要', 'summary'],
  ['新功能', 'features'],
  ['问题修复', 'fixes'],
  ['优化调整', 'optimizations'],
  ['运维与流程', 'ops'],
  ['配置变更', 'config'],
  ['验证记录', 'verification'],
  ['验证情况', 'verification'],
  ['影响说明', 'verification'],
]);

const MODE = process.argv[2] || 'prepare';
if (!['prepare', 'finalize'].includes(MODE)) {
  console.error('用法: node scripts/update-version-changelog.js <prepare|finalize>');
  process.exit(1);
}

main();

function main() {
  const latestRelease = getLatestReleaseTag();
  const packageJson = readJson(CONFIG.packageJsonPath);
  const currentVersion = packageJson.version;
  const releaseBaseVersion = latestRelease?.version || currentVersion;
  const existingChangelog = readText(CONFIG.changelogPath);

  let historicalSections = extractHistoricalSections(existingChangelog);
  let pendingState = loadPendingState(releaseBaseVersion, currentVersion);

  ({ pendingState, historicalSections } = syncReleasedStateIfNeeded({
    pendingState,
    latestRelease,
    historicalSections,
  }));

  if (MODE === 'prepare') {
    runPrepare({
      packageJson,
      releaseBaseVersion,
      latestRelease,
      pendingState,
      historicalSections,
    });
    return;
  }

  runFinalize({
    packageJson,
    pendingState,
    historicalSections,
  });
}

function runPrepare({
  packageJson,
  releaseBaseVersion,
  latestRelease,
  pendingState,
  historicalSections,
}) {
  const commits = getCommitsSince(latestRelease?.tag || null);
  const releaseLevel = analyzeReleaseLevel(commits);
  const computedVersion = releaseLevel
    ? bumpVersion(releaseBaseVersion, releaseLevel)
    : packageJson.version;

  const entry = parsePullRequestEntry();
  pendingState.baseVersion = releaseBaseVersion;
  pendingState.nextVersion = computedVersion;
  pendingState.updatedAt = formatShanghaiDate();

  if (entry) {
    upsertPendingEntry(pendingState, entry);
  }

  if (packageJson.version !== pendingState.nextVersion) {
    packageJson.version = pendingState.nextVersion;
    writeJson(CONFIG.packageJsonPath, packageJson);
    console.log(`✅ 已更新 package.json 版本号: ${pendingState.nextVersion}`);
  } else {
    writeJson(CONFIG.packageJsonPath, packageJson);
  }

  savePendingState(pendingState);

  const changelog = buildFullChangelog({
    pendingState,
    historicalSections,
    includePending: pendingState.entries.length > 0,
  });
  writeText(CONFIG.changelogPath, changelog);
  console.log(`✅ 已更新 CHANGELOG.md（待发布版本: v${pendingState.nextVersion}）`);
}

function runFinalize({ packageJson, pendingState, historicalSections }) {
  if (pendingState.entries.length === 0) {
    console.log('ℹ️ 当前没有待发布内容，跳过正式发布记录生成');
    return;
  }

  const version = packageJson.version || pendingState.nextVersion;
  const releaseDate = formatShanghaiDate();
  const releaseSection = renderReleaseSection({
    version,
    date: releaseDate,
    entries: pendingState.entries,
  });

  historicalSections = upsertReleaseSection(historicalSections, releaseSection, version);
  pendingState = createEmptyPendingState(version);

  packageJson.version = version;
  writeJson(CONFIG.packageJsonPath, packageJson);
  savePendingState(pendingState);

  const changelog = buildFullChangelog({
    pendingState,
    historicalSections,
    includePending: false,
  });
  writeText(CONFIG.changelogPath, changelog);

  console.log(`✅ 已固化正式版本记录: v${version}`);
}

function syncReleasedStateIfNeeded({ pendingState, latestRelease, historicalSections }) {
  if (!latestRelease) {
    return { pendingState, historicalSections };
  }

  if (pendingState.entries.length === 0) {
    if (pendingState.baseVersion !== latestRelease.version) {
      return {
        pendingState: createEmptyPendingState(latestRelease.version),
        historicalSections,
      };
    }
    return { pendingState, historicalSections };
  }

  // develop 分支在 master 已发布后，下次运行时自动把旧的待发布内容转成历史版本记录。
  if (pendingState.nextVersion === latestRelease.version) {
    const releaseSection = renderReleaseSection({
      version: latestRelease.version,
      date: latestRelease.date,
      entries: pendingState.entries,
    });
    historicalSections = upsertReleaseSection(
      historicalSections,
      releaseSection,
      latestRelease.version,
    );
    pendingState = createEmptyPendingState(latestRelease.version);
  }

  return { pendingState, historicalSections };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, data) {
  ensureParentDirectory(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function readText(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

function writeText(filePath, content) {
  ensureParentDirectory(filePath);
  fs.writeFileSync(filePath, content);
}

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function execGit(command) {
  try {
    return execSync(command, {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    return '';
  }
}

function getLatestReleaseTag() {
  const tags = execGit('git tag --list "v*" --sort=-version:refname');
  if (!tags) return null;

  const tag = tags
    .split('\n')
    .map((item) => item.trim())
    .find((item) => /^v\d+\.\d+\.\d+$/.test(item));

  if (!tag) return null;

  return {
    tag,
    version: tag.replace(/^v/, ''),
    date: execGit(`git log -1 --format=%cs ${tag}`) || formatShanghaiDate(),
  };
}

function getCommitsSince(lastTag) {
  const format = '%H%x1f%s%x1f%b%x1e';
  const command = lastTag
    ? `git log ${lastTag}..HEAD --format="${format}"`
    : `git log -${CONFIG.commitLimit} --format="${format}"`;
  const output = execGit(command);
  if (!output) return [];

  return output
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = '', subject = '', body = ''] = record.split('\x1f');
      return {
        hash: hash.trim(),
        subject: subject.trim(),
        body: body.trim(),
      };
    });
}

function analyzeReleaseLevel(commits) {
  let level = null;

  for (const commit of commits) {
    if (!commit.subject) continue;
    if (commit.subject.includes('[skip ci]')) continue;
    if (commit.subject.startsWith('Merge pull request')) continue;
    if (commit.subject.startsWith('chore(release):')) continue;

    const message = `${commit.subject}\n${commit.body}`;

    if (/BREAKING[- ]CHANGE:/i.test(message) || /^\w+(?:\(.+?\))?!:/.test(commit.subject)) {
      return 'major';
    }

    if (/^feat(?:\(.+?\))?:/i.test(commit.subject)) {
      level = level === 'major' ? level : 'minor';
      continue;
    }

    if (!level) {
      level = 'patch';
    }
  }

  return level;
}

function bumpVersion(baseVersion, level) {
  const [major, minor, patch] = baseVersion.split('.').map(Number);

  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function createEmptyPendingState(baseVersion) {
  return {
    baseVersion,
    nextVersion: baseVersion,
    updatedAt: formatShanghaiDate(),
    sourceBranch: 'develop',
    entries: [],
  };
}

function loadPendingState(baseVersion, currentVersion) {
  if (!fs.existsSync(CONFIG.pendingStatePath)) {
    return createEmptyPendingState(baseVersion);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG.pendingStatePath, 'utf-8'));
    return {
      baseVersion: parsed.baseVersion || baseVersion,
      nextVersion: parsed.nextVersion || currentVersion || baseVersion,
      updatedAt: parsed.updatedAt || formatShanghaiDate(),
      sourceBranch: parsed.sourceBranch || 'develop',
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch (error) {
    return createEmptyPendingState(baseVersion);
  }
}

function savePendingState(state) {
  writeJson(CONFIG.pendingStatePath, state);
}

function parsePullRequestEntry() {
  const rawTitle = (process.env.MERGED_PR_TITLE || '').trim();
  const rawBody = (process.env.MERGED_PR_BODY || '').trim();
  const rawNumber = (process.env.MERGED_PR_NUMBER || '').trim();
  const rawUrl = (process.env.MERGED_PR_URL || '').trim();
  const rawAuthor = (process.env.MERGED_PR_AUTHOR || '').trim();
  const rawMergedAt = (process.env.MERGED_PR_MERGED_AT || '').trim();

  if (!rawTitle && !rawBody && !rawNumber) {
    return null;
  }

  const title = normalizeTitle(rawTitle || `更新 ${rawNumber}` || '未命名更新');
  const sections = parseBodySections(rawBody);
  if (sections.summary.length === 0) {
    sections.summary.push(title);
  }

  if (
    sections.features.length === 0 &&
    sections.fixes.length === 0 &&
    sections.optimizations.length === 0 &&
    sections.ops.length === 0
  ) {
    const inferredKey = inferPrimaryCategory(rawTitle || title);
    sections[inferredKey].push(title);
  }

  return {
    number: rawNumber || '',
    url: rawUrl,
    title,
    author: rawAuthor,
    mergedAt: rawMergedAt ? rawMergedAt.slice(0, 10) : formatShanghaiDate(),
    summary: uniqueList(sections.summary),
    features: uniqueList(sections.features),
    fixes: uniqueList(sections.fixes),
    optimizations: uniqueList(sections.optimizations),
    ops: uniqueList(sections.ops),
    config: uniqueList(sections.config),
    verification: uniqueList(sections.verification),
  };
}

function normalizeTitle(title) {
  const trimmed = title.trim();
  const match = trimmed.match(/^\w+(?:\(.+?\))?!?:\s*(.+)$/);
  return (match ? match[1] : trimmed).trim();
}

function inferPrimaryCategory(title) {
  const lower = title.toLowerCase();
  if (/^feat(?:\(.+?\))?!?:/.test(lower) || /新增|添加|支持|接入/.test(title)) {
    return 'features';
  }
  if (/^fix(?:\(.+?\))?!?:/.test(lower) || /修复|修正|解决/.test(title)) {
    return 'fixes';
  }
  if (
    /^refactor(?:\(.+?\))?!?:/.test(lower) ||
    /^perf(?:\(.+?\))?!?:/.test(lower) ||
    /优化|重构|提速/.test(title)
  ) {
    return 'optimizations';
  }
  return 'ops';
}

function parseBodySections(body) {
  const sections = {
    summary: [],
    features: [],
    fixes: [],
    optimizations: [],
    ops: [],
    config: [],
    verification: [],
  };

  if (!body) return sections;

  let currentKey = null;
  for (const rawLine of body.split('\n')) {
    const headingMatch = rawLine.match(/^#{2,6}\s*(.+?)\s*$/);
    if (headingMatch) {
      const normalizedHeading = headingMatch[1].replace(/\s+/g, '');
      currentKey = SECTION_ALIASES.get(normalizedHeading) || null;
      continue;
    }

    if (!currentKey) continue;

    const normalizedLine = normalizeBodyLine(rawLine);
    if (!normalizedLine) continue;
    sections[currentKey].push(normalizedLine);
  }

  return sections;
}

function normalizeBodyLine(line) {
  let text = line.trim();
  if (!text) return '';
  if (text.startsWith('<!--')) return '';

  text = text.replace(/^[-*+]\s+\[[ xX]\]\s+/, '');
  text = text.replace(/^\d+\.\s+/, '');
  text = text.replace(/^[-*+]\s+/, '');
  text = text.trim();

  if (!text) return '';

  const lower = text.toLowerCase();
  if (['无', '暂无', 'none', 'n/a', '待补充'].includes(lower)) {
    return '';
  }

  return text;
}

function uniqueList(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function upsertPendingEntry(state, entry) {
  const index = state.entries.findIndex((item) => item.number && item.number === entry.number);
  if (index >= 0) {
    state.entries[index] = entry;
  } else {
    state.entries.push(entry);
  }
}

function renderPendingSection(state) {
  const lines = [
    PENDING_START,
    '## 待发布',
    '',
    `**预计版本**: \`v${state.nextVersion}\``,
    `**最近更新**: \`${state.updatedAt}\``,
    `**来源分支**: \`${state.sourceBranch || 'develop'}\``,
    `**累计 PR**: ${state.entries.length}`,
    '',
    '### 更新摘要',
    ...renderSummaryLines(state.entries),
    '',
    '### 新功能',
    ...renderCategoryLines(state.entries, 'features'),
    '',
    '### 问题修复',
    ...renderCategoryLines(state.entries, 'fixes'),
    '',
    '### 优化调整',
    ...renderCategoryLines(state.entries, 'optimizations'),
    '',
    '### 运维与流程',
    ...renderCategoryLines(state.entries, 'ops'),
    '',
    '### 配置变更',
    ...renderCategoryLines(state.entries, 'config'),
    '',
    '### 验证记录',
    ...renderCategoryLines(state.entries, 'verification'),
    PENDING_END,
  ];

  return lines.join('\n');
}

function renderReleaseSection({ version, date, entries }) {
  const lines = [
    `## [${version}] - ${date}`,
    '',
    '**来源分支**: `develop`',
    '',
    '### 更新摘要',
    ...renderSummaryLines(entries),
    '',
    '### 新功能',
    ...renderCategoryLines(entries, 'features'),
    '',
    '### 问题修复',
    ...renderCategoryLines(entries, 'fixes'),
    '',
    '### 优化调整',
    ...renderCategoryLines(entries, 'optimizations'),
    '',
    '### 运维与流程',
    ...renderCategoryLines(entries, 'ops'),
    '',
    '### 配置变更',
    ...renderCategoryLines(entries, 'config'),
    '',
    '### 验证记录',
    ...renderCategoryLines(entries, 'verification'),
  ];

  return lines.join('\n');
}

function renderSummaryLines(entries) {
  const lines = entries.map((entry) => `- ${formatEntryReference(entry)} ${entry.title}`);
  return lines.length > 0 ? lines : ['- 暂无'];
}

function renderCategoryLines(entries, key) {
  const lines = [];
  for (const entry of entries) {
    for (const item of entry[key] || []) {
      lines.push(`- ${formatEntryReference(entry)} ${item}`);
    }
  }
  return lines.length > 0 ? lines : ['- 无'];
}

function formatEntryReference(entry) {
  if (entry.number && entry.url) return `[PR #${entry.number}](${entry.url})`;
  if (entry.number) return `PR #${entry.number}`;
  return 'PR';
}

function buildFullChangelog({ pendingState, historicalSections, includePending }) {
  const parts = [CHANGELOG_HEADER];
  if (includePending) {
    parts.push(renderPendingSection(pendingState));
  }
  if (historicalSections) {
    parts.push(historicalSections.trim());
  }
  return `${parts.filter(Boolean).join('\n\n').trim()}\n`;
}

function extractHistoricalSections(existingChangelog) {
  const withoutPending = removePendingBlock(existingChangelog);
  const match = withoutPending.match(/^## \[/m);
  if (!match) return '';
  return withoutPending.slice(match.index).trim();
}

function removePendingBlock(content) {
  if (!content) return '';
  const pattern = new RegExp(
    `${escapeRegExp(PENDING_START)}[\\s\\S]*?${escapeRegExp(PENDING_END)}\\s*`,
    'm',
  );
  return content.replace(pattern, '').trim();
}

function upsertReleaseSection(historicalSections, newSection, version) {
  const sanitized = removeReleaseSection(historicalSections, version);
  if (!sanitized) return newSection.trim();
  return `${newSection.trim()}\n\n${sanitized.trim()}`.trim();
}

function removeReleaseSection(content, version) {
  if (!content) return '';
  const pattern = new RegExp(`^## \\[${escapeRegExp(version)}\\][\\s\\S]*?(?=^## \\[|\\Z)`, 'm');
  return content.replace(pattern, '').trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatShanghaiDate(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  return formatter.format(date);
}
