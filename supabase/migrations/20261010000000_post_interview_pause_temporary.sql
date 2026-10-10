-- 2026-10-10：面试后转人工进入临时禁止托管，次日上海零点自动恢复。
-- 仅转换旧 InterventionService 自动生成的生效记录，保留原暂停时间和审计信息。
-- 从迁移执行日的次日零点起恢复，避免历史记录因 paused_at 很早而立即恢复 AI。
-- 配套发布：先在测试库验证；停止旧实例写入后执行生产迁移，再启动新版本。
-- 新版本使用 hosting:paused-users:v2 从数据库重建缓存，不能沿用 v1 的永久暂停快照。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

UPDATE public.user_hosting_status
SET is_permanent = false,
    pause_expires_at = (
      date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') + interval '1 day'
    ) AT TIME ZONE 'Asia/Shanghai',
    pause_reason = '人工介入暂停'
WHERE is_paused = true
  AND is_permanent = true
  AND pause_source = 'intervention'
  AND pause_reason = '面试后人工对接，需人工恢复托管';

COMMIT;
