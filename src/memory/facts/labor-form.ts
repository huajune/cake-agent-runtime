/**
 * 用工形式（labor_form）领域模型：常量、匹配、意向解析与展示规整的单一事实来源。
 *
 * ## 业务模型（2026-07 产品调整后的层级结构）
 *
 * 岗位轴是**两级结构化字段**：
 * - `basicInfo.laborForm`：用工形式，仅 全职 / 兼职 两值；
 * - `basicInfo.partTimeJobType`：兼职类型（laborForm=兼职 时的细分），寒假工 / 暑假工 / 小时工。
 *
 * 候选人偏好轴是**扁平词汇**：候选人嘴里是一个词（"找暑假工"/"要全职"），不区分父子轴，
 * 所以会话事实 `labor_form` 存单值（VALID_LABOR_FORMS），由匹配层（matchesLaborForm）
 * 把扁平偏好翻译成岗位轴的层级比对。
 *
 * 不做历史脏数据兼容：laborForm 不在 {全职,兼职}、或 partTimeJobType 不在细分表内的
 * 岗位数据视为**上游数据问题**，匹配层不兜底（匹配不上就是匹配不上），由查岗工具把
 * 异常岗位显式暴露（laborFormAnomalies），推动改数据本身。
 *
 * 口径红线：用工形式一律按岗位结构化字段如实介绍，禁止互相改写或编造；
 * "正式工"/"临时工" 与 全职/兼职 不是同一概念轴（都属"正式工"用工性质、不在招聘范围），
 * 作为噪音词剥离/隐藏。
 *
 * 文件组织：岗位轴常量 → 候选人偏好轴常量 → 岗位匹配 → 候选人意向解析 → 展示规整/入参兜底。
 */

// ==================== 岗位轴（新契约层级结构） ====================

/** 岗位 `laborForm` 字段的合法值（父级轴）。 */
export const JOB_LABOR_FORMS = ['全职', '兼职'] as const;

/** 岗位 `partTimeJobType` 字段的合法值（兼职细分轴）。 */
export const PART_TIME_JOB_TYPES = ['寒假工', '暑假工', '小时工'] as const;

/** 判断岗位 laborForm 字段值是否在父级轴合法值内（规整后）。 */
export function isJobAxisLaborForm(value: string | null | undefined): boolean {
  const normalized = sanitizeLaborFormForDisplay(value);
  if (!normalized) return false;
  return (JOB_LABOR_FORMS as readonly string[]).includes(normalized);
}

/** 判断岗位 partTimeJobType 字段值是否在兼职细分轴合法值内（规整后）。 */
export function isPartTimeJobType(value: string | null | undefined): boolean {
  const normalized = sanitizeLaborFormForDisplay(value);
  if (!normalized) return false;
  return (PART_TIME_JOB_TYPES as readonly string[]).includes(normalized);
}

/** 全职用工形式的标准值。 */
export const FULL_TIME_LABOR_FORM = '全职';

/** 判断一个 labor_form（规整后）是否为全职。 */
export function isFullTimeLaborForm(value: string | null | undefined): boolean {
  return sanitizeLaborFormForDisplay(value) === FULL_TIME_LABOR_FORM;
}

/** 季节性兼职类型（`partTimeJobType` 细分轴的子集；历史数据可能直接写在 laborForm 上）。 */
export const SEASONAL_LABOR_FORMS = ['寒假工', '暑假工'] as const;

/** 判断一个值是否为季节性用工类型（寒假工 / 暑假工）。 */
export function isSeasonalLaborForm(value: string | null | undefined): boolean {
  const normalized = sanitizeLaborFormForDisplay(value);
  if (!normalized) return false;
  return (SEASONAL_LABOR_FORMS as readonly string[]).includes(normalized);
}

// ==================== 候选人偏好轴（扁平词汇） ====================

/**
 * 候选人偏好侧 labor_form 合法词汇（扁平单值）：父级值 + 兼职细分值拉平。
 * 存量会话事实里的表外历史值经 isValidLaborForm 校验会被视为无效、自然失效。
 */
export const VALID_LABOR_FORMS = [...JOB_LABOR_FORMS, ...PART_TIME_JOB_TYPES] as const;

export type ValidLaborForm = (typeof VALID_LABOR_FORMS)[number];

/**
 * 判断一个 labor_form 值是否为合法候选人偏好。
 *
 * 作为读取侧的词汇表闸门：会话事实由 LLM 提取产生、且口径会随产品调整（如 2026-07
 * 废除"兼职+"），存量数据里可能短暂残留表外值（2026-07-10 排查生产 Redis：331 条
 * labor_form 中仅 3 条"兼职+"，随 key TTL 数天内自然过期），读取时一律视为无效。
 */
