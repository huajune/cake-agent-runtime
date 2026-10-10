/**
 * 报名回执的模型可见投影。execute 的完整结果仍留给运行时、守卫和流水；
 * 仅在 AI SDK 构造下一步模型消息时取这些字段，禁止透传后台响应或副作用载荷。
 * 规则来源：docs/prompt-rule-ledger.md「报名回执输出边界」。
 */
type Scalar = string | number | boolean;
type ModelReceipt = Record<string, Scalar | Record<string, Scalar>>;

const REPLY_FIELDS = [
  'success',
  'errorType',
  '_outcome',
  '_replyInstruction',
  'candidateScope',
  '_confirmedInterviewTimeHuman',
  '_existingInterviewTimeHuman',
  '_onSiteScript',
  '_onlineInterviewGuide',
  '_waitNoticeReplyGuide',
  '_groupInviteGuide',
  '_otherBookingsGuide',
] as const;

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickScalars(source: Record<string, unknown>, keys: readonly string[]) {
  const result: Record<string, Scalar> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
      result[key] = value;
    }
  }
  return result;
}

export function projectBookingModelOutput(output: unknown): ModelReceipt {
  const source = readRecord(output);
  const receipt: ModelReceipt = pickScalars(source, REPLY_FIELDS);
  const groupInvite = pickScalars(readRecord(source.groupInvite), [
    'attempted',
    'success',
    'alreadyInGroup',
    'delivery',
    'groupName',
    'city',
  ]);
  if (Object.keys(groupInvite).length > 0) receipt.groupInvite = groupInvite;
  const manualGroup = pickScalars(readRecord(source.interviewGroupHandling), [
    'required',
    'delivery',
    'groupNameHint',
    'candidateGuide',
  ]);
  if (Object.keys(manualGroup).length > 0) receipt.interviewGroupHandling = manualGroup;
  return receipt;
}
