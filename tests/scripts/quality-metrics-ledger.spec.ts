import { readFileSync } from 'fs';
import { join } from 'path';
import {
  LEDGER_COLUMNS,
  LEDGER_NOTE_MAX_LENGTH,
  validateLedger,
} from '../../scripts/quality/quality-metrics-ledger';

const HEADER = `| ${LEDGER_COLUMNS.join(' | ')} |`;
const SEPARATOR = `|${LEDGER_COLUMNS.map(() => '---').join('|')}|`;

function ledger(rows: string[], heading = '## 台账'): string {
  return [
    '# 台账',
    '',
    '## 列定义',
    '',
    '| a | b |',
    '|---|---|',
    '| x | y |',
    '',
    heading,
    '',
    HEADER,
    SEPARATOR,
    ...rows,
    '',
  ].join('\n');
}

function row(overrides: Partial<Record<(typeof LEDGER_COLUMNS)[number], string>> = {}): string {
  const base: Record<(typeof LEDGER_COLUMNS)[number], string> = {
    date: '2026-09-02',
    source_task: 'weekly-judge-calibration',
    stage: 'onboard_followup',
    metric: '判官精确率',
    value: '0.9677',
    numerator: '30',
    denominator: '31',
    note: 'J1 复聊 blockReason 31 次判决 30 一致',
    trace_ref: 'logs/analysis/judge-calibration-2026-09-02.md',
  };
  const merged = { ...base, ...overrides };
  return `| ${LEDGER_COLUMNS.map((column) => merged[column]).join(' | ')} |`;
}

function messages(markdown: string): string[] {
  return validateLedger(markdown).issues.map((issue) => issue.message);
}

describe('quality-metrics-ledger', () => {
  it('仓库内的台账必须通过校验（种子行与格式）', () => {
    const markdown = readFileSync(join(__dirname, '../../docs/quality-metrics-ledger.md'), 'utf8');
    const result = validateLedger(markdown);
    expect(result.issues).toEqual([]);
    expect(result.rowCount).toBeGreaterThan(0);
  });

  it('合法行通过；同一天同指标靠 note 区分可以多行', () => {
    const markdown = ledger([
      row(),
      row({ stage: '-', value: '0.7143', numerator: '20', denominator: '28', note: 'J2 测试评审' }),
      row({ stage: '-', value: '0.7778', numerator: '7', denominator: '9', note: 'J4 入站词表' }),
    ]);
    expect(validateLedger(markdown)).toEqual({ rowCount: 3, issues: [] });
  });

  it('白名单：阶段名、指标名、任务名不得自造', () => {
    expect(messages(ledger([row({ stage: 'booking' })]))[0]).toContain('stage 不在口径页');
    expect(messages(ledger([row({ metric: '通过率' })]))[0]).toContain('metric 不在口径页');
    expect(messages(ledger([row({ source_task: 'weekly-ops-report' })]))[0]).toContain(
      'source_task 不在白名单',
    );
  });

  it('value 必须等于分子除分母保留 4 位小数', () => {
    expect(messages(ledger([row({ value: '0.97' })]))[0]).toContain('value 与分子分母不符');
    expect(messages(ledger([row({ value: '96.77' })]))[0]).toContain('value 必须是 0~1');
    expect(messages(ledger([row({ numerator: '32' })]))[0]).toContain('numerator 不能大于');
    expect(messages(ledger([row({ denominator: '0', numerator: '0', value: '0' })]))[0]).toContain(
      'denominator 为 0',
    );
    expect(messages(ledger([row({ numerator: '3.5' })]))[0]).toContain('numerator 必须是非负整数');
  });

  it('date 必须是合法日期', () => {
    expect(messages(ledger([row({ date: '2026-02-30' })]))[0]).toContain('date 必须是合法的');
    expect(messages(ledger([row({ date: '09-02' })]))[0]).toContain('date 必须是合法的');
  });

  it('脱敏与长度：note 不得含手机号、不得超长、不得为空；trace_ref 不得为空', () => {
    expect(messages(ledger([row({ note: '候选人 13812345678 说没约上' })]))[0]).toContain(
      '11 位手机号',
    );
    expect(messages(ledger([row({ note: '很'.repeat(LEDGER_NOTE_MAX_LENGTH + 1) })]))[0]).toContain(
      `note 超过 ${LEDGER_NOTE_MAX_LENGTH} 字`,
    );
    expect(messages(ledger([row({ note: '' })]))[0]).toContain('note 不能为空');
    expect(messages(ledger([row({ trace_ref: '-' })]))[0]).toContain('trace_ref 不能为空');
  });

  it('五元组重复视为重复登记', () => {
    const result = validateLedger(ledger([row(), row()]));
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toEqual({ line: 14, message: expect.stringContaining('重复') });
  });

  it('列数不对、表头不对、缺小节都要报错', () => {
    expect(messages(ledger(['| 2026-09-02 | manual | - |']))[0]).toContain('列数应为 9');
    const badHeader = ledger([row()]).replace(HEADER, '| 日期 | 任务 |');
    expect(messages(badHeader)[0]).toContain('台账表头必须是');
    expect(messages(ledger([row()], '## 结论'))[0]).toContain('找不到「## 台账」');
  });

  it('只解析「## 台账」下的第一张表，后面的段落不算行', () => {
    const markdown = `${ledger([row()])}\n说明文字\n| 这不是 | 台账行 |\n`;
    expect(validateLedger(markdown)).toEqual({ rowCount: 1, issues: [] });
  });
});
