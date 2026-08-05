import {
  VisualFactSheetSchema,
  type FieldOwnership,
  type FinalizedVisualFactField,
  type FinalizedVisualFactSheet,
  type VisualFactKind,
} from './visual-fact.types';

/**
 * 归属默认规则（裁决记录见产品方案附录 A）。字段显式给了 ownership 则尊重；
 * 缺省按 kind 补。`unknown` 一律按第三方消费——宁可要求候选人重说一遍，
 * 不可把陌生人信息当自陈。
 */
const KIND_DEFAULT_OWNERSHIP: Record<VisualFactKind, FieldOwnership> = {
  job_posting: 'publisher', // 岗位截图上的一切默认是发布方的
  resume: 'candidate', // 简历默认全是候选人自陈
  map_location: 'candidate', // 候选人用地图指自己的位置
  chat_screenshot: 'unknown', // 双方混合，判不了就按第三方
  certificate: 'candidate',
  other: 'unknown',
};

/** kind 默认为 publisher 时仍归候选人的字段（裁决 A7：岗位页「我的地址」）。 */
const CANDIDATE_KEYS_ON_PUBLISHER_KINDS = new Set(['candidate_address']);

/**
 * finalize：解析 + 校验 + 补归属默认值。任何失败一律降级
 * `{kind:'other', fields:[], degraded:true}`——降级不是失败，是回到今天的纯文本行为。
 */
export function finalizeVisualFactSheet(
  raw: unknown,
  rawDescription: string,
): FinalizedVisualFactSheet {
  const degraded: FinalizedVisualFactSheet = {
    kind: 'other',
    fields: [],
    rawDescription,
    degraded: true,
  };
  if (!rawDescription.trim()) return { ...degraded, rawDescription: rawDescription || '' };

  const parsed = VisualFactSheetSchema.safeParse(
    raw && typeof raw === 'object' ? { rawDescription, ...(raw as object) } : raw,
  );
  if (!parsed.success) return degraded;

  const kind = parsed.data.kind;
  const fields: FinalizedVisualFactField[] = [];
  for (const field of parsed.data.fields) {
    const value = field.value.trim();
    if (!value) continue;
    let ownership = field.ownership ?? KIND_DEFAULT_OWNERSHIP[kind];
    if (CANDIDATE_KEYS_ON_PUBLISHER_KINDS.has(field.key)) ownership = 'candidate';
    fields.push({ key: field.key, value, ownership });
  }
  return { kind, fields, rawDescription, degraded: false };
}

/** 存储态（jsonb）安全解析：库里读出的对象过一遍 finalize 同款校验。 */
export function parseStoredVisualFactSheet(stored: unknown): FinalizedVisualFactSheet | null {
  if (!stored || typeof stored !== 'object') return null;
  const rawDescription =
    typeof (stored as { rawDescription?: unknown }).rawDescription === 'string'
      ? (stored as { rawDescription: string }).rawDescription
      : '';
  if (!rawDescription) return null;
  const sheet = finalizeVisualFactSheet(stored, rawDescription);
  return sheet;
}

/** 取指定归属的字段值列表。 */
export function fieldValues(
  sheet: FinalizedVisualFactSheet,
  key: string,
  ownership?: FieldOwnership,
): string[] {
  return sheet.fields
    .filter((f) => f.key === key && (ownership == null || f.ownership === ownership))
    .map((f) => f.value);
}

// ── 窗口文本渲染与识别（自 channels/wecom message-parser 收拢） ──────────────

/** vision 描述回写前缀。Phase 3 的 kind 标注前缀暂缓（改存储格式波及面大）。 */
export const IMAGE_MESSAGE_PREFIX = '[图片消息]';
export const EMOTION_MESSAGE_PREFIX = '[表情消息]';

/** 整条消息是否为 vision 描述回写产物（消息级判定：描述独占一条 chat_messages 行）。 */
export function isVisualDescriptionText(message: string | null | undefined): boolean {
  const trimmed = (message ?? '').trim();
  return trimmed.startsWith(IMAGE_MESSAGE_PREFIX) || trimmed.startsWith(EMOTION_MESSAGE_PREFIX);
}

/**
 * 简历图片识别（原 channels/wecom/message-parser 的 isResumeImageDescription
 * **逐字迁入**，正名为 resume kind 的文本兜底；sheet 缺失/降级时仍靠它保住简历链路。
 * 原位保留 re-export 以兼容既有调用方；判据不得与旧实现漂移——并跑对照要求 100% 一致）。
 */
export function isResumeImageDescription(description: string): boolean {
  return /^[「\[【]?(?:手写)?(?:简历|履历)/u.test(description.trim());
}

/** 剥离描述中已存在的「简历附件：…」行（原 channels 同名函数逐字迁入）。 */
export function stripResumeAttachmentLines(description: string): string {
  return description
    .split('\n')
    .filter((line) => !/^\s*简历附件\s*[：:]/.test(line))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** 消息是否携带「简历附件：URL」标注行。 */
export function hasResumeAttachmentLine(message: string | null | undefined): boolean {
  return /(?:^|\n)\s*简历附件\s*[：:]/.test(message ?? '');
}

/** 剥离窗口内容里的视觉前缀，得到描述本体（供文本兜底判定用）。 */
export function stripVisualPrefix(content: string): string {
  return content.replace(/^\s*\[(?:图片|表情)消息\]\s*/u, '');
}

/** 该视觉消息是否属于候选人自陈材料（简历/证件），sheet 优先、文本标记兜底。 */
export function isSelfReportedVisualMessage(
  content: string,
  sheet?: FinalizedVisualFactSheet | null,
): boolean {
  if (sheet && !sheet.degraded) return sheet.kind === 'resume' || sheet.kind === 'certificate';
  return isResumeImageDescription(stripVisualPrefix(content)) || hasResumeAttachmentLine(content);
}
