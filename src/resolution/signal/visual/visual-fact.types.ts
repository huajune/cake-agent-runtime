import { z } from 'zod';
import { FIELD_OWNERSHIPS, type FieldOwnership } from '../types';

/**
 * 视觉信号域（resolution/signal/visual）—— 图片/表情消息结构化事实的唯一类型定义点。
 *
 * 设计依据：docs/architecture/visual-fact-pipeline.md（附录 A 为字段白名单与裁决
 * 记录的唯一权威；前身三份 2026-08-05 立项文档已整合进该文，全文存 git 历史）。
 * 与 brand/geo 域同构：纯确定性、零 LLM、零仓内出向依赖；vision/主模型调用留在
 * channels（P1 兜底引擎：漏调补描述/降级重跑/懒补写/自侧消息）与 tools（P2 主路径
 * 工具）两个生产者，本域只持有 schema、归属规则与渲染/解析。
 *
 * 直接诱因 badcase `vkikct39`（P0）：BOSS 截图描述被拍平成文本回写进用户消息，
 * 交换微信截图里招募经理本人的微信号与岗位卡「18岁以上」门槛句被当候选人自陈，
 * 提交进真实报名。三判据（这是什么图/归谁/可不可信）在 7 个消费点全部缺失。
 */

export const VISUAL_FACT_KINDS = [
  'job_posting', // 招聘平台岗位截图/卡片/海报/列表页
  'map_location', // 地图/定位/导航/门店位置截图
  'resume', // 简历（拍照/手写/截图）—— isResumeImageDescription 的正名
  'chat_screenshot', // 聊天记录截图（双方信息混合，归属须逐字段判）
  'certificate', // 健康证/学生证等证件类
  'other', // 兜底：只有 rawDescription，行为等同现状
] as const;
export type VisualFactKind = (typeof VISUAL_FACT_KINDS)[number];

/**
 * kind 词表的模型侧释义。`Record<VisualFactKind, …>` 是硬约束：往
 * VISUAL_FACT_KINDS 加一档而不写释义，编译期即报错。
 */
const VISUAL_FACT_KIND_GLOSSES: Record<VisualFactKind, string> = {
  job_posting: '招聘平台岗位截图/卡片/海报',
  map_location: '地图/定位/导航/门店位置',
  resume: '简历本体',
  chat_screenshot: '聊天记录截图',
  certificate: '健康证等证件',
  other: '其他',
};

/**
 * 两个生产者（channels P1 兜底引擎 / tools P2 主路径工具）schema 共用的 kind 释义串。
 * 手抄一份到 describe 里就会漂移——词表是模型唯一的可见来源，此处是唯一产出点。
 */
export const VISUAL_FACT_KIND_PROMPT = VISUAL_FACT_KINDS.map(
  (kind) => `${kind}=${VISUAL_FACT_KIND_GLOSSES[kind]}`,
).join('；');

/**
 * 字段 key 白名单（裁决 A2/A7/B3）：
 * - brand_id：我方平台截图自带品牌ID（如 [10006]），确定性锚点直通 brandIdList
 *   （直通实现走描述文本「品牌ID：」契约行，本结构化字段当前无读者，仅作冗余锚点）；
 * - candidate_address：岗位页「我的地址：XX街道」/「距我 X km」锚点——候选人设备
 *   上的真实地址，位置证据强度不低于定位分享；
 * - 刻意不设身份证号/证件号 key：booking 用不到，纯隐私暴露面（裁决 B3'）。
 */
export const VISUAL_FACT_FIELD_KEYS = [
  'phone',
  'name',
  'age_range',
  'brand',
  'brand_id',
  'publisher',
  'store',
  'address',
  'city',
  'candidate_address',
  'salary_text',
  'shift_text',
  'cert_type',
  'cert_issue_date',
  'other',
] as const;
export type VisualFactFieldKey = (typeof VISUAL_FACT_FIELD_KEYS)[number];

/**
 * key 词表的模型侧提示串（两个生产者共用）。
 *
 * 这里 schema 刻意收 string 而非 enum（见 VisualFactFieldSchema 注释），白名单只在
 * finalize 过滤——意味着模型能否产出合法 key，**全靠这句 describe**。词表若与
 * VISUAL_FACT_FIELD_KEYS 漂移，finalize 会接受一个模型从没被告知存在的 key：
 * 不报错、不抛类型错，只是静默少收一类事实。故由常量单向生成，不留手抄口。
 */
export const VISUAL_FACT_FIELD_KEY_PROMPT = `只能用这些值：${VISUAL_FACT_FIELD_KEYS.join(' / ')}`;

export const VisualFactFieldSchema = z.object({
  // 刻意收 string 而非 enum（2026-08-05 生产 50 图批测实证：32/50 的模型输出含
  // 白名单外 key，如 position/distance/welfare——严格 enum 会让一个坏 key 拖垮
  // 整张 sheet 的 safeParse 触发全量降级）。白名单过滤在 finalizeVisualFactSheet
  // 做：坏字段丢弃、好字段保留，kind 判定不受牵连。
  key: z.string().min(1),
  value: z.string().min(1),
  // 生产端可缺省，finalizeVisualFactSheet 按 kind 补默认值
  ownership: z.enum(FIELD_OWNERSHIPS).optional(),
});
export type VisualFactField = z.infer<typeof VisualFactFieldSchema>;

/**
 * 单张视觉消息的结构化事实。与描述文本同源产出（同一次 vision/主模型调用）。
 *
 * 刻意不带 vision 自评置信度：置信度由消费规则按「字段类型 × 图类型」确定性
 * 赋予（如证件/简历 phone 一律 medium + 确认问答升级），模型自报置信度不可信。
 */
export const VisualFactSheetSchema = z.object({
  kind: z.enum(VISUAL_FACT_KINDS),
  fields: z.array(VisualFactFieldSchema).default([]),
  rawDescription: z.string().min(1),
});
export type VisualFactSheet = z.infer<typeof VisualFactSheetSchema>;

/** finalize 后所有字段 ownership 均已补齐的形态（消费端只见这个形态）。 */
export interface FinalizedVisualFactField {
  key: VisualFactFieldKey;
  value: string;
  ownership: FieldOwnership;
}
export interface FinalizedVisualFactSheet {
  kind: VisualFactKind;
  fields: FinalizedVisualFactField[];
  rawDescription: string;
  /** true = 结构化失败已降级（kind=other 空字段），行为等同现状纯文本。 */
  degraded: boolean;
}
