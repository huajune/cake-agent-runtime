type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function formatScenarioSettlement(scenario: UnknownRecord, index: number): string | null {
  const period = readText(scenario.salaryPeriod);
  if (!period) return null;

  const salaryType = readText(scenario.salaryType) ?? `薪资方案${index}`;
  const payday = readText(scenario.payday);
  return `${salaryType}:${period}${payday ? `（${payday}发薪）` : ''}`;
}

function extractSettlementNotes(remark: string | null): string[] {
  if (!remark) return [];

  const notes: string[] = [];
  if (/每天按照[^，。；\n]{0,40}日结|基础[^，。；\n]{0,20}日结/u.test(remark)) {
    notes.push('基础工资按日结');
  }
  if (/阶梯[^，。；\n]{0,30}(?:月结|每月\s*\d+\s*号)/u.test(remark)) {
    notes.push('阶梯差价按月结');
  }
  if (/培训[^，。；\n]{0,30}月结/u.test(remark)) {
    notes.push('培训费用按月结');
  }

  const differencePayday = remark.match(/每月\s*(\d+)\s*号发上月差价/u)?.[1];
  if (differencePayday) notes.push(`每月${differencePayday}号发上月差价`);
  return notes;
}

/**
 * 把岗位的多薪资方案压成不会混淆“工资结算”和“阶梯累计周期”的记忆摘要。
 *
 * 只读取结构化结算字段和备注中的封闭结算句式；其它自由文本不进入每轮 prompt。
 */
export function formatSettlementSummary(jobInput: unknown): string | null {
  const job = asRecord(jobInput);
  const jobSalary = asRecord(job?.jobSalary);
  const scenarios = Array.isArray(jobSalary?.salaryScenarioList)
    ? jobSalary.salaryScenarioList
    : [];
  const scenarioParts = scenarios
    .map((scenario, index) => {
      const record = asRecord(scenario);
      return record ? formatScenarioSettlement(record, index + 1) : null;
    })
    .filter((part): part is string => Boolean(part));

  const welfare = asRecord(job?.welfare);
  const notes = extractSettlementNotes(readText(welfare?.remark));
  const parts = [...scenarioParts, ...notes];
  return parts.length > 0 ? [...new Set(parts)].join('；') : null;
}
