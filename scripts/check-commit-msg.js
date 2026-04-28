#!/usr/bin/env node
/* eslint-disable */
/**
 * commit-msg hook: 强制 commit 描述含中文。
 *
 * 规则：
 * 1. 第一行必须符合 Conventional Commits 格式：`<type>(<scope>)?(!)?: <description>`
 * 2. <type> 必须在 ALLOWED_TYPES 列表内（小写英文）
 * 3. <description> 必须包含至少一个 CJK Unified Ideograph 字符（U+4E00–U+9FFF）
 * 4. 自动生成 / 合并 / 回滚 等场景跳过校验（见 SKIP_PATTERNS）
 *
 * 触发方式：通过 .husky/commit-msg 调用 `node scripts/check-commit-msg.js "$1"`
 */

const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'chore',
  'build',
  'ci',
  'revert',
];

// 第一行如果以这些前缀开头，跳过校验（自动 commit）
const SKIP_PATTERNS = [
  /^Merge\b/,
  /^Revert\s+"/,
  /^Squashed\b/,
  /^fixup!\s/,
  /^squash!\s/,
  /^amend!\s/,
  /^chore\(release\)/, // 自动版本 commit
];

const HEADER_RE = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s+(?<desc>.+)$/;

const CJK_RE = /\p{Script=Han}/u;

function fail(msg, originalLine) {
  console.error('\n❌ commit-msg 校验失败：' + msg);
  if (originalLine !== undefined) {
    console.error(`   原始首行：${JSON.stringify(originalLine)}`);
  }
  console.error('\n本仓库要求 commit 描述至少含一个中文字符（type/scope 仍用英文）。');
  console.error('示例（推荐）：');
  console.error('  feat(wecom): 修复图文合批 race，文本+图片不再被拆批');
  console.error('  fix(prompt): 拉群空头承诺加 final-check 兜底');
  console.error('  chore: 升级 vercel-ai-sdk 到 5.0');
  console.error(
    '\n如确需提交英文（例如纯依赖升级、纯外部 PR 同步等），可临时使用 --no-verify 跳过；',
  );
  console.error('但请确认这是合理例外，不要把整批英文 commit 都靠 --no-verify 绕过。\n');
  process.exit(1);
}

function main() {
  const msgFile = process.argv[2];
  if (!msgFile) {
    // 没传文件路径时直接放过，不要把 hook 弄崩
    process.exit(0);
  }

  let raw;
  try {
    raw = fs.readFileSync(msgFile, 'utf8');
  } catch (err) {
    console.error(`commit-msg 钩子读不到文件 ${msgFile}: ${err.message}`);
    process.exit(0); // 读不到就放过，不阻塞 commit
  }

  // 去掉注释行（git commit 模板的 # 开头注释）
  const lines = raw.split(/\r?\n/).filter((line) => !line.startsWith('#'));
  const firstLine = (lines[0] || '').trim();

  if (!firstLine) {
    fail('commit message 不能为空。', firstLine);
  }

  if (SKIP_PATTERNS.some((re) => re.test(firstLine))) {
    process.exit(0);
  }

  const m = firstLine.match(HEADER_RE);
  if (!m || !m.groups) {
    fail(
      `首行不符合 Conventional Commits 格式 (<type>(<scope>)?: <description>)。`,
      firstLine,
    );
  }

  const { type, desc } = m.groups;

  if (!ALLOWED_TYPES.includes(type)) {
    fail(
      `type "${type}" 不在允许列表内，期望之一：${ALLOWED_TYPES.join(' / ')}。`,
      firstLine,
    );
  }

  if (!CJK_RE.test(desc)) {
    fail(
      `commit 描述部分必须含至少一个中文字符（不计 type / scope）。`,
      firstLine,
    );
  }
}

try {
  main();
} catch (err) {
  // 任何意外异常都不阻塞用户 commit，但提示一下
  console.error(`commit-msg 钩子运行异常（已放过）: ${err.message}`);
  process.exit(0);
}
