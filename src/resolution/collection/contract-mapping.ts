/**
 * 线上契约 DTO → 收资域内部型的**单向映射**，含身份四槽的识别（本域唯一识别点）。
 *
 * 为什么要一层映射：`@sponge/collection-contract.types` 的字段名随后端走，收资域的
 * 判决逻辑不该随之返工。映射是唯一的耦合点，后端改名只动这一个文件。
 *
 * **身份识别机制**（0826 裁定：后端 systemField 诉求废弃，本机制由兜底转正）：
 * 身份四槽由「环境级配置的 labelId 锚点 + 每轮拿实时契约核验 labelTitle」识别——
 * ID 定位、语义由标题核验背书；核验不过即**告警并降通用道**（身份闸门不挂、
 * 人键回退 session，漏斗优先不卡报名）。ID 只进环境配置不进代码（D4 仍有效）。
 */

import type { ContractField, JobCollectionContract } from '@sponge/collection-contract.types';
import type { CandidateFactField } from '@resolution/candidate/types';
import type { ContractFieldDef, IdentitySlotKey } from './form.types';

/**
 * 数值族标题判据（词面判定，不认 ID）：身高/体重不是身份槽，但值有单位与量纲，
 * 落槽前要走同一套规范形（去 cm/kg、斤→kg），否则"体重 122"会原样进 `体重(kg)`。
 * 只认标题开头，"体重要求"类说明列不会误命中。
 */
const NUMERIC_TITLE_PATTERNS: ReadonlyArray<{ field: CandidateFactField; test: RegExp }> = [
  { field: 'height', test: /^身高/u },
  { field: 'weight', test: /^体重/u },
];

export function numericFactFieldForTitle(title: string): CandidateFactField | null {
  const trimmed = title.trim();
  return NUMERIC_TITLE_PATTERNS.find((pattern) => pattern.test.test(trimmed))?.field ?? null;
}

/** 身份四槽的**标题语义判据**——核验 ID 锚点是否名副其实，也是无锚点时的唯一识别路径。 */
const IDENTITY_TITLE_PATTERNS: ReadonlyArray<{ key: IdentitySlotKey; test: RegExp }> = [
  { key: 'name', test: /^(?:姓名|真实姓名|候选人姓名|名字)$/u },
  { key: 'phone', test: /^(?:手机号|手机号码|联系电话|联系方式|电话)$/u },
  { key: 'age', test: /^(?:年龄|周岁)$/u },
  { key: 'gender', test: /^(?:性别)$/u },
];

/**
 * 标题 → 身份槽位键的查询口。词表唯一居所在本文件（IDENTITY_TITLE_PATTERNS），
 * 收资运输层的标题第三级回退（proposal-intake 的 findFieldByTitle）复用本函数，
 * 禁止在别处复制词条。入参须已 trim/归一化；正则一律 `^…$` 全匹配，
 * 「电话费报销」这类包含式命中不会误判。
 */
export function identitySlotKeyForTitle(title: string): IdentitySlotKey | null {
  return IDENTITY_TITLE_PATTERNS.find((pattern) => pattern.test.test(title))?.key ?? null;
}

/** 环境级 labelId 锚点配置（`COLLECTION_IDENTITY_LABEL_IDS`，形如 `name:769,phone:770`）。 */
export interface IdentityAnchorConfig {
  anchors: ReadonlyMap<number, IdentitySlotKey>;
}

/**
 * 解析环境级锚点配置。**故意不给默认值**：没配就纯走标题语义，不在代码里留
 * 769/770 这类字面量（D4）。格式非法的条目跳过，不让一条脏配置搞挂整轮收资。
 */
export function parseIdentityAnchors(raw: string | undefined | null): IdentityAnchorConfig {
  const anchors = new Map<number, IdentitySlotKey>();
  for (const entry of (raw ?? '').split(',')) {
    const [key, id] = entry.split(':').map((part) => part?.trim());
    const labelId = Number(id);
    if (!key || !Number.isInteger(labelId)) continue;
    if (key === 'name' || key === 'phone' || key === 'age' || key === 'gender') {
      anchors.set(labelId, key);
    }
  }
  return { anchors };
}

export interface IdentityResolution {
  systemField?: IdentitySlotKey;
  /** 锚点与标题对不上——ID 漂了。调用方据此告警并把该槽降为通用道。 */
  anchorMismatch?: { labelId: number; expected: IdentitySlotKey; labelTitle: string };
}

/**
 * 判定单个契约字段是不是身份槽位。
 *
 * 判据：标题语义为准，labelId 锚点做核验（契约不带语义标记——原 systemField 诉求
 * 0826 已废弃）。**锚点单独不足以定身份**：配置说 769 是姓名、契约里 769 的标题却是
 * 「紧急联系人」，那是标签表重建后的静默断链——正是 D4 撤回"把 ID 写进文档"诉求时
 * 点名要防的事故。此时不认身份、返回 mismatch 让调用方告警。
 */
export function resolveIdentityKey(
  field: ContractField,
  config: IdentityAnchorConfig,
): IdentityResolution {
  const title = field.labelTitle.trim();
  const byTitle = identitySlotKeyForTitle(title) ?? undefined;
  const byAnchor = config.anchors.get(field.labelId);

  if (byAnchor && byTitle && byAnchor !== byTitle) {
    return { anchorMismatch: { labelId: field.labelId, expected: byAnchor, labelTitle: title } };
  }
  if (byAnchor && !byTitle) {
    return { anchorMismatch: { labelId: field.labelId, expected: byAnchor, labelTitle: title } };
  }
  return byTitle ? { systemField: byTitle } : {};
}

export interface ContractMappingResult {
  fields: ContractFieldDef[];
  /** 锚点核验不过的清单，调用方逐条告警（这批槽位已降为通用道）。 */
  anchorMismatches: NonNullable<IdentityResolution['anchorMismatch']>[];
}

export function mapContractFields(
  contract: JobCollectionContract,
  config: IdentityAnchorConfig,
): ContractMappingResult {
  const fields: ContractFieldDef[] = [];
  const anchorMismatches: NonNullable<IdentityResolution['anchorMismatch']>[] = [];

  for (const field of contract.fields) {
    const identity = resolveIdentityKey(field, config);
    if (identity.anchorMismatch) anchorMismatches.push(identity.anchorMismatch);
    fields.push({
      labelId: field.labelId,
      labelTitle: field.labelTitle,
      labelInstructions: field.labelInstructions ?? null,
      fieldType: field.fieldType,
      disclosure: field.disclosure,
      required: field.required,
      acceptedOptions: field.acceptedOptions,
      rejectedOptions: field.rejectedOptions,
      valueSpec: field.valueSpec
        ? {
            kind: field.valueSpec.kind,
            min: field.valueSpec.min ?? null,
            max: field.valueSpec.max ?? null,
            unit: field.valueSpec.unit ?? null,
            genderRanges: field.valueSpec.genderRanges.map((range) => ({
              gender: range.gender,
              min: range.min ?? null,
              max: range.max ?? null,
            })),
          }
        : null,
      ...(identity.systemField ? { systemField: identity.systemField } : {}),
    });
  }

  return { fields, anchorMismatches };
}
