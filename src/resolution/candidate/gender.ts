export function parseGender(text: string): '男' | '女' | null {
  if (/男的女的|女的男的|男女不限/u.test(text)) return null;
  if (/(?:要|招|找|限|收)\s*(?:男|女)(?:生|士|的)?/u.test(text)) return null;
  if (/[？?]|(?:吗|么|呢|吧)(?:[啊呀嘛])?(?:[！。])?$/u.test(text)) return null;
  if (
    /(?:朋友|对象|老公|老婆|男朋友|女朋友|孩子|儿子|女儿|同学|室友|他|她)[^，,。;；]{0,6}[男女](?:生|士|的)?/u.test(
      text,
    )
  )
    return null;

  const explicit =
    /(?:我是|本人|性别)\s*[：: ]?\s*(男|女)(?:生|士|的)?/u.exec(text) ??
    /(?:^|[，,。;；！!\s])(?:就?是)?([男女])的(?=[，,。;；！!~～\s]|$)/u.exec(text);
  return (explicit?.[1] as '男' | '女' | undefined) ?? null;
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
