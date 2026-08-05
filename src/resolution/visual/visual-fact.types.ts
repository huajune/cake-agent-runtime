import { z } from 'zod';

/**
 * 视觉事实域（resolution/visual）—— 图片/表情消息结构化事实的唯一类型定义点。
 *
 * 设计依据：docs/product/visual-fact-structuring-plan-2026-08-05.md（附录 A 为字段
 * 白名单与裁决记录的唯一权威）。与 brand/geo 域同构：纯确定性、零 LLM、零仓内
 * 出向依赖；vision/主模型调用留在 channels（P1 预描述）与 tools（P2 工具）两个
 * 生产者，本域只持有 schema、归属规则与渲染/解析。
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
 * 字段 key 白名单（裁决 A2/A7/B3）：
 * - brand_id：我方平台截图自带品牌ID（如 [10006]），确定性锚点直通 brandIdList；
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

export const FIELD_OWNERSHIPS = ['candidate', 'publisher', 'third_party', 'unknown'] as const;
export type FieldOwnership = (typeof FIELD_OWNERSHIPS)[number];

export const VisualFactFieldSchema = z.object({
  key: z.enum(VISUAL_FACT_FIELD_KEYS),
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
