-- ============================================
-- 面试预约记录表
-- ============================================

-- === 全量建表（新环境使用） ===
CREATE TABLE IF NOT EXISTS interview_booking_records (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- 预约信息
  date DATE NOT NULL,                            -- 预约日期
  brand_name TEXT,                               -- 品牌名称
  store_name TEXT,                               -- 门店名称
  booking_count INTEGER DEFAULT 1,               -- 预约次数（通常为 1）

  -- 用户信息
  chat_id VARCHAR(255),                          -- 会话ID
  user_id VARCHAR(255),                          -- 用户系统ID
  user_name VARCHAR(255),                        -- 用户昵称

  -- 招募经理信息
  manager_id VARCHAR(255),                       -- 招募经理ID
  manager_name VARCHAR(255),                     -- 招募经理昵称

  -- 系统字段
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- === 迁移脚本（从 booking_stats 升级，已执行可跳过） ===
-- ALTER TABLE booking_stats RENAME TO interview_booking_records;
-- ALTER TABLE interview_booking_records
-- ADD COLUMN IF NOT EXISTS chat_id VARCHAR(255),
-- ADD COLUMN IF NOT EXISTS user_id VARCHAR(255),
-- ADD COLUMN IF NOT EXISTS user_name VARCHAR(255),
-- ADD COLUMN IF NOT EXISTS manager_id VARCHAR(255),
-- ADD COLUMN IF NOT EXISTS manager_name VARCHAR(255);

-- Step 3: 索引
-- 按用户查询
CREATE INDEX IF NOT EXISTS idx_interview_booking_user_id
  ON interview_booking_records(user_id)
  WHERE user_id IS NOT NULL;

-- 按招募经理查询
CREATE INDEX IF NOT EXISTS idx_interview_booking_manager_id
  ON interview_booking_records(manager_id)
  WHERE manager_id IS NOT NULL;

-- 按日期+招募经理查询（招募经理业绩统计）
CREATE INDEX IF NOT EXISTS idx_interview_booking_date_manager
  ON interview_booking_records(date, manager_id)
  WHERE manager_id IS NOT NULL;

-- 按日期查询（日报统计）
CREATE INDEX IF NOT EXISTS idx_interview_booking_date
  ON interview_booking_records(date);

-- 按品牌查询
CREATE INDEX IF NOT EXISTS idx_interview_booking_brand
  ON interview_booking_records(brand_name)
  WHERE brand_name IS NOT NULL;

-- Step 4: 注释
COMMENT ON TABLE interview_booking_records IS '面试预约记录表，每次成功预约创建一条记录';
COMMENT ON COLUMN interview_booking_records.date IS '预约日期';
COMMENT ON COLUMN interview_booking_records.brand_name IS '品牌名称';
COMMENT ON COLUMN interview_booking_records.store_name IS '门店名称';
COMMENT ON COLUMN interview_booking_records.booking_count IS '预约次数（通常为 1）';
COMMENT ON COLUMN interview_booking_records.chat_id IS '会话ID，用于关联消息记录';
COMMENT ON COLUMN interview_booking_records.user_id IS '用户的系统 wxid (imContactId)';
COMMENT ON COLUMN interview_booking_records.user_name IS '用户昵称 (contactName)';
COMMENT ON COLUMN interview_booking_records.manager_id IS '招募经理 ID (botUserId/imBotId)';
COMMENT ON COLUMN interview_booking_records.manager_name IS '招募经理昵称';

-- ============================================
-- 表结构说明
-- ============================================
--
-- interview_booking_records 表包含以下字段：
--
-- | 字段名        | 类型         | 说明                    |
-- |--------------|--------------|-------------------------|
-- | id           | UUID         | 主键                    |
-- | date         | DATE         | 预约日期                |
-- | brand_name   | TEXT         | 品牌名称                |
-- | store_name   | TEXT         | 门店名称                |
-- | booking_count| INTEGER      | 预约次数（通常为 1）    |
-- | chat_id      | VARCHAR(255) | 会话ID                  |
-- | user_id      | VARCHAR(255) | 用户系统ID              |
-- | user_name    | VARCHAR(255) | 用户昵称                |
-- | manager_id   | VARCHAR(255) | 招募经理ID              |
-- | manager_name | VARCHAR(255) | 招募经理昵称            |
-- | created_at   | TIMESTAMPTZ  | 创建时间                |
-- | updated_at   | TIMESTAMPTZ  | 更新时间                |
--
-- ============================================
-- 统计查询示例
-- ============================================
--
-- 1. 按招募经理统计今日预约数：
-- SELECT manager_name, COUNT(*) as booking_count
-- FROM interview_booking_records
-- WHERE date = CURRENT_DATE AND manager_id IS NOT NULL
-- GROUP BY manager_id, manager_name
-- ORDER BY booking_count DESC;
--
-- 2. 按品牌+招募经理统计本周预约：
-- SELECT brand_name, manager_name, COUNT(*) as booking_count
-- FROM interview_booking_records
-- WHERE date >= CURRENT_DATE - INTERVAL '7 days'
-- GROUP BY brand_name, manager_name
-- ORDER BY brand_name, booking_count DESC;
--
-- 3. 查询某用户的预约历史：
-- SELECT date, brand_name, store_name, manager_name
-- FROM interview_booking_records
-- WHERE user_id = 'xxx'
-- ORDER BY date DESC;
--
-- ============================================
