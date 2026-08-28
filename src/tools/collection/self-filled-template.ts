/**
 * 自填模板直通判据：候选人在**一条消息里**逐行填满整张收资表时，跳过提交前的全量复述轮。
 *
 * 为什么可以跳：复述的用途是让候选人在提交前亲眼核对资料。候选人自己照模板逐行写下
 * 并发出的那条消息，核对人与作者重合、内容逐字就是他刚打的字——把同样六行再发回去
 * 让他说一次"对"，是零信息增量的流程税（2026-08-27 产品裁定）。
 *
 * 判据全部确定性、且刻意收得很紧——任何一格的值不是候选人在这条消息里亲眼写下的，
 * 就必须退回正常复述轮。只要有一个条件说不准，就走复述：**多问一轮的代价远小于
 * 拿没核对过的资料去提交**（手机号错一位候选人白跑一趟门店）。
 */

import {
  verdictOf,
  type BookingCollectionForm,
  type ContractFieldDef,
} from '@resolution/collection';
import { parseTemplateLines } from './proposal-intake';

/** 直通未命中的归因（进 collection_form_audit，用于核对生产上直通率与拦截原因）。 */
export type SelfFilledMissReason =
  | 'verdict_not_ready'
  | 'single_field_contract'
  | 'ratchet_ignored'
  | 'no_full_template_message'
  | 'value_not_from_this_turn'
  | 'archive_seeded_value';

/**
 * 直通要求契约至少两格。
 *
 * 一格的契约里，`专业：无` 只是对某个问题的普通作答，不是"候选人誊了一整张表"——
 * 自填信号在这里最弱，而复述本身也只有一行、便宜。产品裁定说的是「整张自填模板」，
 * 表之所以为表，是因为它有多格。
 */
const MIN_CONTRACT_FIELDS_FOR_FAST_PATH = 2;

export interface SelfFilledTemplateDetection {
  matched: boolean;
  /** 命中时本次直通覆盖的槽位（落 lastRecap 用，与复述快照同形）。 */
  labelIds: number[];
  reason?: SelfFilledMissReason;
}

export interface SelfFilledTemplateInput {
  form: BookingCollectionForm;
  contract: readonly ContractFieldDef[];
  /** 本轮候选人消息（已剥引用块/时间后缀），逐条独立判定。 */
  candidateTexts: readonly string[];
  /** 本轮真正落值的字段（collection-core 产出）。 */
  answeredThisTurn: readonly ContractFieldDef[];
  /** 本轮被棘轮挡下的槽位——存在即说明有值重复/冲突，一律退回复述。 */
  ratchetIgnoredLabelIds: readonly number[];
}

export function detectSelfFilledTemplate(
  input: SelfFilledTemplateInput,
): SelfFilledTemplateDetection {
  const miss = (reason: SelfFilledMissReason): SelfFilledTemplateDetection => ({
    matched: false,
    labelIds: [],
    reason,
  });

  if (verdictOf(input.form) !== 'ready') return miss('verdict_not_ready');

  // 棘轮挡下过任何一格＝候选人这轮写的值与在案值不一致（或重复提交）。
  // 他可能以为自己改掉了某项而实际没改，这种分歧只能靠复述暴露。
  if (input.ratchetIgnoredLabelIds.length > 0) return miss('ratchet_ignored');

  const contractIds = input.contract.map((field) => field.labelId);
  if (contractIds.length < MIN_CONTRACT_FIELDS_FOR_FAST_PATH) return miss('single_field_contract');

  // 必须是**同一条**消息覆盖全部字段：跨条拼出来的"整表"，候选人并没有在任何一屏里
  // 完整看过自己的全部资料，与"亲眼核对"不是一回事。
  const fullMessage = input.candidateTexts.find((text) => {
    const covered = new Set(
      parseTemplateLines(text, input.contract).map((line) => line.field.labelId),
    );
    return contractIds.every((labelId) => covered.has(labelId));
  });
  if (!fullMessage) return miss('no_full_template_message');

  // 每一格都必须是**本轮**落的值：上一轮口头给过、这轮模板里又写了一遍的格子会被
  // 棘轮挡下（已在上面拦掉）；这里再兜一次，确保槽位现值确实来自这条自填消息。
  const answeredIds = new Set(input.answeredThisTurn.map((field) => field.labelId));
  if (!contractIds.every((labelId) => answeredIds.has(labelId))) {
    return miss('value_not_from_this_turn');
  }

  // 档案预填的值候选人这一屏里没看见过（它由系统从跨岗记忆补入），必须过复述终审。
  const archiveSeeded = contractIds.some(
    (labelId) => input.form.slots[labelId]?.value?.producer === 'archive',
  );
  if (archiveSeeded) return miss('archive_seeded_value');

  return { matched: true, labelIds: contractIds };
}