export function isValidLaborForm(value: string | null | undefined): boolean {
  if (!value) return false;
  return (VALID_LABOR_FORMS as readonly string[]).includes(value);
}

/**
 * 触发用工形式**硬过滤**的候选人偏好集（见 `applyLaborFormConstraint`）。
 *
 * 业务口径：候选人指定任一合法用工形式时，都必须按岗位结构化字段（laborForm +
 * partTimeJobType）层级匹配，不能把别的用工形式包装成候选人想要的类型。
 */
export const HARD_FILTERED_LABOR_FORMS = VALID_LABOR_FORMS;

/** 判断候选人想要的用工形式是否会触发硬过滤。 */
export function isHardFilteredLaborForm(value: string | null | undefined): boolean {
  if (!value) return false;
  return (HARD_FILTERED_LABOR_FORMS as readonly string[]).includes(value);
}

/**
 * 兼职形态家族（**候选人偏好侧**词汇）：候选人要的是这些兼职形态之一、而附近岗位
 * 没有严格匹配的细分标签时，同为兼职的岗位不该被一刀切成"附近暂无岗位"
 * （badcase 6a334d26：细分标签在岗位轴上分布不均，严格过滤会清空整个召回池）。
 *
 * 只用于判定**候选人想要的值**是否可参与家族放宽；放宽后的岗位侧判定是
 * laborForm=兼职 严格相等（见 applyLaborFormConstraint），不认历史扁平脏数据。
 *
 * 注意与"严格按岗位写的值介绍"口径的边界：家族放宽只影响**召回**（别让候选人错过
 * 同形态岗位），不影响**介绍**——放宽命中的岗位必须按各自真实 用工形式/兼职类型 说明，
 * 不得包装成候选人原话里的用工形式。全职不在家族内，仍然严格匹配。
 */
export const PART_TIME_LABOR_FORM_FAMILY = ['兼职', ...PART_TIME_JOB_TYPES] as const;

/** 判断候选人想要的用工形式是否属于兼职形态家族（可参与空结果家族放宽）。 */
export function isPartTimeFamilyLaborForm(value: string | null | undefined): boolean {
  if (!value) return false;
  return (PART_TIME_LABOR_FORM_FAMILY as readonly string[]).includes(value);
}

// ==================== 岗位匹配（扁平偏好 → 层级岗位轴的翻译层） ====================

/**
 * 判断岗位是否匹配候选人想要的用工形式（层级匹配，严格按新契约字段）。
 *
 * - 候选人要 全职/兼职 → 按父级 laborForm 严格相等（要"兼职"时不苛求细分）。
 * - 候选人要 小时工/寒假工/暑假工 → laborForm=兼职 且 partTimeJobType 严格相等。
 *
 * 不做任何放宽或脏数据兜底：
 * - 不做"小时工≈暑假工"的语义放宽——平台口径要求**严格按岗位写的值介绍**；
 * - 不认把细分值写在 laborForm 上的历史扁平形态（如 laborForm=小时工）——那是
 *   上游数据问题，应通过 laborFormAnomalies 暴露后改数据，不在匹配层消化。
 */
export function matchesLaborForm(
  jobLaborForm: string | null | undefined,
  jobPartTimeJobType: string | null | undefined,
  wanted: string | null | undefined,
): boolean {
  if (!wanted) return false;
  const laborForm = sanitizeLaborFormForDisplay(jobLaborForm);
  if (!laborForm) return false;

  if (wanted === '全职' || wanted === '兼职') return laborForm === wanted;
  const partTimeJobType = sanitizeLaborFormForDisplay(jobPartTimeJobType);
  return laborForm === '兼职' && partTimeJobType === wanted;
}

// ==================== 候选人意向解析（当前消息 → 偏好变更决策） ====================

/**
 * 当前消息对用工形式偏好的确定性变更。
 *
 * - set：候选人明确选择/接受了一个合法用工形式；
 * - clear：候选人明确排除或撤销了旧的严格偏好，clearedValues 用来避免误清其它形式；
 * - ignore：没有表达偏好，或只是在核对当前岗位的用工形式。
 *
 * clear 与 ignore 必须分开：把二者都压成 null 会让“除了暑假工都可以”重新回退到
 * 会话里旧的“暑假工”，也会让“这个是小时工吗”错误清掉仍有效的暑假工要求。
 */
export type LaborFormIntentDecision =
  | { kind: 'set'; value: ValidLaborForm }
  | { kind: 'clear'; clearedValues: ValidLaborForm[] }
  | { kind: 'ignore' };

