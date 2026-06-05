-- 历史 backfill：把存量 handoff_events.reason_code='other' 按 Agent 给的 reason 自由文本
-- 重新归类到新增的两个原因码（system_blocked / no_match_or_group_full）。
--
-- 背景：早期转人工分类法缺了「最常见的那一桶」——「无匹配岗位/兼职群已满，需人工拉群维护」，
-- 全冲进了 other（占比 ~78%）。新增 no_match_or_group_full / system_blocked 后，这条 backfill
-- 把存量 other 按文本归一，让转化分析的「转人工原因榜单」有分析价值。
--
-- 分类规则（与 request_handoff 工具的语义一致）：
--   1) system_blocked（优先）：precheck/booking 等工具结构性卡死（missingFields/BOOKING_REJECTED/
--      precheck/入参；面试二维码未收到需补发/补录）。
--   2) no_match_or_group_full：放宽后仍无匹配岗位，且兼职群已满/无群、需人工拉群维护/跨城跨区。
--   3) 其余（年龄/学历不符、质疑 AI、政策咨询等）保持 other。
--
-- 幂等：仅作用于仍为 'other' 且 reason 非空的行；可安全重复执行（已归类的行不会再匹配）。
UPDATE handoff_events
SET reason_code = CASE
  WHEN reason ~* 'missingFields|BOOKING_REJECTED|precheck|二维码|补发|补录|入参'
    THEN 'system_blocked'
  WHEN reason ~ '无岗|无在招|无匹配|没有岗位|无结果|查无|无可用|已满|无兼职群|无群|暂无兼职群|拉群|维护|跨城|跨区|跨市|替代'
    THEN 'no_match_or_group_full'
  ELSE reason_code
END
WHERE reason_code = 'other' AND reason IS NOT NULL;
