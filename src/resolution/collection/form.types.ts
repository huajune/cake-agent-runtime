/**
 * 收资表单状态机的类型全集（`docs/architecture/collection-form-machine.md` §2）。
 *
 * 定位：**事务底稿**——per（候选人 × jobId）的持久实体，有终点、办结封存。它与记忆
 * 的分界（总纲「表单与记忆系统的边界」）是「岗位要什么归表单，人是什么样归记忆」。
 *
 * 本文件零 IO、零 LLM、零依赖，只声明形状；改表的唯一途径在 ./form-writes.ts。
 *
 * 封闭集纪律（蓝图 §0）：`SlotState` 三值、`Verdict` 五值是地板——每个值对应一种
 * 互不相同的 Agent 行为。加新值必须先回答"哪个既有值的处理逻辑覆盖不了它"，
 * 答不上来不许加。
 */

import type { CandidateFactProducer } from '@resolution/evidence/claim.types';

// ==================== 契约字段定义（收资域内部型） ====================

/**
 * 报名筛选标签契约的字段定义——**收资域内部型**。
 *
 * 与 `@sponge/collection-contract.types` 的关系：那边是**线上 DTO**（字段名随后端走），
 * 这边是**判决用的域内型**，由 `fromContractField()` 单向映射。判决逻辑只认这一型——
 * 外部 DTO 改字段名不该让整个收资域返工。
 *
 * 形状依据：2026-08-20 生产实测 9 岗 27 标签，九项字段恒定齐全。
 */
export interface ContractFieldDef {
  /** 海绵侧标签主键。⚠️ D4：字面量只可出现在测试与文档，禁止进 src/ 代码作语义锚点。 */
  labelId: number;
  /** 标签展示名（如「姓名」「有无本地健康证」）。applyErrorList 只带展示名时的匹配基准（D2）。 */
  labelTitle: string;
  /** 后台配的填写说明；实测多数为 null。 */
  labelInstructions?: string | null;
  fieldType: ContractFieldType;
  /**
   * 契约给的披露级别（0820 落地）。`RESTRICTED` = 不合格原因绝不能告诉候选人。
   * ⚠️ 它是披露判决的**输入之一而非全部**：专业族后端承诺补标但尚未落地（实测仍 PLAIN），
   * 故 `disclosure-policy` 的红线词表兜底与它并行，且红线压过契约的 PLAIN。
   */
  disclosure?: ContractDisclosureLevel;
  /** 是否必填（实测恒 true）。契约没带按「返回即须收」。 */
  required: boolean;
  /** 选项型字段的可选值；命中即合格。TEXT 型为空数组。 */
  acceptedOptions: ContractOption[];
  /** 命中即**当轮不合格**（先筛后收）。 */
  rejectedOptions: ContractOption[];
  /**
   * 值域筛（年龄/身高/体重）。判决零第二源：契约没带 = 该岗没有这道筛。
   * 实测两种承载：顶层 min/max（年龄），或 genderRanges 分性别（身高体重）。
   */
  valueSpec?: ContractValueRange | null;
  /**
   * 契约的**语义标记**：身份核槽位（姓名/手机号/年龄/性别）由它识别，不由 labelId 识别。
   * ⚠️ 0820 实测**尚未进契约**（后端承诺改）——落地前由适配器按环境级配置 +
   * labelTitle 每轮核验补齐，核验不过告警并降通用道。
   * 代码任何地方都不得硬编码 769/770/687/771（D4）。
   */
  systemField?: IdentitySlotKey;
}

/** 实测四种：TEXT / SINGLE_OPTION / MULTIPLE_OPTION / FILE。 */
export type ContractFieldType = 'TEXT' | 'SINGLE_OPTION' | 'MULTIPLE_OPTION' | 'FILE';

export type ContractDisclosureLevel = 'PLAIN' | 'RESTRICTED';

export interface ContractOption {
  optionCode: string;
  optionLabel: string;
}

/** 分性别值域项（实测 528995 身高/体重）。 */
export interface ContractGenderRangeDef {
  gender: 'MALE' | 'FEMALE';
  min?: number | null;
  max?: number | null;
}

export interface ContractValueRange {
  kind: string;
  min?: number | null;
  max?: number | null;
  unit?: string | null;
  /** 非空时按性别取区间；性别未知则该值域**不参与判决**（见 resolveValueRange）。 */
  genderRanges: ContractGenderRangeDef[];
}

/**
 * 取该字段对某性别生效的数值区间；不适用则返回 null（= 本字段这一轮不判值域）。
 *
 * genderRanges 非空且性别未知 → 不判。这是刻意的漏斗优先取舍：拿不准就放过，
 * 下游 entryUser 会用 applyErrorList 截回来；反过来"猜个性别再判"会把人筛错，代价不对称。
 */