const SUMMER_LABOR_FORM_ALIAS_PATTERN = /暑期工作|暑期兼职|暑假兼职|暑期工/g;
const LABOR_FORM_MENTION_PATTERN = /暑假工|寒假工|小时工|全职|(?:普通|常规|长期)?兼职/g;
const LABOR_FORM_UNCERTAINTY_PATTERN = /不知道|不确定|不清楚|没想好|没确定|还没定|看情况|拿不准/;
const LABOR_FORM_PREFERENCE_SIGNAL_PATTERN =
  /想(?:找|做|要)|要(?:找|做|看)?|只(?:找|做|要|考虑)|找个|做个|接受|考虑|能做|可以做|也行|都行|都可以|也可以|就行|貌似好|帮我(?:找|看|查)|给我(?:找|看|查)|有[^，。！？?!；;\n]{0,8}[吗么？?]|招[^，。！？?!；;\n]{0,8}[吗么？?]/;
const CURRENT_JOB_LABOR_FORM_CONTEXT_PATTERN =
  /(?:这个|这份|这家|该|当前)(?:岗位|工作)?|(?:岗位|工作|用工形式)[^，。！？?!；;\n]{0,6}(?:是|属于|算)|(?:^|\s)(?:就|也就|所以|也就是说)?是/;
const LABOR_FORM_FACT_QUESTION_PATTERN =
  /是不是|是否|算不算|属于吗|是吗|对吗|对吧|到底是|还是[^，。！；;\n]{0,12}[？?]/;
const LABOR_FORM_REGISTRATION_LABEL_PATTERN = /(?:身份|登记|填写|填报|录入|申报)/;
/**
 * 招聘限制疑问句（badcase chat 6a61c97c，2026-07-23）："只招暑假工吗"是在询问岗位
 * 的招聘限制——言下之意候选人自己很可能**不是**暑假工，与"还招暑假工吗"（求职意向）
 * 语义相反。命中即整句忽略，不得提取为候选人用工形式偏好；否则该值以 rule/high 每轮
 * 重刷粘死，候选人后续改口"长期"都清不掉，job_list 被过滤到 0 只能转人工。
 */
const LABOR_FORM_HIRING_RESTRICTION_QUESTION_PATTERN =
  /(?:只|仅)(?:招|要|收)[^，。！？?!；;\n]{0,10}[吗么？?]/;
/**
 * "长期"意向（同 badcase）：候选人说"长期呢/我说长期有没有/要长期的"时，明确否定了
 * 寒暑假季节工偏好，但"长期"不在 labor_form 合法枚举内映射不出新值——旧的季节工值
 * 会永生。此处产出 clear 信号：既清除已存的暑/寒假工，也让 job_list 本轮旁路季节过滤
 * （currentLaborFormIntent.kind==='clear' 消费路径），给模型留出口。
 */
const LONG_TERM_MENTION_PATTERN = /长期/;
const LABOR_FORM_REJECTION_PREFIX_PATTERN =
  /(?:(?<!是)不是|并非|不要|别|不想|不考虑|不接受|不找|不做|拒绝|排除|除了|不适合|不能做|做不了)[^，。！？?!；;\n]{0,14}$/;
const LABOR_FORM_REJECTION_SUFFIX_PATTERN =
  /^[^，。！？?!；;\n]{0,10}(?:做不了|不能做|不做|不找|不要|不考虑|不接受|不行|不合适|不可以|不能(?:给我|给你|帮我|帮你)?(?:推荐|报名|预约|安排)?)/;

interface LaborFormMention {
  value: ValidLaborForm;
  raw: string;
  index: number;
  length: number;
}

/**
 * 解析候选人当前消息里的用工形式意向。
 *
 * 解析按小句顺序归并，保证“不要暑假工，普通兼职就行”最终 set=兼职，
 * “只找暑假工，就是小时工是吗？”中的岗位事实问句则保持此前 set=暑假工。
 */
