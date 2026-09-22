/**
 * 飞书清单单选选项配色。
 *
 * 飞书 task/v2 的选项 `color_index` 取值 0–54，每 5 个一组同色相，组内序号 0 最浅；
 * 本模块一律取每组最浅档（低饱和浅色）。同一介入大类与其名下的原因码同色，
 * 大类名与 T 编号的对应取自 `CATEGORY_META`，原因码所属大类取自权威目录 `HANDOFF_REASON_CATALOG`，
 * 这里不维护任何字面副本。
 */

import { HANDOFF_REASON_CATALOG } from '@enums/handoff-reason.enum';
import {
  CATEGORY_META,
  PRIORITY_LABELS,
  type InterventionTaskCategory,
} from './intervention-task-category';
import type { FieldKey } from './intervention-task.service';

/** 每个色相组最浅一档的 color_index。 */
export const FEISHU_OPTION_COLOR = {
  red: 0,
  orange: 5,
  yellow: 10,
  green: 15,
  teal: 20,
  cyan: 25,
  blue: 30,
  indigo: 35,
  purple: 40,
  pink: 45,
  gray: 50,
} as const;

export type FeishuOptionColorName = keyof typeof FEISHU_OPTION_COLOR;

/** 介入大类 → 色相；原因码跟随所属大类。 */
export const CATEGORY_COLOR: Record<InterventionTaskCategory, FeishuOptionColorName> = {
  T1: 'red',
  T2: 'orange',
  T3: 'yellow',
  T4: 'green',
  T5: 'teal',
  T6: 'blue',
  T7: 'purple',
  T8: 'indigo',
  UNCLASSIFIED: 'gray',
};

const PRIORITY_COLOR: Readonly<Record<string, FeishuOptionColorName>> = {
  [PRIORITY_LABELS.urgent]: 'red',
  [PRIORITY_LABELS.today]: 'orange',
  [PRIORITY_LABELS.normal]: 'gray',
};

/** 「状态」选项配色；键集须与 `BACKFILL_FIELD_OPTIONS.status` 一致（单测守门）。 */
export const STATUS_OPTION_COLOR: Readonly<Record<string, FeishuOptionColorName>> = {
  待处理: 'orange',
  已处理: 'green',
};

/** 「本可由蛋糕完成」选项配色；键集须与 `BACKFILL_FIELD_OPTIONS.couldBeAutomated` 一致。 */
export const COULD_BE_AUTOMATED_OPTION_COLOR: Readonly<Record<string, FeishuOptionColorName>> = {
  是: 'green',
  否: 'gray',
};

const CATEGORY_BY_LABEL: ReadonlyMap<string, InterventionTaskCategory> = new Map(
  (Object.keys(CATEGORY_META) as InterventionTaskCategory[]).map((code) => [
    CATEGORY_META[code].label,
    code,
  ]),
);

/** 原因码中文标签 → 大类（目录里 `category: null` 的 `other` 与入站风险类各归其位，风险类目录已标 T7）。 */
const CATEGORY_BY_REASON_LABEL: ReadonlyMap<string, InterventionTaskCategory> = new Map(
  HANDOFF_REASON_CATALOG.map((item) => [item.label, item.category ?? 'UNCLASSIFIED']),
);

/**
 * 字段 + 选项名 → color_index。未知字段或未知选项一律 gray。
 */
export function resolveOptionColorIndex(fieldKey: FieldKey, optionName: string): number {
  return FEISHU_OPTION_COLOR[resolveOptionColorName(fieldKey, optionName)];
}

export function resolveOptionColorName(
  fieldKey: FieldKey,
  optionName: string,
): FeishuOptionColorName {
  switch (fieldKey) {
    case 'category': {
      const category = CATEGORY_BY_LABEL.get(optionName);
      return category ? CATEGORY_COLOR[category] : 'gray';
    }
    case 'reasonCode': {
      const category = CATEGORY_BY_REASON_LABEL.get(optionName);
      return category ? CATEGORY_COLOR[category] : 'gray';
    }
    case 'priority':
      return PRIORITY_COLOR[optionName] ?? 'gray';
    case 'status':
      return STATUS_OPTION_COLOR[optionName] ?? 'gray';
    case 'couldBeAutomated':
      return COULD_BE_AUTOMATED_OPTION_COLOR[optionName] ?? 'gray';
    case 'hostingAccount':
      return 'blue';
    default:
      return 'gray';
  }
}
