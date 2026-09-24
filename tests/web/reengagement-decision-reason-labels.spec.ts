import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 复聊 decision_reason 与前端中文映射防漂移。
 *
 * 后端写入 reengagement_touch_records.decision_reason 的字面量散落在 processor / scheduler /
 * agent 三处；前端 ReengagementDetailDrawer 的 DETAIL_REASON_LABELS 是运营看到的唯一中文口径。
 * 这里不 import 前端组件（scss/react 不进 jest），改为直接读源码字符串比对：
 * 后端每新增一个 reason 字面量，必须同批补前端映射，否则本测试红。
 */

const ROOT = resolve(__dirname, '..', '..');
const DRAWER_PATH = join(
  ROOT,
  'web/src/view/reengagement/list/components/ReengagementDetailDrawer/index.tsx',
);
const BACKEND_ROOTS = ['src/agent/reengagement', 'src/biz/monitoring'].map((dir) =>
  join(ROOT, dir),
);
const AGENT_PATH = join(ROOT, 'src/agent/reengagement/reengagement.agent.ts');

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listTsFiles(full));
    else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) files.push(full);
  }
  return files;
}

function collectMatches(source: string, pattern: RegExp): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(pattern)) found.push(match[1]);
  return found;
}

/** trackStopped(identity, '...') / trackScheduleSkipped(identity, '...') 的字面量（允许跨行）。 */
function collectTrackingLiterals(): Set<string> {
  const pattern = /track(?:Stopped|ScheduleSkipped)\(\s*[\w.{}\s,:]*?,\s*'([a-z0-9_]+)'/g;
  const literals = new Set<string>();
  for (const root of BACKEND_ROOTS) {
    for (const file of listTsFiles(root)) {
      for (const literal of collectMatches(readFileSync(file, 'utf8'), pattern)) {
        literals.add(literal);
      }
    }
  }
  return literals;
}

/** ReengagementAgent 的 blockReason 与 validationReason 字面量（直接落 decision_reason）。 */
function collectAgentReasonLiterals(): Set<string> {
  const source = readFileSync(AGENT_PATH, 'utf8');
  const literals = new Set<string>();
  const blockReasonsBlock = source.match(
    /REENGAGEMENT_BLOCK_REASONS\s*=\s*\[([\s\S]*?)\]\s*as const/,
  );
  expect(blockReasonsBlock).not.toBeNull();
  for (const literal of collectMatches(blockReasonsBlock![1], /'([a-z0-9_]+)'/g)) {
    if (literal !== 'none') literals.add(literal);
  }
  for (const literal of collectMatches(source, /validationReason:\s*'([a-z0-9_]+)'/g)) {
    literals.add(literal);
  }
  return literals;
}

function readDrawerLabelKeys(): Set<string> {
  const source = readFileSync(DRAWER_PATH, 'utf8');
  const block = source.match(/const DETAIL_REASON_LABELS[^{]*\{([\s\S]*?)\n\};/);
  expect(block).not.toBeNull();
  return new Set(collectMatches(block![1], /^\s{2}([a-z0-9_]+):\s/gm));
}

describe('reengagement decision_reason 前端中文映射', () => {
  const labelKeys = readDrawerLabelKeys();

  it('能从源码里解析出映射表与后端字面量（防止正则失效后静默通过）', () => {
    expect(labelKeys.size).toBeGreaterThan(20);
    const tracking = collectTrackingLiterals();
    expect(tracking).toContain('signup_interview_gap_lt_3d');
    expect(tracking).toContain('dominated_by_booking_incomplete');
    const agent = collectAgentReasonLiterals();
    expect(agent).toContain('interview_done_reported');
    expect(agent).toContain('confirmation_already_sent');
  });

  it('trackStopped / trackScheduleSkipped 的每个字面量都有中文', () => {
    const missing = [...collectTrackingLiterals()].filter((reason) => !labelKeys.has(reason));
    expect(missing).toEqual([]);
  });

  it('ReengagementAgent 的 blockReason / validationReason 都有中文', () => {
    const missing = [...collectAgentReasonLiterals()].filter((reason) => !labelKeys.has(reason));
    expect(missing).toEqual([]);
  });
});
