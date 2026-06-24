/**
 * 从 raw job.welfare 派生结构化 WelfareFacts（Phase 1.B.5 数据契约层）。
 *
 * 历史 badcase 簇 welfare_fabrication：Agent 看到 catering="员工自理" / haveInsurance="不购买"
 * 等字面值后，仍在 reply 中说"公司包吃 / 有保险"——核心原因有两个：
 *  1. 工具回的中文字面值（"员工自理 / 不包吃 / 不购买 / 无"）容易被 LLM 当成弱否定，
 *     在转述时压缩成"有员工餐 / 有保险"
 *  2. 工具完全没返回的字段（班车/夜宵补贴/带薪假 等），LLM 凭训练知识脑补"应该有"
 *
 * 让 LLM 在 render 顶部就看到"福利速览"：明确"有什么/没什么"对照表，
 * 把"工具没说有就不能说"这件事从 prompt 红线层下沉到数据契约层。
 * 保险字段只做内部事实判断；兼职场景主动提"公司买保险"容易被理解成社保/五险，
 * 所以不能把保险归入普通可主动引用福利。
 *
 * 同时保留 raw field 渲染（renderWelfareSection 继续输出 detail），banner 只是
 * 高优先级的"先看这里"提示。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type WelfareKind = 'company' | 'allowance' | 'self_or_none' | 'unspecified';

export interface WelfareFacts {
  /** 员工餐：公司直接提供 / 仅给餐补 / 员工自理或明确无 / 未明确 */
  meals: WelfareKind;
  /** 住宿：公司提供宿舍 / 仅给房补 / 员工自理或明确无 / 未明确 */
  accommodation: WelfareKind;
  /** 保险：公司购买 / 员工自理 / 明确不购买 / 未明确（敏感，仅候选人主动问时可答） */
  insurance: WelfareKind;
  /** 交通补贴：是否存在 trafficAllowanceSalary */
  hasTrafficAllowance: boolean;
  /** 是否有晋升福利说明 */
  hasPromotionWelfare: boolean;
  /** otherWelfare 数组中的条目（已清洗为非空字符串） */
  otherWelfareItems: string[];
}

const EMPTY_WELFARE_FACTS: WelfareFacts = {
  meals: 'unspecified',
  accommodation: 'unspecified',
  insurance: 'unspecified',
  hasTrafficAllowance: false,
  hasPromotionWelfare: false,
  otherWelfareItems: [],
};

const COMPANY_PROVIDES_TOKENS = new Set([
  '包吃',
  '包住',
  '公司提供',
  '提供员工餐',
  '提供工作餐',
  '提供宿舍',
  '免费住宿',
  '免费工作餐',
  '免费午餐',
  '免费晚餐',
  '公司购买',
  '公司缴纳',
  '公司承担',
]);
const SELF_OR_NONE_TOKENS = new Set([
  '不包吃',
  '不包住',
  '员工自理',
  '自理',
  '无',
  '没有',
  '不购买',
  '不提供',
  '不缴纳',
  '不承担',
]);

function classifyWelfareValue(raw: unknown, hasAllowance: boolean): WelfareKind {
  if (raw === null || raw === undefined) {
    return hasAllowance ? 'allowance' : 'unspecified';
  }
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    return hasAllowance ? 'allowance' : 'unspecified';
  }

  // 完全匹配优先
  if (COMPANY_PROVIDES_TOKENS.has(text)) return 'company';
  if (SELF_OR_NONE_TOKENS.has(text)) {
    // 写"员工自理 / 不包吃" 但同时给了餐补/房补 → 视为补贴
    return hasAllowance ? 'allowance' : 'self_or_none';
  }

  // 负向优先：sponge 实际用 "无餐饮福利"/"无住宿福利"/"独立日不购买" 这类完整描述串，
  // 必须在正向 "购买" 命中前先判否定（否则 "不购买" 会被 "购买" 误判为公司提供）。
  if (/^无|^没有|不包|员工自理|不(购买|提供|缴纳|承担)/.test(text)) {
    return hasAllowance ? 'allowance' : 'self_or_none';
  }
  // 仅补贴：catering/accommodation 取值 "餐饮补贴"/"住宿补贴"
  if (/补贴/.test(text)) {
    return 'allowance';
  }
  // 正向：包吃/包住、公司或"独立日/独立客"(本公司)购买/缴纳社保保险、免费餐宿
  if (
    /(包吃|包住|(公司|独立[日客])(提供|购买|缴纳|承担)|购买|缴纳|免费(工作|员工)?餐|免费住宿)/.test(
      text,
    )
  ) {
    return 'company';
  }
  return hasAllowance ? 'allowance' : 'unspecified';
}