export function resolveValueRange(
  spec: ContractValueRange | null | undefined,
  gender: 'MALE' | 'FEMALE' | null,
): { min: number | null; max: number | null } | null {
  if (!spec) return null;
  if (spec.genderRanges.length > 0) {
    if (!gender) return null;
    const matched = spec.genderRanges.find((range) => range.gender === gender);
    return matched ? { min: matched.min ?? null, max: matched.max ?? null } : null;
  }
  if (spec.min == null && spec.max == null) return null;
  return { min: spec.min ?? null, max: spec.max ?? null };
}

/**
 * 身份核槽位的语义键。四槽在基线里 468/468 全覆盖，是 booking payload 的必填部分，
 * 也是唯一挂额外写守卫（真名闸/手机号出处闸/年龄边界）的槽位族。
 */
export type IdentitySlotKey = 'name' | 'phone' | 'age' | 'gender';

// ==================== 槽位 ====================

/**
 * 槽位状态（封闭集）。三值各自对应一种互不相同的 Agent 行为：
 * - `empty`：本轮要问它；
 * - `filled`：**任何路径不得再问**（反复问的类型级根治）；
 * - `disqualified`：本岗筛掉了，停止收资、走 rejection-renderer。
 *
 * 刻意**没有** `pending_confirm` / `confirmed`（0818 瘦身裁定）：针对性问答即采信，
 * 复述只在提交前发一次，"不对"→改格子。听错/抽错由写入公证的 sourceText 回查拦在写入时。
 */
export type SlotState = 'empty' | 'filled' | 'disqualified';

/**
 * 置信度：**代码按证据形态授予，不是模型自报**（宪法 P11）。
 * - `high`：候选人原话逐字支持，且经既有解析器复算等价；
 * - `medium`：原话支持但值经归一化/选项匹配得来，回查不到逐字等价。
 */
export type SlotConfidence = 'high' | 'medium';

export interface SlotValue {
  /** 归一化后的值（TEXT 型的展示值；选项型为选项标签）。 */
  value: string;
  /** 选项型字段命中的 optionCode 清单；TEXT/FILE 型不带。 */
  optionCodes?: string[];
  /** 候选人原话逐字片段——公证回查锚点，臆造防线的地基。 */
  sourceText: string;
  /** 全库唯一「谁说的」词表（`@resolution/evidence/claim.types`），署名如实，禁 system 冒名。 */
  producer: CandidateFactProducer;
  confidence: SlotConfidence;
}

export interface FormSlot {
  labelId: number;
  /** 契约映射后的身份语义标记；随表单封存，供无契约参数的纯写函数精确定位。 */
  systemField?: IdentitySlotKey;
  state: SlotState;
  /** `filled` 必有值；`disqualified` 带触发不合格的那个值；`empty` 无值。 */
  value?: SlotValue;
  /** 已就该槽位发问的次数。≥2 仍 empty → 表级 escalatedReason（熔断，第 3 问不存在）。 */
  askCount: number;
}

// ==================== 表单实体 ====================

export interface ConfigDebt {
  labelId: number;
  /** 自由文本一行账（不建枚举——受阻 8 形态降级为运营沟通的分析语言，蓝图 §0）。 */
  note: string;
}

/** 提交前复述在案：候选人回「不对」时靠它定位改哪格。 */
export interface RecapRecord {
  labelIds: number[];
}

export interface BookingCollectionForm {
  /**
   * 人键（D1）：phone 槽位值归一 11 位，与海绵人键同源。
   * 手机号未知期取 `SESSION_CANDIDATE_REF`，到达时由 service 层 rebind。
   */
  candidateRef: string;
  jobId: number;
  /** 以 labelId 为键的槽位表。 */
  slots: Record<number, FormSlot>;
  /** 提交成功的外部事实（不可由槽位推导，故落盘）。 */
  workOrderId?: number;
  /** 转人工触发原因（同槽 2 问不中 / 疑似多人 / applyErrorList 失配）。不可推导，故落盘。 */
  escalatedReason?: string;
  lastRecap?: RecapRecord;
  /** 配置债台账，报名成功卡片的「收资配置备注」段直读。 */
  configDebts?: ConfigDebt[];
}

/** 手机号到达前的默认表单人键。 */
export const SESSION_CANDIDATE_REF = 'session';

// ==================== 总评（现算，不落盘） ====================

