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

function tableCells(content) {
  return content
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim()),
    );
}

function tableRows(content) {
  return tableCells(content).filter(
    (cells) =>
      cells.length > 1 &&
      cells[0] !== 'ID' &&
      !cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s/g, ''))),
  );
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
  const p0Rows = tableRows(p0);
  if (p0Rows.length === 0) {
    throw new Error('发版底账校验失败：P0 回归章节没有可验证的 case');
  }
  const p0Header = tableCells(p0).find((cells) => cells[0] === 'ID');
  const statusColumn = p0Header?.indexOf('状态') ?? -1;
  if (statusColumn < 0) {
    throw new Error('发版底账校验失败：P0 回归表缺少“状态”列');
  }
  const incompleteP0 = p0Rows.filter((cells) => cells[statusColumn] !== '通过');
  if (incompleteP0.length > 0) {
    const details = incompleteP0
      .map((cells) => `${cells[0]}=${cells[statusColumn] || '空'}`)
      .join(', ');
    throw new Error(`发版底账校验失败：P0 状态必须明确为“通过”：${details}`);
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
  tableCells,
  tableRows,
  validateReleaseLedger,
  walkMarkdownFiles,
};
