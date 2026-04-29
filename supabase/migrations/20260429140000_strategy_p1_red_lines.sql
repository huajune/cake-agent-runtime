-- ============================================================
-- Migration: 招聘 Badcase P1 政策红线扩展（6 条）
--
-- 背景：基于 2026-04-28 招聘 Badcase 表 P1 案例分析，识别出 6 条
-- 政策级业务规则（非工具调用规则、非行为风格规则），统一沉淀进
-- strategy_config.red_lines.rules，避免散落主提示词或工具描述。
--
-- 红线分类：
--   R-11 兼职平台定位 — 禁主动问全职偏好（case: p9g8put8）
--   R-12 反歧视合规 — 禁地域歧视表述（case: y0xhmib1）
--   R-13 健康证业务流程口径（case: ub4vrq3v / 56tivr6s / nusu4pyn）
--   R-14 招募必须走线上流程（case: ywdw4hyf）
--   R-15 平台社保政策（兼职不缴）（case: j58ruy4b）
--   R-16 跟进入口归属（不分流到门店）（case: wofs2gp8）
--
-- 设计与既有 strategy_* migration 一致：用 @> 检查幂等，
-- 已存在的规则不重复追加。
-- ============================================================

DO $$
DECLARE
  rec RECORD;

  new_rules text[] := ARRAY[
    -- R-11
    '禁止主动询问候选人是否做全职偏好；平台所有岗位统一按兼职口径，候选人未提及全职时不得主动反问"想做全职还是兼职"。',
    -- R-12
    '严禁出现"不要东三省 / 不要 X 省人"等地域歧视表述；岗位含地域筛选时由 precheck 内部处理，对外按"暂时没有合适岗位"婉拒，不点明地域原因。',
    -- R-13
    '健康证业务口径：当前岗位默认都需要健康证，询问候选人时只用"有 / 无"两选；候选人答"无"时默认面试通过后再办，不得让候选人先办再来面试（岗位明确硬性要求面试前持证除外）。',
    -- R-14
    '候选人问能否直接去门店报名/应聘时，必须按线上预约流程引导，不得回复"直接去门店线下报名 / 到店找店长"等绕过线上的话术。',
    -- R-15
    '已约面阶段被追问社保（社保/五险一金/公积金等）时，直答"兼职岗位不缴纳社保"；不得回"以门店为准 / 入职后再确认"。',
    -- R-16
    '已约面阶段被追问后续对接（"店长会联系吗 / 谁对接"等）时，直答"后续由我们跟进"；不得让候选人自行联系门店或找店长。'
  ];

  rule text;
  updated_rules jsonb;
BEGIN
  FOR rec IN SELECT id, red_lines FROM strategy_config LOOP
    updated_rules := COALESCE(rec.red_lines -> 'rules', '[]'::jsonb);

    FOREACH rule IN ARRAY new_rules LOOP
      IF NOT (updated_rules @> jsonb_build_array(rule)) THEN
        updated_rules := updated_rules || to_jsonb(rule);
      END IF;
    END LOOP;

    IF updated_rules IS DISTINCT FROM COALESCE(rec.red_lines -> 'rules', '[]'::jsonb) THEN
      UPDATE strategy_config
      SET red_lines = jsonb_set(
        COALESCE(red_lines, '{}'::jsonb),
        '{rules}',
        updated_rules
      )
      WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;
