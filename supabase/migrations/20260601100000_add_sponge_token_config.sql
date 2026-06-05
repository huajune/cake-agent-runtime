-- 海绵 Duliday-Token 按托管账号映射配置。
--
-- ⚠️ 安全约定：本迁移**只播种账号→bot 的映射结构**，绝不写入明文 Duliday-Token。
--   每个账号用 `tokenEnv` 指向一个环境变量名，真实 token 由部署侧的环境变量提供
--   （resolveTokenValue 读 configService.get(tokenEnv)）。这样凭证不会进 git 历史。
--   如需在 DB 内直接维护真实 token，请由运维在 Supabase 控制台对 system_config
--   单独写入，不要把明文回填进迁移文件。
--
-- 推荐用 accounts 配置：
-- {
--   "accounts": [
--     {
--       "name": "祝东升",
--       "groupName": "小祝组",
--       "botImId": "托管账号系统 wxid / imBotId",
--       "botUserId": "托管账号企微 userId 或昵称",
--       "tokenEnv": "SPONGE_TOKEN_XXX"   // 指向环境变量名，真实 token 不入库
--     }
--   ]
-- }
--
-- 也支持 byBotImId / byBotUserId / byGroupId 映射；匹配顺序：
-- accounts.botImId → byBotImId → accounts.botUserId → byBotUserId → accounts.groupId → byGroupId
-- 未命中时回退环境变量 DULIDAY_API_TOKEN。
--
-- 幂等策略：ON CONFLICT DO NOTHING —— 若该 key 已存在（例如运维在 DB 内手工维护了真实
-- 配置），本迁移不覆盖，避免把线上配置冲掉。
INSERT INTO system_config (key, value, description)
VALUES (
  'sponge_token_config',
  '{
    "accounts": [
      {
        "name": "祝东升",
        "groupName": "小祝组",
        "botImId": "1688854363869800",
        "botUserId": "ZhuDongSheng",
        "tokenEnv": "SPONGE_TOKEN_ZHUDONGSHENG"
      },
      {
        "name": "祝东升",
        "groupName": "小祝组",
        "botImId": "1688857592548257",
        "botUserId": "HeMin",
        "tokenEnv": "SPONGE_TOKEN_ZHUDONGSHENG"
      },
      {
        "name": "李涵婷",
        "groupName": "南瓜组",
        "botImId": "1688854359801821",
        "botUserId": "LiHanTing",
        "tokenEnv": "SPONGE_TOKEN_LIHANTING"
      },
      {
        "name": "李宇杭",
        "groupName": "宇航组",
        "botImId": "1688855171908166",
        "botUserId": "LiYuHang",
        "tokenEnv": "SPONGE_TOKEN_LIYUHANG"
      },
      {
        "name": "高雅琪",
        "groupName": "琪琪组",
        "botImId": "1688855974513959",
        "botUserId": "gaoyaqi",
        "tokenEnv": "SPONGE_TOKEN_GAOYAQI"
      },
      {
        "name": "吴盼盼",
        "groupName": "盼盼组",
        "botImId": "1688854747775509",
        "botUserId": "WuPanPan",
        "tokenEnv": "SPONGE_TOKEN_PANPAN"
      }
    ],
    "byBotImId": {},
    "byBotUserId": {},
    "byGroupId": {}
  }'::jsonb,
  '海绵 Duliday-Token 按托管账号/小组映射配置（token 由 tokenEnv 指向的环境变量提供，不入库）'
)
ON CONFLICT (key) DO NOTHING;