export function decideLaborFormIntent(message: string | null | undefined): LaborFormIntentDecision {
  if (!message?.trim()) return { kind: 'ignore' };

  const normalized = message.replace(SUMMER_LABOR_FORM_ALIAS_PATTERN, '暑假工');
  const clauses = normalized
    .split(/(?<=[？?])|[，,。！!；;\n]|(?<!不)但(?:是)?|不过/)
    .map((clause) => clause.trim())
    .filter(Boolean);

  let decision: LaborFormIntentDecision = { kind: 'ignore' };

  for (const clause of clauses) {
    const clauseDecision = decideLaborFormClause(clause);
    if (clauseDecision.kind === 'ignore') continue;

    if (clauseDecision.kind === 'set') {
      decision = clauseDecision;
      continue;
    }

    if (decision.kind === 'set' && !clauseDecision.clearedValues.includes(decision.value)) {
      continue;
    }
    if (decision.kind === 'clear') {
      decision = {
        kind: 'clear',
        clearedValues: Array.from(
          new Set([...decision.clearedValues, ...clauseDecision.clearedValues]),
        ),
      };
      continue;
    }
    decision = clauseDecision;
  }

  return decision;
}

function decideLaborFormClause(clause: string): LaborFormIntentDecision {
  // "长期呢/我说长期有没有/要长期的"：明确否定季节工偏好。"长期"不在合法枚举内，
  // 无法以 set 覆盖旧值，必须走 clear 清除暑/寒假工（拒绝方向"做不了长期"不清，
  // 保持原偏好）。含"兼职"时交给下方 mention 路径（"长期兼职"→ set 兼职）。
  if (LONG_TERM_MENTION_PATTERN.test(clause) && !/兼职/.test(clause)) {
    const index = clause.search(LONG_TERM_MENTION_PATTERN);
    const prefix = clause.slice(0, index);
    const suffix = clause.slice(index + 2);
    const isRejected =
      LABOR_FORM_REJECTION_PREFIX_PATTERN.test(prefix) ||
      LABOR_FORM_REJECTION_SUFFIX_PATTERN.test(suffix);
    if (!isRejected) {
      return { kind: 'clear', clearedValues: ['暑假工', '寒假工'] };
    }
  }

  const mentions = readLaborFormMentions(clause);
  if (mentions.length === 0) return { kind: 'ignore' };

  // "只招暑假工吗"是招聘限制疑问，不是求职意向（与"还招暑假工吗"相反），整句忽略。
  if (LABOR_FORM_HIRING_RESTRICTION_QUESTION_PATTERN.test(clause)) {
    return { kind: 'ignore' };
  }

  // “不确定是暑假工还是小时工”没有形成偏好；整句忽略，不能用最后一个关键词改口。
  if (LABOR_FORM_UNCERTAINTY_PATTERN.test(clause)) return { kind: 'ignore' };

  // “这个岗位是小时工吗 / 就是小时工是吗”是在核对岗位事实。只有同时出现明确的
  // 求职/接受动作时，才把用工形式当成新的候选人偏好。
  const asksOrStatesCurrentJobType =
    (CURRENT_JOB_LABOR_FORM_CONTEXT_PATTERN.test(clause) &&
      (LABOR_FORM_FACT_QUESTION_PATTERN.test(clause) || /(?:是|属于|算)/.test(clause))) ||
    (LABOR_FORM_FACT_QUESTION_PATTERN.test(clause) && /还是/.test(clause));
  if (asksOrStatesCurrentJobType && !LABOR_FORM_PREFERENCE_SIGNAL_PATTERN.test(clause)) {
    return { kind: 'ignore' };
  }
  // “准备用兼职身份登记”只是在复述报名标签，不等于主动放弃已确认的暑假工偏好。
  // 必须同时出现“接受/考虑/想做”等明确意向动作，才能据此改写 labor_form。
  if (
    LABOR_FORM_REGISTRATION_LABEL_PATTERN.test(clause) &&
    !LABOR_FORM_PREFERENCE_SIGNAL_PATTERN.test(clause)
  ) {
    return { kind: 'ignore' };
  }

  const rejected: ValidLaborForm[] = [];
  const accepted: LaborFormMention[] = [];
  for (const mention of mentions) {
    const prefix = clause.slice(0, mention.index);
    const suffix = clause.slice(mention.index + mention.length);
    const isRejected =
      LABOR_FORM_REJECTION_PREFIX_PATTERN.test(prefix) ||
      LABOR_FORM_REJECTION_SUFFIX_PATTERN.test(suffix);
    if (isRejected) rejected.push(mention.value);
    else accepted.push(mention);
  }

  if (accepted.length > 0) {
    // “暑假工短期的兼职”里的“兼职”是上位类目，不是候选人同时接受普通兼职。
    // 只有出现“或者/都可以/普通兼职”等并列接受信号时，才允许非季节性形式覆盖。
    const seasonal = accepted.find((mention) => isSeasonalLaborForm(mention.value));
    const hasSeasonal = seasonal != null;
    const hasExplicitAlternativeSignal =
      /(?:或者|或是|还是|以及|都可以|均可|都行|也可以|也行|普通兼职|常规兼职|长期兼职)/.test(
        clause,
      );
    const nonSeasonal = accepted.filter(
      (mention) =>
        !isSeasonalLaborForm(mention.value) &&
        !(
          hasSeasonal &&
          mention.value === '兼职' &&
          mention.raw === '兼职' &&
          !hasExplicitAlternativeSignal
        ),
    );
    const chosen = hasSeasonal && nonSeasonal.length > 0 ? nonSeasonal.at(-1)! : accepted.at(-1)!;
    if (hasSeasonal && nonSeasonal.length === 0 && seasonal) {
      return { kind: 'set', value: seasonal.value };
    }
    return { kind: 'set', value: chosen.value };
  }

  if (rejected.length > 0) {
    return { kind: 'clear', clearedValues: Array.from(new Set(rejected)) };
  }

  return { kind: 'ignore' };
}

