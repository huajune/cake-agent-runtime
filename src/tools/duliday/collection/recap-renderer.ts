/**
 * 提交前复述渲染器（D3：全程只在提交前复述一次，覆盖全部 filled 槽位）。
 *
 * 为什么复述必须落账：候选人回「不对，电话错了」时，系统要能精确定位改哪一格。
 * 没有 lastRecap 就只能满表重开或整表重问——那正是旧体系"改一个字段重问一遍"的病根。
 * 因此本渲染器**同时返回落好账的表单**，调用方拿不到"只渲染不落账"的出口。
 *
 * 分段兼容（Spike S5，2026-08-19 核验）：文案刻意排成「引导句以冒号收尾 + 连续
 * `标签：值` 行」的表单块形态——`MessageSplitter` 认表单块为原子段，既不会把它按句
 * 拆散，也不会被 `coalesceToCap` 与别的话术粘在一起。收尾提示另起一段，允许被拆成
 * 第二条消息（拟人化投递按段发，这样读感更自然）。核验断言见同名 spec。
 */

import {
  markRecapSent,
  type BookingCollectionForm,
  type ContractFieldDef,
} from '@resolution/collection';
import { filledSlotIds } from '@resolution/collection/form.types';

export interface RecapRender {
  /** 发给候选人的复述文案；无可复述内容时为 null。 */
  text: string | null;
  /** 本次复述覆盖的槽位。 */
  labelIds: number[];
  /** 已落 lastRecap 的表单——渲染与落账同生共死。 */
  form: BookingCollectionForm;
}

const INTRO_LINE = '帮你核对一下报名信息：';
const CLOSING_LINE = '没问题的话我这就帮你提交，有不对的地方直接说改哪项';

export function renderRecap(
  form: BookingCollectionForm,
  contract: readonly ContractFieldDef[],
): RecapRender {
  const labelIds = filledSlotIds(form, contract);
  if (labelIds.length === 0) return { text: null, labelIds: [], form };

  const titleById = new Map(contract.map((field) => [field.labelId, field.labelTitle]));
  const lines = labelIds.map((labelId) => {
    const slot = form.slots[labelId];
    return `${normalizeFormLabel(titleById.get(labelId) ?? String(labelId))}：${slot.value?.value ?? ''}`;
  });

  return {
    text: `${INTRO_LINE}\n${lines.join('\n')}\n\n${CLOSING_LINE}`,
    labelIds,
    form: markRecapSent(form, labelIds),
  };
}

/**
 * 表单行的标签清洗：标点会让 `MessageSplitter.isGenericFormFieldLine` 不认这一行
 * （它要求冒号左侧不含逗号/句号/问号/分号，且长度 ≤48），行一旦不被认成表单行，
 * 整块就失去原子性、会被按句拆散。生产实测标题里带筛选指令的脏配置不少
 * （「是否学生（不要学生及暑假工）」），故渲染前统一剥括号补充与句读。
 */
function normalizeFormLabel(title: string): string {
  const stripped = title
    .replace(/[（(][^）)]*[）)]/gu, '')
    .replace(/[，,。！？!?；;]/gu, ' ')
    .trim();
  const label = stripped || title.trim();
  return label.length > 48 ? label.slice(0, 48) : label;
}
