export const DEFAULT_RESUME_MAX_CHARS = 3_000;

const LOW_VALUE_HEADING_RE =
  /^(?:主修课程|自我评价|个人评价|获奖(?:经历|情况)?|荣誉(?:奖励)?|证书(?:列表|情况)?)(?:\s*[：:])?\s*$/u;
const USEFUL_HEADING_RE =
  /^(?:基本信息|个人信息|联系方式|求职意向|教育经历|工作经历|实习经历|项目经历|技能特长|专业技能|语言能力)(?:\s*[：:])?\s*$/u;
const PROFILE_LINE_RE =
  /(?:姓名|名字|手机号|手机|电话|联系方式|年龄|性别|求职意向|期望岗位|期望薪资|期望城市)\s*[：:]|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{1,2}\s*岁(?!\d)|^[男女]\s*(?:[|｜]|$)/u;

/** 抽取与公证共用的唯一规整入口。 */
export function normalizeResumeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\r\n?/gu, '\n')
    .replace(/\u00a0/gu, ' ')
    .replace(/\t/gu, ' ')
    .replace(/[ ]{2,}/gu, ' ')
    .replace(/\n[ \t]+/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** output 专用：移除低价值长段，再裁到默认 3000 字；字段抽取仍使用未裁剪规整全文。 */
export function trimLowValueSections(text: string, maxChars = DEFAULT_RESUME_MAX_CHARS): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (LOW_VALUE_HEADING_RE.test(trimmed)) {
      skipping = true;
      continue;
    }
    if (skipping && USEFUL_HEADING_RE.test(trimmed)) skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
    .slice(0, maxChars);
}

/** 把乱序文本里的档案行移动到合成“基本信息”块前部；无命中时逐字不变。 */
export function hoistProfileBlock(text: string): string {
  const lines = text.split('\n');
  const profileIndexes: number[] = [];
  const profileLines: string[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed && PROFILE_LINE_RE.test(trimmed)) {
      profileIndexes.push(index);
      if (!profileLines.includes(trimmed)) profileLines.push(trimmed);
    }
  });
  if (profileLines.length === 0) return text;
  const moved = new Set(profileIndexes);
  const rest = lines
    .filter((_line, index) => !moved.has(index))
    .join('\n')
    .trim();
  return [`基本信息`, ...profileLines, rest].filter(Boolean).join('\n');
}
