#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');

function walkMarkdownFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkMarkdownFiles(target);
    return entry.isFile() && entry.name.endsWith('.md') ? [target] : [];
  });
}

function section(content, startHeading, endHeading) {
  const start = content.indexOf(startHeading);
  if (start < 0) return '';
  const end = endHeading ? content.indexOf(endHeading, start + startHeading.length) : -1;
  return content.slice(start, end < 0 ? undefined : end);
}

function validateReleaseLedger(rootDir = DEFAULT_ROOT) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const version = packageJson.version;
  const releasesDir = path.join(rootDir, 'docs', 'releases');
  const ledgers = walkMarkdownFiles(releasesDir).filter(
    (file) => !['_template.md', 'README.md'].includes(path.basename(file)),
  );
  const expectedName = `v${version}.md`;
  const versionLedgers = ledgers.filter((file) => path.basename(file) === expectedName);

  if (versionLedgers.length !== 1) {
    const pending = ledgers
      .filter((file) => path.basename(file).startsWith('pending-'))
      .map((file) => path.relative(rootDir, file));
    throw new Error(
      [
        `发版底账校验失败：应存在且仅存在一份 docs/releases/YYYY/${expectedName}`,
        pending.length > 0
          ? `仍有 pending 底账，请合并范围后重命名：${pending.join(', ')}`
          : '未找到 pending 底账；请从 docs/releases/_template.md 创建并完成验证',
      ].join('\n'),
    );
  }

  const ledgerPath = versionLedgers[0];
  const content = fs.readFileSync(ledgerPath, 'utf8');
  const p0 = section(content, '### P0：', '### P1：');
  if (!p0) {
    throw new Error(`发版底账校验失败：${path.relative(rootDir, ledgerPath)} 缺少 P0 回归章节`);
  }
  if (/\|\s*(?:待验证|部分通过|失败)\s*\|/.test(p0)) {
    throw new Error('发版底账校验失败：P0 仍包含“待验证 / 部分通过 / 失败”项');
  }

  const gate = section(content, '## 5. 发布闸口', '## 6. 发布结果');
  if (!gate) {
    throw new Error(`发版底账校验失败：${path.relative(rootDir, ledgerPath)} 缺少发布闸口章节`);
  }
  if (/^- \[ \]/m.test(gate)) {
    throw new Error('发版底账校验失败：发布闸口仍有未勾选项');
  }

  return { version, ledgerPath };
}

if (require.main === module) {
  try {
    const result = validateReleaseLedger();
    console.log(
      `✅ 发版底账校验通过：v${result.version} -> ${path.relative(DEFAULT_ROOT, result.ledgerPath)}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  section,
  validateReleaseLedger,
  walkMarkdownFiles,
};