function hasNumericAllowance(...values: unknown[]): boolean {
  return values.some((v) => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'number') return !Number.isNaN(v) && v > 0;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (!trimmed) return false;
      // 数字字符串或形如 "500 元/月"
      return /\d/.test(trimmed);
    }
    return false;
  });
}

/**
 * 顶层入口：从 raw job.welfare 派生 WelfareFacts。
 *
 * 对 raw 结构容忍——任一字段类型异常都退化为 'unspecified'/false，不抛错。
 */
export function extractWelfareFacts(welfare: unknown): WelfareFacts {
  if (!welfare || typeof welfare !== 'object') return { ...EMPTY_WELFARE_FACTS };
  const w = welfare as any;

  const cateringAllowance = hasNumericAllowance(w.cateringSalary);
  const accommodationAllowance = hasNumericAllowance(w.accommodationAllowance);
  const trafficAllowance = hasNumericAllowance(w.trafficAllowanceSalary);

  const otherWelfareItems = Array.isArray(w.otherWelfare)
    ? w.otherWelfare
        .map((item: unknown) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item: string) => item.length > 0)
    : [];

  return {
    meals: classifyWelfareValue(w.catering, cateringAllowance),
    accommodation: classifyWelfareValue(w.accommodation, accommodationAllowance),
    insurance: classifyWelfareValue(w.haveInsurance, false),
    hasTrafficAllowance: trafficAllowance,
    hasPromotionWelfare:
      typeof w.promotionWelfare === 'string' && w.promotionWelfare.trim().length > 0,
    otherWelfareItems,
  };
}

const KIND_LABEL: Record<WelfareKind, string> = {
  company: '✅ 公司提供',
  allowance: '💵 仅给补贴（不直接提供）',
  self_or_none: '❌ 无（员工自理 / 公司不提供）',
  unspecified: '❓ 未明确',
};

const INSURANCE_LABEL: Record<WelfareKind, string> = {
  company: '内部事实：公司购买（敏感，禁止主动提及）',
  allowance: '内部事实：仅补贴（敏感，禁止主动提及）',
  self_or_none: '内部事实：无（敏感，禁止主动提及）',
  unspecified: '未明确（敏感，禁止主动提及）',
};

/**
 * 把 WelfareFacts 渲染成给 Agent 看的紧凑速览——把"员工自理/不购买"这类
 * 易被压缩成"有"的字面值，显式标注为 ❌ 无；把工具未提的字段标 ❓ 未明确，
 * 让 Agent 不要编造工具没返回的福利项。
 *
 * 返回空字符串表示 welfare 块整个为空，上层不渲染。
 */
export function renderWelfareFactsBanner(facts: WelfareFacts): string {
  // 至少有一个字段被明确表达过才输出 banner（全 unspecified 不污染上下文）
  const hasAnySignal =
    facts.meals !== 'unspecified' ||
    facts.accommodation !== 'unspecified' ||
    facts.insurance !== 'unspecified' ||
    facts.hasTrafficAllowance ||
    facts.hasPromotionWelfare ||
    facts.otherWelfareItems.length > 0;
  if (!hasAnySignal) return '';

  const lines: string[] = [];
  lines.push(
    '> 🎁 **福利字段速览**（reply 时只能主动引用员工餐/住宿/交通补贴/晋升/其它福利里的"✅ 公司提供"和"💵 仅补贴"项目；"❌ 无"项目不得包装成"有"；保险/社保严禁主动提及）',
  );
  lines.push(`> - 员工餐：${KIND_LABEL[facts.meals]}`);
  lines.push(`> - 住宿：${KIND_LABEL[facts.accommodation]}`);
  lines.push(`> - 保险（敏感，仅候选人主动问时可答）：${INSURANCE_LABEL[facts.insurance]}`);
  lines.push(`> - 交通补贴：${facts.hasTrafficAllowance ? '💵 有' : '❓ 未明确'}`);
  if (facts.hasPromotionWelfare) {
    lines.push('> - 晋升福利：✅ 有说明');
  }
  if (facts.otherWelfareItems.length > 0) {
    lines.push(`> - 其它福利：${facts.otherWelfareItems.join('、')}`);
  }
  lines.push('');
  lines.push('');
  return lines.join('\n');
}

/* eslint-enable @typescript-eslint/no-explicit-any */
