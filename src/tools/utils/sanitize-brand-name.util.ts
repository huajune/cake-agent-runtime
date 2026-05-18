/**
 * 把 duliday 工具返回字段值里的「独立日」统一替换为「独立客」。
 *
 * 业务事实：本公司对外名称是「独立客」。「独立日」「杜力岱」「DuLiDay」都是历史/别名/英文写法，
 * 指向同一主体。但 Agent 对外输出必须只用"独立客"，所以工具往 markdown 拼装前需要 sanitize 字段值，
 * 避免 Agent 原样复述出"独立日购买保险 / 独立日不购买"这种已废的对外用词。
 *
 * 策略：
 * 1. 优先做"自然短语映射"：把"独立日购买/不购买/提供/承担..."替换为"公司..."，比直接换成
 *    "独立客购买保险"读起来更口语化（候选人不会看到"独立客购买/不购买"这种生硬主语）。
 * 2. 剩余兜底：把"独立日 + 业务上下文"统一换成"独立客"，但保留"独立日报/独立日历/独立日记/
 *    独立日志/独立日期/独立日刊/独立日光"等含「独立日」为子串的合法汉语词，避免误伤。
 */

const NATURAL_PHRASE_MAP: ReadonlyArray<[RegExp, string]> = [
  [/独立日(购买|不购买|提供|不提供|承担|支付|报销|补贴|发放|安排)/g, '公司$1'],
];

const PRESERVE_AFTER_CHARS = new Set(['报', '历', '记', '志', '期', '刊', '光', '程']);

export function sanitizeBrandName(text: string): string {
  if (!text || !text.includes('独立日')) return text;
  let out = text;

  for (const [re, replacement] of NATURAL_PHRASE_MAP) {
    out = out.replace(re, replacement);
  }

  out = out.replace(/独立日(.?)/g, (_match, next: string) => {
    if (next && PRESERVE_AFTER_CHARS.has(next)) return `独立日${next}`;
    return `独立客${next ?? ''}`;
  });

  return out;
}
