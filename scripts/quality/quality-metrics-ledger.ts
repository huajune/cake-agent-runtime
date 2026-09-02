/**
 * 质量指标台账（docs/quality-metrics-ledger.md）的解析与校验。
 *
 * 台账是定时观测任务量化结论的唯一落点；阶段名与指标名以口径页
 * docs/architecture/agent-quality-evaluation.md §1 为白名单。markdown 表没有 CHECK 约束，
 * 这一层就是它的约束：列数、白名单、分子分母与 value 一致、脱敏、五元组去重。
 * 纯函数，无 IO；运行入口见 validate-quality-metrics-ledger.ts。
 */

export const LEDGER_COLUMNS = [
  'date',
  'source_task',
  'stage',
  'metric',
  'value',
  'numerator',
  'denominator',
  'note',
  'trace_ref',
] as const;

/** 口径页 §1 的五个阶段（strategy_config.stage_goals.stage）。 */
export const LEDGER_STAGES = [
  'trust_building',
  'job_consultation',
  'qualify_candidate',
  'interview_scheduling',
  'onboard_followup',
] as const;

/** 横切 / 全阶段。 */
export const LEDGER_CROSS_STAGE = '-';

/** 口径页 §1 的横切指标。 */
export const LEDGER_METRICS = ['硬错误率', '转人工精确率', '稳定率', '判官精确率'] as const;

export const LEDGER_SOURCE_TASKS = [
  'weekly-guardrail-analysis',
  'weekly-handoff-analysis',
  'fact-adjudication-shadow-daily',
  'weekly-judge-calibration',
  'manual',
] as const;

export const LEDGER_NOTE_MAX_LENGTH = 120;

const LEDGER_SECTION_HEADING = /^##\s+台账\s*$/;
const MARKDOWN_HEADING = /^#{1,6}\s/;
const TABLE_SEPARATOR = /^\|?\s*:?-{3,}/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INTEGER_PATTERN = /^\d+$/;
const VALUE_PATTERN = /^(0(\.\d{1,4})?|1(\.0{1,4})?)$/;
const CN_MOBILE_PATTERN = /1[3-9]\d{9}/;

export interface LedgerIssue {
  /** 1-based 行号；0 = 文件级问题 */
  line: number;
  message: string;
}

export interface LedgerTableRow {
  line: number;
  cells: string[];
}

export interface LedgerParseResult {
  header: string[] | null;
  rows: LedgerTableRow[];
  issues: LedgerIssue[];
}

export interface LedgerValidationResult {
  rowCount: number;
  issues: LedgerIssue[];
}

function splitTableLine(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((cell) => cell.trim());
}

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** 定位「## 台账」小节下的第一张表，返回表头与数据行（不做语义校验）。 */
export function parseLedger(markdown: string): LedgerParseResult {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => LEDGER_SECTION_HEADING.test(line.trim()));
  if (headingIndex < 0) {
    return { header: null, rows: [], issues: [{ line: 0, message: '找不到「## 台账」小节' }] };
  }

  let cursor = headingIndex + 1;
  while (cursor < lines.length && !lines[cursor].trim().startsWith('|')) {
    if (MARKDOWN_HEADING.test(lines[cursor])) break;
    cursor += 1;
  }
  if (cursor >= lines.length || !lines[cursor].trim().startsWith('|')) {
    return {
      header: null,
      rows: [],
      issues: [{ line: headingIndex + 1, message: '「## 台账」小节下没有表格' }],
    };
  }

  const header = splitTableLine(lines[cursor]);
  const separator = lines[cursor + 1];
  if (separator === undefined || !TABLE_SEPARATOR.test(separator.trim())) {
    return {
      header,
      rows: [],
      issues: [{ line: cursor + 2, message: '表头下一行必须是 markdown 分隔行（|---|）' }],
    };
  }

  const rows: LedgerTableRow[] = [];
  for (let index = cursor + 2; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim().startsWith('|')) break;
    rows.push({ line: index + 1, cells: splitTableLine(raw) });
  }

  return { header, rows, issues: [] };
}

