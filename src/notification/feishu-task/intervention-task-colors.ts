/**
 * 飞书清单单选选项配色。
 *
 * 飞书 task/v2 的选项 `color_index` 取值 0–54，每 5 个一组同色相，组内序号 0 最浅；
 * `FEISHU_OPTION_COLOR` 只登记每组组首（最浅档），需要组内更深一档时用 `shade(color, step)`。
 * 同一介入大类与其名下的原因码同色：大类名与 T 编号的对应取自 `CATEGORY_META`，
 * 原因码所属大类取自权威目录 `HANDOFF_REASON_CATALOG`，这里不维护任何字面副本。
 * 状态 / 优先级的具体档位按运营在飞书里手调的值固定。
 */

import { HANDOFF_REASON_CATALOG } from '@enums/handoff-reason.enum';
import {
  CATEGORY_META,
  PRIORITY_LABELS,
  type InterventionTaskCategory,
} from './intervention-task-category';
import type { FieldKey } from './intervention-task.service';

/** 每个色相组组首（最浅一档）的 color_index。 */
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

/** 组内深浅档位：0 最浅 … 4 最深（gray 组只到 54，即 step ≤ 4）。 */
export type FeishuOptionColorStep = 0 | 1 | 2 | 3 | 4;

/** 同色相组内取第 step 档：shade('teal', 1) → 21。 */
export function shade(color: FeishuOptionColorName, step: FeishuOptionColorStep): number {
  return FEISHU_OPTION_COLOR[color] + step;
}

/** 介入大类 → 色相（组首）；原因码跟随所属大类。 */
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

/** 优先级：急取红组第 3 档（较深）、当日取红组最浅、常规灰。 */
export const PRIORITY_OPTION_COLOR: Readonly<Record<string, number>> = {
  [PRIORITY_LABELS.urgent]: shade('red', 3),
  [PRIORITY_LABELS.today]: FEISHU_OPTION_COLOR.red,
  [PRIORITY_LABELS.normal]: FEISHU_OPTION_COLOR.gray,
};

/** 「状态」选项配色；键集须与 `BACKFILL_FIELD_OPTIONS.status` 一致（单测守门）。 */
export const STATUS_OPTION_COLOR: Readonly<Record<string, number>> = {
  待处理: FEISHU_OPTION_COLOR.orange,
  已处理: shade('teal', 1),
};

const CATEGORY_BY_LABEL: ReadonlyMap<string, InterventionTaskCategory> = new Map(
  (Object.keys(CATEGORY_META) as InterventionTaskCategory[]).map((code) => [
    CATEGORY_META[code].label,
    code,
  ]),
);

/** 原因码中文标签 → 大类（目录里 `category: null` 的 `other` 归未归类；入站风险类目录已标 T7）。 */
const CATEGORY_BY_REASON_LABEL: ReadonlyMap<string, InterventionTaskCategory> = new Map(
  HANDOFF_REASON_CATALOG.map((item) => [item.label, item.category ?? 'UNCLASSIFIED']),
);

/**
 * 字段 + 选项名 → color_index。未知字段或未知选项一律 gray（组首 50）。
 */
export function resolveOptionColorIndex(fieldKey: FieldKey, optionName: string): number {
  switch (fieldKey) {
    case 'category': {
      const category = CATEGORY_BY_LABEL.get(optionName);
      return category ? FEISHU_OPTION_COLOR[CATEGORY_COLOR[category]] : FEISHU_OPTION_COLOR.gray;
    }
    case 'reasonCode': {
      const category = CATEGORY_BY_REASON_LABEL.get(optionName);
      return category ? FEISHU_OPTION_COLOR[CATEGORY_COLOR[category]] : FEISHU_OPTION_COLOR.gray;
    }
    case 'priority':
      return PRIORITY_OPTION_COLOR[optionName] ?? FEISHU_OPTION_COLOR.gray;
    case 'status':
      return STATUS_OPTION_COLOR[optionName] ?? FEISHU_OPTION_COLOR.gray;
    case 'hostingAccount':
      return FEISHU_OPTION_COLOR.blue;
    default:
      return FEISHU_OPTION_COLOR.gray;
  }
}
