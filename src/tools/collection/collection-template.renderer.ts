/**
 * 收资清单渲染：把表单渲染成候选人可一次填齐的资料模板。
 *
 * 与 `recap-renderer` 的分工：这张是**收资中**发的（缺什么问什么，已知的预填），
 * 那张是**提交前**发的一次性复述（全部 filled 槽位求证）。两者共用表单块形态，
 * 分段兼容结论见 recap-renderer 的同名断言。
 *
 * 字段名一律用**契约 labelTitle 原文**：Agent 契约要求"发给候选人的模板字段名必须与
 * 工具返回一致"，而 booking payload 也按 labelId 回填——三处同源才不会出现
 * "候选人按模板填了、回来却对不上槽位"。
 */

import type { BookingCollectionForm, ContractFieldDef } from '@resolution/collection';
import {
  carriesScreening,
  filledSlotIds,
  orderForAsking,
  starterFields,
} from '@resolution/collection';

const INTRO_LINE = '面试要求：先将以下资料补充下发给我，我来帮你约面试';

export interface CollectionTemplate {
  /** 契约要求收的全部字段（labelTitle）。required 实测恒 true，即"契约返回什么就全收"。 */
  requiredFields: string[];
  /** 展示顺序：身份核 → 带筛选条件的 → 纯登记项（见 orderForAsking）。 */
  displayOrder: string[];
  /** 还缺哪些字段——**空槽位的 labelTitle**，是本轮唯一收资事实源。同样按发问顺序。 */
  missingFields: string[];
  /** 已知字段值（filled 槽位），模板里预填。 */
  knownFieldMap: Record<string, string>;
  /**
   * 降级为渐进收资时的起手字段（身份核 + 带筛选条件的）。
   * 只在蓝图允许的两种降级下使用：collectionStrategy=progressive、候选人已抗拒。
   */
  starterFields: string[];
  /** 带筛选条件的字段——答错会筛掉候选人，不只是登记一笔。 */
  screeningFields: string[];
  templateText: string;
}

export function renderCollectionTemplate(
  form: BookingCollectionForm,
  contract: readonly ContractFieldDef[],
): CollectionTemplate {
  // 发问顺序而非契约原序：会筛人的字段要排在登记项前面，否则候选人填到第 9 格
  // 才被筛掉，前 8 格白填。身份核仍排头——那是收资最自然的开场。
  const ordered = orderForAsking(contract);
  const titleById = new Map(contract.map((field) => [field.labelId, field.labelTitle]));

  const knownFieldMap: Record<string, string> = {};
  for (const labelId of filledSlotIds(form, contract)) {
    const title = titleById.get(labelId);
    const value = form.slots[labelId]?.value?.value;
    if (title && value) knownFieldMap[title] = value;
  }

  const missingFields = ordered
    .filter((field) => form.slots[field.labelId]?.state === 'empty')
    .map((field) => field.labelTitle);

  // 模板一次性列全部字段（已知的预填、缺的留空）：分批发清单是明令禁止的漏斗式收资。
  const lines = ordered.map((field) => {
    const known = knownFieldMap[field.labelTitle];
    return `${field.labelTitle}：${known ?? optionPlaceholder(field)}`;
  });

  return {
    // required 恒 true：契约返回什么就全收（0820 用户确认）。
    requiredFields: ordered.filter((field) => field.required).map((field) => field.labelTitle),
    displayOrder: ordered.map((field) => field.labelTitle),
    missingFields,
    knownFieldMap,
    starterFields: starterFields(ordered).map((field) => field.labelTitle),
    screeningFields: ordered.filter(carriesScreening).map((field) => field.labelTitle),
    templateText: [INTRO_LINE, ...lines].join('\n'),
  };
}

/**
 * 选项型字段的枚举占位：`身份：（学生/社会人士）`。提示只能出现在冒号右侧，
 * 冒号左侧的标签 100% 使用契约 labelTitle 原文，不做剥括号、剥标点或截断。
 *
 * ⚠️ **必须列全部选项，不能只列 accepted**——只列可接受项等于用省略泄露筛选条件：
 * 「籍贯（北京/河北/…）」里没有天津，候选人一眼就看出天津被排除了，
 * 那正是 disclosure=RESTRICTED 要防的事。候选人如实填、筛在写入时判，
 * 拒绝话术再按披露分级决定说什么。
 *
 * 两种情况不加提示：选项太多（如籍贯 34 个省）或非选项型字段。选项里的标点位于
 * 冒号右侧，不再污染标签位，也不会改变 labelTitle 拼法。
 */
export function optionPlaceholder(field: ContractFieldDef): string {
  if (field.fieldType !== 'SINGLE_OPTION' && field.fieldType !== 'MULTIPLE_OPTION') return '';
  const options = [...field.acceptedOptions, ...field.rejectedOptions];

  // 少于 2 项不是选择题（"（社会人士）"只会让人困惑）。
  if (options.length < 2) return '';
  // 多于 4 项塞进一行没法读。生产实测：籍贯 29 项——列出来是灾难，留空让候选人自己写。
  if (options.length > 4) return '';
  // **常识型字段留空**（0820 用户裁定）：选项全是短词（男/女、是/否、本科/大专）时，
  // 候选人自己就知道该怎么答，提示纯属噪音。提示只该出现在**系统特有措辞**上——
  // 那种候选人猜不到该怎么写的（"无本地有效健康证，接受办理"、"3个月内"）。
  if (options.every((option) => option.optionLabel.trim().length <= 3)) return '';
  return `（${options.map((option) => option.optionLabel).join('/')}）`;
}
