-- 托管成员配置含海绵凭据，只允许服务端读取。
-- 可独立于 Dashboard 隔离版本应用：现有后端通过 service_role 读取，
-- 浏览器没有直接读取此配置的合法入口；其他配置项的策略保持不变。
ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hosting_member_config_server_only ON public.system_config;
CREATE POLICY hosting_member_config_server_only ON public.system_config
  AS RESTRICTIVE FOR SELECT TO anon, authenticated
  USING (key <> 'hosting_member_config');
