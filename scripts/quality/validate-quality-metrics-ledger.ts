/**
 * 质量指标台账校验入口（仿 geo:validate / vocab:validate，挂在 ci:check）。
 *
 * 用法：
 *   pnpm run quality-ledger:validate              校验仓库内 docs/quality-metrics-ledger.md
 *   pnpm run quality-ledger:validate <文件路径>    校验别处的副本（定时任务在独立 worktree 追加行后用）
 *
 * 校验规则与白名单见 quality-metrics-ledger.ts；口径页 docs/architecture/agent-quality-evaluation.md §1。
 */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';

import { validateLedger } from './quality-metrics-ledger';

const REPO_ROOT = join(__dirname, '../..');
const DEFAULT_LEDGER_PATH = join(REPO_ROOT, 'docs/quality-metrics-ledger.md');

const target = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_LEDGER_PATH;

let markdown: string;
try {
  markdown = readFileSync(target, 'utf8');
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`❌ 读不到质量指标台账：${target}（${message}）`);
  process.exit(1);
}

const { rowCount, issues } = validateLedger(markdown);

if (issues.length > 0) {
  console.error(`❌ 质量指标台账校验失败：${target}`);
  for (const issue of issues) {
    console.error(`  L${issue.line}: ${issue.message}`);
  }
  process.exit(1);
}

console.log(`✅ 质量指标台账校验通过：${rowCount} 行（${target}）`);
