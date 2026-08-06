import {
  VISUAL_FACT_FIELD_KEYS,
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
 * 证件号确定性清洗（裁决 B3'：证件号不设 key、不入档）。
 * P2 批测实证：模型会无视"证件号不要写"的提示词指令（写出 证件号码/健康证证号
 * 字段）——中文 key 本会被白名单拦下，但若值被塞进合法 key（如 other），
 * 提示词防线就穿了。按值形态兜底：15/18 位身份证形态一律丢弃。
 */
const ID_NUMBER_VALUE_RE = /^\d{15}(\d{2}[0-9Xx])?$/;

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
    // 白名单过滤（非整表拒绝）：模型常发明 key（position/distance/welfare…，
    // 批测 32/50 命中）——坏字段丢弃即可，kind 与其余字段照常生效。
    if (!(VISUAL_FACT_FIELD_KEYS as readonly string[]).includes(field.key)) continue;
    const value = field.value.trim();
    if (!value) continue;
    if (ID_NUMBER_VALUE_RE.test(value.replace(/\s/g, ''))) continue;
    let ownership = field.ownership ?? KIND_DEFAULT_OWNERSHIP[kind];
    if (CANDIDATE_KEYS_ON_PUBLISHER_KINDS.has(field.key)) ownership = 'candidate';
    fields.push({ key: field.key as FinalizedVisualFactField['key'], value, ownership });
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

/** vision 描述回写前缀。kind 标注前缀已裁定取消（visual-fact-pipeline.md A.3：改存储格式波及面大，kind 只走 prompt 口径）。 */
export const IMAGE_MESSAGE_PREFIX = '[图片消息]';
export const EMOTION_MESSAGE_PREFIX = '[表情消息]';

/** 整条消息是否为 vision 描述回写产物（消息级判定：描述独占一条 chat_messages 行）。 */
export function isVisualDescriptionText(message: string | null | undefined): boolean {
  const trimmed = (message ?? '').trim();
  return trimmed.startsWith(IMAGE_MESSAGE_PREFIX) || trimmed.startsWith(EMOTION_MESSAGE_PREFIX);
}

/**
 * 简历图片识别：resume kind 的文本兜底判据，sheet 缺失/降级时靠它保住简历链路
 * （channels/wecom message-parser 处保留同名 re-export，既有调用方仍从原路径导入）。
 * 判据不得与 vision prompt 的 resume 口径漂移：save-image-description.tool 与
 * image-description.service 仍在做 legacy vs sheet 并跑分歧告警，删旧判据前需一致率达标。
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
