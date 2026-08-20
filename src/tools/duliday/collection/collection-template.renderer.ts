/**
 * 收资清单渲染：把表单渲染成候选人可一次填齐的资料模板。
 *
 * 与 `recap-renderer` 的分工：这张是**收资中**发的（缺什么问什么，已知的预填），
 * 那张是**提交前**发的一次性复述（全部 filled 槽位求证）。两者共用表单块形态，
 * 分段兼容结论见 recap-renderer 的 Spike S5 断言。
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
  const lines = ordered.map(
    (field) => `${formLabel(field.labelTitle)}：${knownFieldMap[field.labelTitle] ?? ''}`,
  );

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
 * 表单行标签清洗——与 recap-renderer 同一口径（Spike S5 结论）：
 * 标签含逗号/句号或超 48 字时 `MessageSplitter` 不认这一行为表单行，整块随之失去
 * 原子性、被按句拆散刷屏。生产实测脏配置不少（「是否学生（不要学生及暑假工）」），
 * 且括号里往往就是**筛选指令**——原样发给候选人等于泄露筛选条件。
 */
export function formLabel(title: string): string {
  const stripped = title
    .replace(/[（(][^）)]*[）)]/gu, '')
    .replace(/[，,。！？!?；;]/gu, ' ')
    .trim();
  const label = stripped || title.trim();
  return label.length > 48 ? label.slice(0, 48) : label;
}