function readLaborFormMentions(clause: string): LaborFormMention[] {
  LABOR_FORM_MENTION_PATTERN.lastIndex = 0;
  return Array.from(clause.matchAll(LABOR_FORM_MENTION_PATTERN)).map((match) => ({
    value: normalizeLaborFormMention(match[0]),
    raw: match[0],
    index: match.index,
    length: match[0].length,
  }));
}

function normalizeLaborFormMention(raw: string): ValidLaborForm {
  if (raw.endsWith('兼职')) return '兼职';
  return raw as ValidLaborForm;
}

// ==================== 展示规整与查询入参兜底 ====================

/**
 * 噪音词：与本平台 全职/兼职 用工形式不属同一概念轴，应从展示文本/laborForm 中剥离或隐藏。
 * "正式工"/"临时工" 都属"正式工"用工性质，不在平台招聘范围；不能把它们当成 全职/兼职 复述。
 */
export const INVALID_LABOR_FORM_WORDS = ['临时工', '正式工'] as const;

/**
 * 把岗位 API 返回的 jobName / jobNickName / jobCategoryName 等"可展示文本"中
 * 残留的噪音用工性质词（正式工/临时工）剔除掉。
 *
 * 业务说明：平台招的是 全职/兼职 岗，"正式工/临时工" 属另一概念轴（正式工用工性质），
 * 不在招聘范围，出现在岗位名里是后台噪音，应在渲染层剥离，不让 LLM 触达。
 * 注意：合法用工形式词（全职/兼职及细分）**不剥离**，照岗位结构化字段如实展示。
 *
 * 实现策略：纯字符串 token 替换，配合分隔符清理。
 */
export function sanitizeJobDisplayText(value: string | null | undefined): string | null {
  if (!value) return null;
  let out = value;
  for (const token of INVALID_LABOR_FORM_WORDS) {
    out = out.split(token).join('');
  }
  // 移除因剔除产生的空括号、空连字符片段
  out = out
    .replace(/[（(]\s*[)）]/g, '')
    .replace(/[-——_/]{2,}/g, '-')
    .replace(/^[\s\-_/]+|[\s\-_/]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out || null;
}

/**
 * 把岗位 API 返回的 laborForm / partTimeJobType 值规整为"可对外展示"的口径。
 *
 * - 噪音用工性质词（"正式工/临时工"）→ 返回 null（不展示，与 全职/兼职 不同轴，
 *   不在招聘范围，避免 LLM 误把它们当 全职/兼职 透传给候选人）。
 * - 合法值（laborForm：全职/兼职；partTimeJobType：寒假工/暑假工/小时工；
 *   以及历史扁平数据里写在 laborForm 上的细分值）→ 原样返回。
 * - 其它非空值 → 原样返回（兜底，避免误删未见过的合法值）。
 */
export function sanitizeLaborFormForDisplay(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if ((INVALID_LABOR_FORM_WORDS as readonly string[]).includes(trimmed)) return null;
  return trimmed;
}

/**
 * 从 jobCategoryList 等查询参数中剔除"用工形式"词。
 *
 * 这些词不是岗位工种，不应作为 category 查询条件；
 * 即使模型违反约束填入，这里也要兜底剥离。
 */
export function stripLaborFormFromCategories(categories: readonly string[]): {
  cleaned: string[];
  removed: string[];
} {
  const banned = new Set<string>([...INVALID_LABOR_FORM_WORDS, ...VALID_LABOR_FORMS]);
  const cleaned: string[] = [];
  const removed: string[] = [];

  for (const raw of categories) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) continue;
    if (banned.has(trimmed)) {
      removed.push(trimmed);
    } else {
      cleaned.push(trimmed);
    }
  }

  return { cleaned, removed };
}
