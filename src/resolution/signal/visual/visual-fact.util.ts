import { hasResumeAttachmentLine, stripVisualPrefix } from '../markers';
import {
  VISUAL_FACT_FIELD_KEYS,
  VisualFactSheetSchema,
  type FinalizedVisualFactField,
  type FinalizedVisualFactSheet,
  type VisualFactKind,
} from './visual-fact.types';
import type { FieldOwnership } from '../types';

/**
 * 归属默认规则（完整契约见视觉事实架构文档）。字段显式给了 ownership 则尊重；
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
 * 证件号确定性清洗：证件号不设 key、不入档。
 * 批测实证：模型会无视“证件号不要写”的提示词指令（写出证件号码/健康证证号
 * 字段）——中文 key 本会被白名单拦下，但若值被塞进合法 key（如 other），
 * 提示词防线就穿了。按值形态兜底：15/18 位身份证形态一律丢弃。
 */
const ID_NUMBER_VALUE_RE = /^\d{15}(\d{2}[0-9Xx])?$/;

/**
 * 自由描述里的证件号。
 *
 * 生产实证（08-07 扫描日报红标 2，chat 6a1e42e6 10:18）：候选人发来一张员工名单表格
 * 截图，白名单**正确地**让 `fields` 为空，但同一 JSONB 的 `rawDescription` 原样留下了
 * 整行明文——真实姓名 + 11 位手机号 + 18 位身份证号，并随 `chat_messages.content`
 * 与 `visual_facts` 长期留存。白名单只约束 `fields`，管不到模型自由文本这一侧。
 *
 * 只脱敏证件号：招聘链路全程没有身份证号的消费点（`ID_NUMBER_VALUE_RE` 已经把它挡在
 * `fields` 之外），删掉零业务损失。**手机号不在此列**——它是收资/预约要真消费的字段
 * （简历截图里的号码会流向报名），一刀切会打断链路，策略另议。
 *
 * 形态：独立的 15 位或 18 位（末位可 X）数字串。19 位以上（银行卡等）不匹配，宁可漏。
 */
const ID_NUMBER_IN_TEXT_RE = /(?<![\dXx])(?:\d{17}[\dXx]|\d{15})(?![\dXx])/gu;

const ID_NUMBER_MASK = '[身份证号已脱敏]';

/**
 * 描述文本脱敏：落库前的唯一收口点。生产者拿它处理 `chat_messages.content`，
 * `finalizeVisualFactSheet` 处理 sheet 的 `rawDescription`；读取路径
 * （`parseStoredVisualFactSheet`）同样过一遍，存量行读出来即已脱敏。
 */
export function sanitizeVisualDescription(description: string): string {
  return description.replace(ID_NUMBER_IN_TEXT_RE, ID_NUMBER_MASK);
}

/**
 * finalize：解析 + 校验 + 补归属默认值。任何失败一律降级
 * `{kind:'other', fields:[], degraded:true}`——降级不是失败，是回到今天的纯文本行为。
 */
export function finalizeVisualFactSheet(
  raw: unknown,
  rawDescriptionInput: string,
): FinalizedVisualFactSheet {
  const rawDescription = sanitizeVisualDescription(rawDescriptionInput ?? '');
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

// ── 视觉消息的域内判定（标记形态本身住 ../markers） ──────────────────────────

/**
 * 简历图片识别：resume kind 的文本兜底判据，sheet 缺失/降级时靠它保住简历链路。
 * 判据不得与 vision prompt 的 resume 口径漂移：save-image-description.tool 与
 * image-description.service 仍在做 legacy vs sheet 并跑分歧告警，删旧判据前需一致率达标。
 *
 * signal/self-report 直接消费本判据，sheet 优先、文本标记兜底，避免简历口径再分叉。
 */
export function isResumeImageDescription(description: string): boolean {
  return /^[「\[【]?(?:手写)?(?:简历|履历)/u.test(description.trim());
}

/** 该视觉消息是否属于候选人自陈材料（简历/证件），sheet 优先、文本标记兜底。 */
export function isSelfReportedVisualMessage(
  content: string,
  sheet?: FinalizedVisualFactSheet | null,
): boolean {
  if (sheet && !sheet.degraded) return sheet.kind === 'resume' || sheet.kind === 'certificate';
  return isResumeImageDescription(stripVisualPrefix(content)) || hasResumeAttachmentLine(content);
}