function validateRow(row: LedgerTableRow, seenKeys: Set<string>): LedgerIssue[] {
  const issues: LedgerIssue[] = [];
  const fail = (message: string) => issues.push({ line: row.line, message });

  if (row.cells.length !== LEDGER_COLUMNS.length) {
    fail(
      `列数应为 ${LEDGER_COLUMNS.length}，实际 ${row.cells.length}（note / trace_ref 里不要用竖线）`,
    );
    return issues;
  }

  const [date, sourceTask, stage, metric, value, numerator, denominator, note, traceRef] =
    row.cells;

  if (!isValidDate(date)) fail(`date 必须是合法的 YYYY-MM-DD：${date}`);
  if (!(LEDGER_SOURCE_TASKS as readonly string[]).includes(sourceTask)) {
    fail(`source_task 不在白名单：${sourceTask}（允许：${LEDGER_SOURCE_TASKS.join(' / ')}）`);
  }
  if (stage !== LEDGER_CROSS_STAGE && !(LEDGER_STAGES as readonly string[]).includes(stage)) {
    fail(`stage 不在口径页 §1 白名单：${stage}（允许：${LEDGER_STAGES.join(' / ')} 或 -）`);
  }
  if (!(LEDGER_METRICS as readonly string[]).includes(metric)) {
    fail(`metric 不在口径页 §1 白名单：${metric}（允许：${LEDGER_METRICS.join(' / ')}）`);
  }

  const numeratorOk = INTEGER_PATTERN.test(numerator);
  const denominatorOk = INTEGER_PATTERN.test(denominator);
  if (!numeratorOk) fail(`numerator 必须是非负整数：${numerator}`);
  if (!denominatorOk) fail(`denominator 必须是非负整数：${denominator}`);
  if (numeratorOk && denominatorOk) {
    const n = Number(numerator);
    const d = Number(denominator);
    if (d === 0) {
      fail('denominator 为 0 的结论不写行（无样本就不落账）');
    } else if (n > d) {
      fail(`numerator 不能大于 denominator：${n} > ${d}`);
    } else if (!VALUE_PATTERN.test(value)) {
      fail(`value 必须是 0~1、最多 4 位小数：${value}`);
    } else if (Number(value) !== Number((n / d).toFixed(4))) {
      fail(`value 与分子分母不符：${value} 应为 round(${n}/${d}, 4) = ${(n / d).toFixed(4)}`);
    }
  }

  if (!note || note === LEDGER_CROSS_STAGE) fail('note 不能为空：写一句大白话说明口径与本期要点');
  if (note.length > LEDGER_NOTE_MAX_LENGTH) {
    fail(`note 超过 ${LEDGER_NOTE_MAX_LENGTH} 字（${note.length}）：细节留在报告里`);
  }
  if (CN_MOBILE_PATTERN.test(note) || CN_MOBILE_PATTERN.test(traceRef)) {
    fail('note / trace_ref 含 11 位手机号，台账禁止候选人个人信息');
  }
  if (!traceRef || traceRef === LEDGER_CROSS_STAGE) {
    fail('trace_ref 不能为空：至少给报告路径');
  }

  const key = [date, sourceTask, stage, metric, note].join(' ');
  if (seenKeys.has(key)) {
    fail('(date, source_task, stage, metric, note) 与前面某行重复');
  } else {
    seenKeys.add(key);
  }

  return issues;
}

/** 完整校验：表头、每行白名单与算术一致性、脱敏、去重。 */
export function validateLedger(markdown: string): LedgerValidationResult {
  const parsed = parseLedger(markdown);
  const issues = [...parsed.issues];

  if (parsed.header) {
    const expected = LEDGER_COLUMNS.join(' | ');
    const actual = parsed.header.join(' | ');
    if (actual !== expected) {
      issues.push({ line: 0, message: `台账表头必须是「${expected}」，实际「${actual}」` });
      return { rowCount: parsed.rows.length, issues };
    }
  }

  const seenKeys = new Set<string>();
  for (const row of parsed.rows) {
    issues.push(...validateRow(row, seenKeys));
  }

  return { rowCount: parsed.rows.length, issues };
}
