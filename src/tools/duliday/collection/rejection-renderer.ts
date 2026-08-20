/**
 * 不合格话术渲染器（总纲 §2.8 构造性质④「不合格披露策略」的落地面）。
 *
 * 铁律分工：
 * - **账本永远落真实原因**（labelId + 命中项 + 证据），已由 form-writes 的
 *   disqualified 槽位保存；本渲染器只决定**对候选人说什么**；
 * - 可明说族（年龄/性别/学历/健康证/身高体重）：直说要求 + 转岗；
 * - 禁明说族（户籍/民族/专业等守卫红线 + 未知新标签）：绝不披露真实原因，
 *   渲染为换岗/拉群承接（复用 noMatchScript 家族口径），且**禁止在敏感答案紧邻回合
 *   触发拒绝**——话术再委婉，紧邻时序本身就把因果说出去了。
 *
 * 输出形态对齐 noMatchScript：candidateMessage（可照念的话术）+ forbiddenActions
 * （给模型的禁令，不让它自由发挥）。internalReason 只进内部/审计，绝不出站。
 */

import { normalizeGenderValue } from '@resolution/candidate/gender';
import {
  disclosureLevelOf,
  resolveValueRange,
  verdictOf,
  type BookingCollectionForm,
  type ContractFieldDef,
  type DisclosureLevel,
} from '@resolution/collection';

export interface RejectionScript {
  disclosureLevel: DisclosureLevel;
  /** 可照念的候选人话术。deferred=true 时为 null（本轮不拒）。 */
  candidateMessage: string | null;
  /** 账本口径的真实原因，只进内部与审计事件，**禁止出站**。 */
  internalReason: string;
  forbiddenActions: string[];
  /**
   * 因果隔离：本轮候选人刚回答过禁明说档字段时为 true，拒绝顺延到下一轮。
   * 表单状态已是 disqualified，顺延不会把结论丢掉。
   */
  deferred: boolean;
}

/** 禁明说档统一话术：不点名字段、不给可推理的因果，接换岗/拉群。 */
const RESTRICTED_MESSAGE =
  '这家的岗位跟你这边暂时没太对上，我再帮你找找其他合适的，有匹配的第一时间告诉你';

const COMMON_FORBIDDEN = [
  '不得把不合格原因说成"系统判定/后台筛掉"等推卸表述——对候选人只讲岗位条件，不讲内部机制',
  '不得承诺"下次一定能过/我帮你改一下就行"等无法兑现的话',
];

const RESTRICTED_FORBIDDEN = [
  '**绝不披露真实不合格原因**：不得点名字段、不得复述候选人刚才的回答、不得暗示"因为你刚说的那个"',
  '不得反问该敏感属性的任何细节（问回来与说出去是同一风险的一进一出）',
  '不得跨品牌硬推：按换岗/拉群承接口径收口',
];

export function renderRejection(params: {
  form: BookingCollectionForm;
  contract: readonly ContractFieldDef[];
  /** 本轮刚落值的字段——因果隔离判据。 */
  fieldsAnsweredThisTurn?: readonly ContractFieldDef[];
}): RejectionScript | null {
  const { form, contract } = params;
  if (verdictOf(form) !== 'disqualified') return null;

  const field = firstDisqualifiedField(form, contract);
  if (!field) return null;

  const slotValue = form.slots[field.labelId]?.value?.value ?? '';
  const level = disclosureLevelOf(field);
  const internalReason = `labelId=${field.labelId}「${field.labelTitle}」命中筛选条件，候选人答「${slotValue}」`;

  // 因果隔离只对禁明说档生效：可明说族本来就允许当面讲要求，紧邻回合说反而更自然。
  const deferred =
    level === 'restricted' &&
    (params.fieldsAnsweredThisTurn ?? []).some(
      (answered) => disclosureLevelOf(answered) === 'restricted',
    );

  if (level === 'restricted') {
    return {
      disclosureLevel: level,
      candidateMessage: deferred ? null : RESTRICTED_MESSAGE,
      internalReason,
      forbiddenActions: [...RESTRICTED_FORBIDDEN, ...COMMON_FORBIDDEN],
      deferred,
    };
  }

  return {
    disclosureLevel: level,
    candidateMessage: `这个岗位${describeRequirement(field, genderOf(form))}，你这边暂时对不上，我再帮你看看其他岗位`,
    internalReason,
    forbiddenActions: ['只说岗位要求本身，不得复述或评价候选人的个人情况', ...COMMON_FORBIDDEN],
    deferred: false,
  };
}

/**
 * 可明说族的要求描述。只用契约给的东西造句——`acceptedOptions` 的标签、
 * 年龄的 min/max，一个字都不外推（岗位卡上有的才说得出口）。
 */
function describeRequirement(field: ContractFieldDef, gender: 'MALE' | 'FEMALE' | null): string {
  const range = resolveValueRange(field.valueSpec, gender);
  if (range) {
    const unit = field.valueSpec?.unit ?? '';
    const label = field.labelTitle.replace(/[（(][^）)]*[）)]/gu, '').trim() || field.labelTitle;
    if (range.min != null && range.max != null) {
      return `${label}要求 ${range.min}-${range.max}${unit}`;
    }
    return range.min != null
      ? `${label}要求 ${range.min}${unit} 以上`
      : `${label}要求 ${range.max}${unit} 以内`;
  }
  const accepted = field.acceptedOptions.map((option) => option.optionLabel).filter(Boolean);
  if (accepted.length > 0) return `「${field.labelTitle}」要求是${accepted.join('、')}`;
  return `对「${field.labelTitle}」有要求`;
}

/** 表单在案性别——分性别值域的话术要按候选人性别取那一档，说错档等于报错要求。 */
function genderOf(form: BookingCollectionForm): 'MALE' | 'FEMALE' | null {
  for (const slot of Object.values(form.slots)) {
    if (slot.state !== 'filled' || !slot.value) continue;
    const normalized = normalizeGenderValue(slot.value.value);
    if (normalized === '男') return 'MALE';
    if (normalized === '女') return 'FEMALE';
  }
  return null;
}

function firstDisqualifiedField(
  form: BookingCollectionForm,
  contract: readonly ContractFieldDef[],
): ContractFieldDef | null {
  return contract.find((field) => form.slots[field.labelId]?.state === 'disqualified') ?? null;
}