/**
 * 表单总评（封闭集）。五值各自对应一种 Agent 行为：
 * collecting=问 empty 槽位 / disqualified=走 rejection-renderer / ready=发提交前复述 /
 * escalated=静默转人工 / submitted=停手。
 */
export type Verdict = 'collecting' | 'disqualified' | 'ready' | 'escalated' | 'submitted';

/**
 * 总评现算——**不落盘任何可推导状态**。这一条消灭"槽位与总评分裂"整类同步 bug
 * （蓝图 §0）。判定优先级即代码顺序：已提交 > 已转人工 > 不合格 > 收资中 > 待提交。
 */
export function verdictOf(form: BookingCollectionForm): Verdict {
  if (form.workOrderId !== undefined) return 'submitted';
  if (form.escalatedReason) return 'escalated';
  const slots = Object.values(form.slots);
  if (slots.some((slot) => slot.state === 'disqualified')) return 'disqualified';
  if (slots.some((slot) => slot.state === 'empty')) return 'collecting';
  return 'ready';
}

/** 空表单：契约字段集逐一开槽，全部 empty。 */
export function createForm(params: {
  candidateRef?: string;
  jobId: number;
  contract: readonly ContractFieldDef[];
}): BookingCollectionForm {
  const slots: Record<number, FormSlot> = {};
  for (const field of params.contract) {
    slots[field.labelId] = {
      labelId: field.labelId,
      ...(field.systemField ? { systemField: field.systemField } : {}),
      state: 'empty',
      askCount: 0,
    };
  }
  return {
    candidateRef: params.candidateRef ?? SESSION_CANDIDATE_REF,
    jobId: params.jobId,
    slots,
  };
}

/**
 * 该字段是否**带筛选条件**——答错会把候选人筛掉，而不只是登记一笔。
 *
 * 判据来自契约本身，不猜：有 `rejectedOptions`（选项筛）或有生效的 `valueSpec`
 * （值域筛）就是带筛的；两者都没有就是纯登记项。
 *
 * ⚠️ 这**不影响收不收**——`required` 实测恒 true，契约返回什么就全收（0820 用户确认：
 * "就是真的必填，只是这些必填有的是收集项，有的有筛选条件"）。它影响的是**顺序**：
 * 一次要填 8-12 格时，会筛人的那几格必须排在登记项前面。否则候选人填到第 9 格才被
 * 健康证筛掉，前 8 格白填、我们也白问——先筛后收在**发问顺序**上的兑现。
 */
export function carriesScreening(field: ContractFieldDef): boolean {
  if (field.rejectedOptions.length > 0) return true;
  const spec = field.valueSpec;
  if (!spec) return false;
  return spec.min != null || spec.max != null || spec.genderRanges.length > 0;
}

/**
 * 发问顺序：身份四槽 → 带筛选条件的 → 纯登记项。
 *
 * 身份核排头不是为了筛（它们通常不筛），是因为"你叫什么、电话多少"是收资最自然的
 * 开场；把「有无本地健康证」顶到姓名前面读起来像盘问。身份之后紧跟筛选项，
 * 让会否决的判据尽早拿到答案。
 */
export function orderForAsking(contract: readonly ContractFieldDef[]): ContractFieldDef[] {
  const rank = (field: ContractFieldDef): number => {
    if (field.systemField) return 0;
    return carriesScreening(field) ? 1 : 2;
  };
  // 稳定排序：同档内保持契约原序，不引入额外的顺序意见。
  return [...contract].sort((left, right) => rank(left) - rank(right));
}

/**
 * 降级为渐进收资时的起手字段（蓝图允许的两种降级：collectionStrategy=progressive、
 * 候选人已表现抗拒）。取身份核 + 带筛选条件的——降负担不能降成"问了一堆登记项、
 * 筛人的那几个还没问"，那样候选人填完两轮才被拒，比一次问完更糟。
 */
export function starterFields(contract: readonly ContractFieldDef[]): ContractFieldDef[] {
  return contract.filter((field) => field.systemField || carriesScreening(field));
}

/** 仍需发问的槽位（按契约顺序，调用方决定本轮问几个）。 */
export function emptySlotIds(
  form: BookingCollectionForm,
  contract: readonly ContractFieldDef[],
): number[] {
  return contract
    .filter((field) => form.slots[field.labelId]?.state === 'empty')
    .map((field) => field.labelId);
}

/** 已填槽位（提交前复述与 booking payload 的取数口）。 */
export function filledSlotIds(
  form: BookingCollectionForm,
  contract: readonly ContractFieldDef[],
): number[] {
  return contract
    .filter((field) => form.slots[field.labelId]?.state === 'filled')
    .map((field) => field.labelId);
}
