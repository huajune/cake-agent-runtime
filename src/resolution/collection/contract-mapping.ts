/**
 * 线上契约 DTO → 收资域内部型的**单向映射**，外加 systemField 缺席期的身份识别兜底。
 *
 * 为什么要一层映射：`@sponge/collection-contract.types` 的字段名随后端走，收资域的
 * 判决逻辑不该随之返工。映射是唯一的耦合点，后端改名只动这一个文件。
 *
 * ⚠️ **身份识别兜底**（D4 + 契约诉求 #3）：0820 实测契约**尚未带 systemField**
 * （后端承诺改）。落地前身份四槽靠「环境级配置的 labelId 锚点 + 每轮拿实时契约核验
 * labelTitle」补齐——ID 只做加速，语义由标题核验背书；核验不过即**告警并降通用道**
 * （身份闸门不挂、人键回退 session，漏斗优先不卡报名）。
 * 契约带上 systemField 后本兜底自动让位，无需改代码。
 */

import type { ContractField, JobCollectionContract } from '@sponge/collection-contract.types';
import type { ContractFieldDef, IdentitySlotKey } from './form.types';

/** 身份四槽的**标题语义判据**——核验 ID 锚点是否名副其实，也是无锚点时的唯一识别路径。 */
const IDENTITY_TITLE_PATTERNS: ReadonlyArray<{ key: IdentitySlotKey; test: RegExp }> = [
  { key: 'name', test: /^(?:姓名|真实姓名|候选人姓名|名字)$/u },
  { key: 'phone', test: /^(?:手机号|手机号码|联系电话|联系方式|电话)$/u },
  { key: 'age', test: /^(?:年龄|周岁)$/u },
  { key: 'gender', test: /^(?:性别)$/u },
];

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
 * 优先级：契约 systemField（后端补上后的权威）> 标题语义 > 环境锚点核验。
 * **锚点单独不足以定身份**：配置说 769 是姓名、契约里 769 的标题却是「紧急联系人」，
 * 那是标签表重建后的静默断链——正是 D4 撤回"把 ID 写进文档"诉求时点名要防的事故。
 * 此时不认身份、返回 mismatch 让调用方告警。
 */
export function resolveIdentityKey(
  field: ContractField,
  config: IdentityAnchorConfig,
): IdentityResolution {
  if (field.systemField) return { systemField: field.systemField };

  const title = field.labelTitle.trim();
  const byTitle = IDENTITY_TITLE_PATTERNS.find((pattern) => pattern.test.test(title))?.key;
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
