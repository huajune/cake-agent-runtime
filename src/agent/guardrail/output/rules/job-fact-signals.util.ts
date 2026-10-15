/**
 * 岗位硬事实信号（纯正则，零 LLM）。
 *
 * "距离 / 时薪 / 班次时段"这类量化数据用于 repair 回归闸判断首版岗位结构是否
 * 被修复版压扁；不用于对回复做开放语义判定。
 */

/**
 * 岗位硬事实：距离（km/公里）、单位薪资（元/时·天·月，含 "22-28 元/时" 区间）、
 * 班次时段（HH:MM-HH:MM，含 "22:00-次日07:00" 跨午夜）、单位前置薪资
 * （"月薪3000-4000" / "时薪25.5起" / "日薪180元"，后缀单位可有可无）。
 * repair 回归闸与 job_fact_without_provenance 守卫共用这一份定义。
 * 数字与单位之间只认行内空白：段尾"就是48元"接下一段开头"月工时…"不是"48元/月"。
 */
export const QUANTIFIED_JOB_FACT_PATTERN =
  /\d+(?:\.\d+)?[^\S\n]*(?:公里|km|KM)|\d+(?:\.\d+)?(?:[^\S\n]*[-~—至到][^\S\n]*\d+(?:\.\d+)?)?[^\S\n]*元[^\S\n]*\/?[^\S\n]*(?:小?时|天|月)|\d{1,2}[:：]\d{2}[^\S\n]*[-—~至到][^\S\n]*(?:次日|凌晨)?[^\S\n]*\d{1,2}[:：]\d{2}|(?:月薪|时薪|日薪|底薪)[^\S\n]*(?:是|为|在|约|大概)?[^\S\n]*\d+(?:\.\d+)?(?:[^\S\n]*[-~—至到][^\S\n]*\d+(?:\.\d+)?)?(?:[^\S\n]*元(?:[^\S\n]*\/?[^\S\n]*(?:小?时|天|月))?)?/u;

/** 单位前置薪资的计薪周期：月薪/底薪按月、时薪按时、日薪按天。 */
const PREFIX_SALARY_PERIOD: Readonly<Record<string, '时' | '天' | '月'>> = {
  月薪: '月',
  底薪: '月',
  时薪: '时',
  日薪: '天',
};

/**
 * 量化岗位事实的规范形：去空白、时段补零、距离与区间符号统一、薪资统一成 `N元/时|天|月`。
 * 单位前置写法（"月薪3000-4000" / "时薪25.5"）与后缀写法（"3000-4000元/月"）规整为同一形，
 * 出处对账与"兼职岗报月薪"判定共用，避免两种写法被当成不同事实。
 */
export function normalizeQuantifiedJobFact(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/(^|[^\d])(\d)(?=[:：]\d{2})/g, '$10$2')
    .replace(/公里/g, 'km')
    .replace(/KM/g, 'km')
    .replace(/：/g, ':')
    .replace(/[~—至到]/g, '-')
    .replace(/小时/g, '时')
    .replace(/元\/?(时|天|月)/g, '元/$1')
    .replace(
      /(月薪|时薪|日薪|底薪)(?:是|为|在|约|大概)?(\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?)(?:元(?:\/(时|天|月))?)?/g,
      (_match, prefix: string, amount: string, unit: string | undefined) =>
        `${amount}元/${unit ?? PREFIX_SALARY_PERIOD[prefix]}`,
    );
}

/** 规范形是否为薪资事实（`N元/时|天|月`）。 */
export function isSalaryFact(normalizedFact: string): boolean {
  return /元\/(?:时|天|月)$/u.test(normalizedFact);
}

/** 规范形是否为按月计的薪资金额。 */
export function isMonthlySalaryFact(normalizedFact: string): boolean {
  return /元\/月$/u.test(normalizedFact);
}

/** 文本里全部量化岗位事实（原文片段 + 规范形 + 起始位置）。 */
export function extractQuantifiedJobFacts(
  text: string,
): Array<{ raw: string; normalized: string; index: number }> {
  const pattern = new RegExp(QUANTIFIED_JOB_FACT_PATTERN.source, 'giu');
  return [...text.matchAll(pattern)].map((match) => ({
    raw: match[0].trim(),
    normalized: normalizeQuantifiedJobFact(match[0]),
    index: match.index ?? 0,
  }));
}
