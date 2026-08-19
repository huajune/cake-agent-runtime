import type { CandidateParseResult } from './types';

/** 疑问子句：以问号结尾，或以疑问尾词收束（吗/么/呢/吧 + 可选语气词标点）。 */
const QUESTION_CLAUSE_RE = /[？?]\s*$|(?:吗|么|呢|吧)(?:[啊呀嘛])?(?:[！。])?\s*$/u;

/**
 * 岗位要求式表述（PR #1000 评审 P1-10 收窄）：只认「要/招/找/限/收 + 男的|女的|
 * 男生|女生|男士|女士」的完整搭配。裸「找+女」会把「找女装导购的工作，我是女的」
 * 整条误压制，故不再把「的」做成可选。
 */
const REQUIREMENT_CLAUSE_RE = /(?:要|招|找|限|收)\s*(?:男|女)(?:的|生|士)/u;

const THIRD_PARTY_CLAUSE_RE =
  /(?:朋友|对象|老公|老婆|男朋友|女朋友|孩子|儿子|女儿|同学|室友|他|她)[^，,。;；]{0,6}[男女](?:生|士|的)?/u;

const EXPLICIT_GENDER_RE = /(?:我是|本人|性别)\s*[：: ]?\s*(男|女)(?:生|士|的)?/u;
const STANDALONE_GENDER_RE = /(?:^|[，,。;；！!\s])(?:就?是)?([男女])的(?=[，,。;；！!~～\s]|$)/u;

/**
 * 候选人性别自陈解析。
 *
 * 疑问/要求/第三人称守卫按**子句**判定（PR #1000 评审 P1-10）：整条消息级的
 * `[？?]` 守卫会被 debounce 合并击穿——「我是女的，请问多少钱？」整轮丢失；
 * 「找女装导购的工作，我是女的」被要求式守卫误压制。子句判定下，疑问/要求
 * 子句不参与，自陈子句照常命中。
 */
export function parseGender(text: string): CandidateParseResult<'男' | '女'> | null {
  if (/男的女的|女的男的|男女不限/u.test(text)) return null;

  for (const rawClause of text.split(/(?<=[，,。;；！!？?\n\r])/u)) {
    const clause = rawClause.trim();
    if (!clause) continue;
    if (QUESTION_CLAUSE_RE.test(clause)) continue;
    if (REQUIREMENT_CLAUSE_RE.test(clause)) continue;
    if (THIRD_PARTY_CLAUSE_RE.test(clause)) continue;

    const explicit = EXPLICIT_GENDER_RE.exec(clause) ?? STANDALONE_GENDER_RE.exec(clause);
    const value = explicit?.[1] as '男' | '女' | undefined;
    if (value) return { value, excerpt: explicit![0].trim() };
  }
  return null;
}

export function normalizeGenderValue(value: unknown): '男' | '女' | null {
  if (value === 1 || value === '1') return '男';
  if (value === 2 || value === '2') return '女';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^(male|man)$/iu.test(text)) return '男';
  if (/^(female|woman)$/iu.test(text)) return '女';
  const hasMale = /男/u.test(text);
  const hasFemale = /女/u.test(text);
  if (hasMale && hasFemale) return null;
  if (hasMale) return '男';
  if (hasFemale) return '女';
  return null;
}

export function normalizeGenderToId(value: string): 1 | 2 | null {
  return value === '男' ? 1 : value === '女' ? 2 : null;
}
