/**
 * 收资表单状态机的类型全集（`docs/todo/collection-form-machine-implementation.md` §2）。
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

// ==================== 契约字段定义（内部临时型） ====================

/**
 * 报名筛选标签契约的字段定义。
 *
 * ⚠️ **本型是内部临时型**：形状照 `docs/todo/label-baseline-20260818.json.gz` 的生产
 * 实测基线（468/468 岗位全量拉取）抄写，加上 0818 与后端约定要补的三个判决要素
 * （`systemField` / `minAge` / `maxAge`）。**0819 契约 v2 spec 到货后，由
 * `sponge/collection-contract.types.ts` 的 DTO 映射到本型，本型不动**——收资域的判决
 * 逻辑不应随外部 DTO 字段重命名而返工。
 *
 * 基线实测形状：labelId / labelTitle / labelInstructions / fieldType /
 * acceptedOptions / rejectedOptions。
 */
export interface ContractFieldDef {
  /** 海绵侧标签主键。⚠️ D4：字面量只可出现在测试与文档，禁止进 src/ 代码作语义锚点。 */
  labelId: number;
  /** 标签展示名（如「姓名」「有无本地健康证」）。errorList 只带展示名时的匹配基准（D2）。 */
  labelTitle: string;
  /** 后台配的填写说明；基线实测 109 个标签里仅 22 处有值。 */
  labelInstructions?: string | null;
  fieldType: ContractFieldType;
  /** 选项型字段的可选值；命中即合格。TEXT 型为空数组。 */
  acceptedOptions: ContractOption[];
  /** 命中即**当轮不合格**（先筛后收）。基线实测 94 处在用。 */
  rejectedOptions: ContractOption[];
  /**
   * 契约的**语义标记**：身份核槽位（姓名/手机号/年龄/性别）由它识别，不由 labelId 识别。
   * 0818 用户裁定 D4：labelId/optionCode 是海绵数据库主键，不是语义，测试与生产环境
   * 可能不同号。契约标记缺席期的兜底见 `adapters/adapter.registry.ts`。
   */
  systemField?: IdentitySlotKey;
  /** 年龄值域下限（0818 约定进契约）。判决零第二源：契约没带 = 该岗没有这道筛。 */
  minAge?: number | null;
  /** 年龄值域上限。 */
  maxAge?: number | null;
}

/** 基线实测四种：TEXT 2820 / SINGLE_OPTION 1023 / MULTIPLE_OPTION 5 / FILE 9。 */
export type ContractFieldType = 'TEXT' | 'SINGLE_OPTION' | 'MULTIPLE_OPTION' | 'FILE';

export interface ContractOption {
  optionCode: string;
  optionLabel: string;
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
  /** 转人工触发原因（同槽 2 问不中 / 疑似多人 / errorList 失配）。不可推导，故落盘。 */
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
    slots[field.labelId] = { labelId: field.labelId, state: 'empty', askCount: 0 };
  }
  return {
    candidateRef: params.candidateRef ?? SESSION_CANDIDATE_REF,
    jobId: params.jobId,
    slots,
  };
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
