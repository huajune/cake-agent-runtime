import { extractDialogueTurns } from '@resolution/signal/dialogue';
import type { NotaryCheckResult } from './notary.types';
import { normalizedIncludes } from './text-normalization';

export type RecapConfirmationRejectionReason =
  | 'recap_not_required'
  | 'recap_missing_or_already_affirmed'
  | 'candidate_quote_not_full_latest_reply'
  | 'recap_quote_not_delivered'
  | 'recap_snapshot_mismatch'
  | 'correction_takes_precedence';

export interface RecapConfirmationNotaryInput {
  form: RecapFormSnapshot;
  contract: readonly RecapContractField[];
  /** 由 collection 唯一授权函数 `needsRecap(form)` 在 tools 应用层派生。 */
  recapRequired: boolean;
  candidateTexts: readonly string[];
  messages: readonly unknown[];
  candidateQuote: string;
  /** 模型语义陈述所绑定的当前 assistant recap 逐字片段。 */
  recapQuote: string;
  hasValidatedCorrection: boolean;
}

interface RecapFormSnapshot {
  slots: Record<number, { state: string; value?: { value: string } }>;
  lastRecap?: { labelIds: readonly number[]; affirmed?: boolean };
}

interface RecapContractField {
  labelId: number;
  labelTitle: string;
}

/**
 * recap 确认只做机械对话绑定，不判断同意、否定、转折或礼貌语义。无论纯短答还是
 * 带礼貌尾巴的开放表达，语义结论都来自主模型提交的同一种 `recapConfirmation`。
 *
 * 绑定锚点是「已真实送达的复述」而非「紧邻 assistant 组」：首轮确认落空后，回复纪律
 * 禁止重发整张复述、只允许简短追认，紧邻组必然不再含 `标签：值` 行——按紧邻组锚定
 * 会让第二轮追认结构性死锁（生产 chat 6a951ac7ce406a6aeea1338c）。快照一致性由
 * `lastRecap` 落账不变式兜底：任一槽位变更都会整体作废 `lastRecap`，因此只要在案
 * 复述仍未作废，窗口内任一含官方复述全文的 assistant 连续组都是同一份快照的送达证明。
 */
export function verifyRecapConfirmationBinding(
  input: RecapConfirmationNotaryInput,
): NotaryCheckResult<RecapConfirmationRejectionReason> {
  if (!input.recapRequired) return reject('recap_not_required');
  if (!input.form.lastRecap || input.form.lastRecap.affirmed) {
    return reject('recap_missing_or_already_affirmed');
  }
  if (input.hasValidatedCorrection) return reject('correction_takes_precedence');

  const candidateQuote = input.candidateQuote.trim();
  const latestCandidateText = input.candidateTexts.at(-1)?.trim() ?? '';
  if (!candidateQuote || normalizeExact(candidateQuote) !== normalizeExact(latestCandidateText)) {
    return reject('candidate_quote_not_full_latest_reply');
  }

  const recapQuote = input.recapQuote.trim();
  const carrierGroups = recapQuote
    ? assistantGroupsBeforeLatestCandidate(input.messages).filter((group) =>
        normalizedIncludes(group, recapQuote),
      )
    : [];
  if (carrierGroups.length === 0) return reject('recap_quote_not_delivered');

  const snapshotDelivered = carrierGroups.some((group) =>
    assistantGroupMatchesCurrentSnapshot(input.form, input.contract, group),
  );
  if (!snapshotDelivered) return reject('recap_snapshot_mismatch');
  return { accepted: true };
}

/** 最新候选人消息之前的全部 assistant 连续组，新→旧排列；组内按原顺序拼接。 */
function assistantGroupsBeforeLatestCandidate(messages: readonly unknown[]): string[] {
  const turns = extractDialogueTurns(messages);
  let candidateIndex = -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].role === 'user') {
      candidateIndex = index;
      break;
    }
  }
  if (candidateIndex <= 0) return [];

  const groups: string[] = [];
  let current: string[] = [];
  for (let index = candidateIndex - 1; index >= 0; index -= 1) {
    if (turns[index].role === 'assistant') {
      current.unshift(turns[index].text);
      continue;
    }
    if (current.length > 0) {
      groups.push(current.join('\n'));
      current = [];
    }
  }
  if (current.length > 0) groups.push(current.join('\n'));
  return groups;
}

function assistantGroupMatchesCurrentSnapshot(
  form: RecapFormSnapshot,
  contract: readonly RecapContractField[],
  assistantGroup: string,
): boolean {
  const recapIds = form.lastRecap?.labelIds ?? [];
  const filledIds = contract
    .filter((field) => form.slots[field.labelId]?.state === 'filled')
    .map((field) => field.labelId);
  if (!sameIdSet(recapIds, filledIds)) return false;

  const titleById = new Map(contract.map((field) => [field.labelId, field.labelTitle]));
  return recapIds.every((labelId) => {
    const title = titleById.get(labelId);
    const value = form.slots[labelId]?.value?.value;
    return Boolean(title && value && normalizedIncludes(assistantGroup, `${title}：${value}`));
  });
}

function sameIdSet(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return new Set(left).size === rightSet.size && left.every((value) => rightSet.has(value));
}

function normalizeExact(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function reject(
  reason: RecapConfirmationRejectionReason,
): NotaryCheckResult<RecapConfirmationRejectionReason> {
  return { accepted: false, reason };
}
