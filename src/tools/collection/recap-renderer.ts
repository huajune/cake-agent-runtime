/**
 * 提交前复述渲染器：全程只在提交前复述一次，覆盖全部 filled 槽位。
 *
 * 为什么复述必须落账：候选人回「不对，电话错了」时，系统要能精确定位改哪一格。
 * 没有 lastRecap 就只能满表重开或整表重问——那正是旧体系"改一个字段重问一遍"的病根。
 * 因此本渲染器**同时返回落好账的表单**，调用方拿不到"只渲染不落账"的出口。
 * 唯一例外是 `renderRecapRedeliveryText`：账已经在案（lastRecap 待确认）但送达文本
 * 偏离官方文案时，按在案快照重给同一份文案供照发——不新开账，也不动旧账。
 *
 * 分段兼容：文案刻意排成「引导句以冒号收尾 + 连续
 * `标签：值` 行」的表单块形态——`MessageSplitter` 认表单块为原子段，既不会把它按句
 * 拆散，也不会被 `coalesceToCap` 与别的话术粘在一起。收尾提示另起一段，允许被拆成
 * 第二条消息（拟人化投递按段发，这样读感更自然）。字节与分段契约见同名 spec。
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
    return `${titleById.get(labelId) ?? String(labelId)}：${slot.value?.value ?? ''}`;
  });

  return {
    text: `${INTRO_LINE}\n${lines.join('\n')}\n\n${CLOSING_LINE}`,
    labelIds,
    form: markRecapSent(form, labelIds),
  };
}

/**
 * 复述重投：公证发现在案复述从未按官方文本送达（recap_snapshot_mismatch，如模型把
 * 「有无本地健康证：无本地有效健康证，接受办理」改写成「健康证：无，接受办理」）时，
 * 按在案 lastRecap 快照重渲染同一份官方文案。没有待确认的在案复述时返回 null。
 */
export function renderRecapRedeliveryText(
  form: BookingCollectionForm,
  contract: readonly ContractFieldDef[],
): string | null {
  const recap = form.lastRecap;
  if (!recap || recap.affirmed || recap.labelIds.length === 0) return null;

  const titleById = new Map(contract.map((field) => [field.labelId, field.labelTitle]));
  const lines = recap.labelIds.map((labelId) => {
    const slot = form.slots[labelId];
    return `${titleById.get(labelId) ?? String(labelId)}：${slot?.value?.value ?? ''}`;
  });
  return `${INTRO_LINE}\n${lines.join('\n')}\n\n${CLOSING_LINE}`;
}
