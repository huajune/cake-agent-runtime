/**
 * 飞书相关常量配置
 * 硬编码配置作为默认值，支持环境变量覆盖
 */

/**
 * 飞书 Webhook 配置
 */
export const FEISHU_WEBHOOK_CHANNELS = {
  // 蛋糕异常告警群（系统告警、话术降级等）
  ALERT: {
    URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/6443d7e6-384c-4750-b9de-b98b8cb2b5b2',
    SECRET: 'i2b5xaeTXmK3S7RnqHOjsb',
    ENV_URL_KEY: 'FEISHU_ALERT_WEBHOOK_URL',
    ENV_SECRET_KEY: 'FEISHU_ALERT_SECRET',
  },
  // 蛋糕群运营通知群（群满员、群任务预览/汇总等）
  MESSAGE_NOTIFICATION: {
    URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/c3e291d6-74bd-4a7c-b983-7a9d10e5f031',
    SECRET: 'HqZxSdbyK0P6X3thQFdbHb',
    ENV_URL_KEY: 'MESSAGE_NOTIFICATION_WEBHOOK_URL',
    ENV_SECRET_KEY: 'MESSAGE_NOTIFICATION_WEBHOOK_SECRET',
  },
  // 蛋糕私聊监控群（面试预约成功/失败、降级兜底等）
  PRIVATE_CHAT_MONITOR: {
    URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/0bc0deea-b656-4413-8d2e-2dc25720168e',
    SECRET: 'Q0UcTiCMnrLIYx1LBxxZnb',
    ENV_URL_KEY: 'PRIVATE_CHAT_MONITOR_WEBHOOK_URL',
    ENV_SECRET_KEY: 'PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET',
  },
} as const;

export type FeishuWebhookChannel = keyof typeof FEISHU_WEBHOOK_CHANNELS;

/**
 * 飞书多维表格配置
 */
export const FEISHU_BITABLE = {
  APP_ID: 'RypLwXb1yiKdRpkFN4bcvWnmnsf',
  TABLE_ID: 'tblKNwN8aquh2JAy',
} as const;

/**
 * 告警节流配置
 */
export const ALERT_THROTTLE = {
  WINDOW_MS: 5 * 60 * 1000, // 5 分钟节流窗口
  MAX_COUNT: 3, // 窗口内最大告警次数
} as const;
