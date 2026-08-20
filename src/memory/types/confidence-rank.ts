/**
 * 事实置信度等级 —— 全记忆系统的唯一权威定义。
 *
 * 会话层（SessionFactConfidence）与长期层（ProfileFactConfidence）共用同一套
 * 二级刻度与排序值；两层的"软事实不得覆盖表单办结事实"守卫都必须基于本表比较，
 * 禁止再各自维护独立的 rank 映射（历史上两份定义曾并存，存在漂移风险）。
 *
 * DB 侧旧 RPC 仍接受历史 low/unknown；读边界把它们归一为 medium。现有 SQL 中
 * high 始终高于其他档位，因此无需 DDL/迁移即可保持写入守卫语义。
 */

export const FACT_CONFIDENCE_LEVELS = ['medium', 'high'] as const;

export type FactConfidence = (typeof FACT_CONFIDENCE_LEVELS)[number];

/**
 * 同一张表的降序排列，**专供会话层抽取 schema 的 z.enum 使用**。
 *
 * 为什么不直接用 FACT_CONFIDENCE_LEVELS：该数组会被序列化进发给抽取模型的 JSON
 * schema，枚举顺序对模型有先验影响。会话层历史上手抄的是 high-first 顺序，直接
 * 换成升序权威表等于**无声改动模型可见提示词**——那属 badcase 链路不属技术债。
 * 故另备一份降序元组，取值集与本表恒等（由下方 spec 断言保证），只是顺序相反。
 */
export const FACT_CONFIDENCE_LEVELS_DESC = ['high', 'medium'] as const;

// 成员集合恒等的编译期证明：任一方增删档位，另一方未跟即类型报错。
type _AssertDescCoversAll = FactConfidence extends (typeof FACT_CONFIDENCE_LEVELS_DESC)[number]
  ? true
  : never;
type _AssertDescNoExtra = (typeof FACT_CONFIDENCE_LEVELS_DESC)[number] extends FactConfidence
  ? true
  : never;
const _descParity: [_AssertDescCoversAll, _AssertDescNoExtra] = [true, true];
void _descParity;

export const FACT_CONFIDENCE_RANK: Record<FactConfidence, number> = {
  medium: 2,
  high: 3,
};

/** 置信度排序值（未知等级按 0 处理，与 SQL 的 ELSE 0 对齐）。 */
export function factConfidenceRank(confidence: string): number {
  return FACT_CONFIDENCE_RANK[confidence as FactConfidence] ?? FACT_CONFIDENCE_RANK.medium;
}
