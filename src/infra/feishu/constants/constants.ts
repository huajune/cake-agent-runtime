/**
 * 飞书相关常量配置
 */

/**
 * 飞书 Webhook 群通道
 *
 * 只登记各通道的环境变量键名；Webhook 地址与签名密钥一律经 ConfigService 从环境变量读取，
 * 代码中不保存任何取值。URL 未配置时该通道跳过发送；SECRET 为空表示机器人未开启签名校验。
 */
export const FEISHU_WEBHOOK_CHANNELS = {
  // 蛋糕异常告警群（系统告警、话术降级等）
  ALERT: {
    ENV_URL_KEY: 'FEISHU_ALERT_WEBHOOK_URL',
    ENV_SECRET_KEY: 'FEISHU_ALERT_SECRET',
  },
  // 蛋糕群运营通知群（群满员、群任务预览/汇总等）
  MESSAGE_NOTIFICATION: {
    ENV_URL_KEY: 'MESSAGE_NOTIFICATION_WEBHOOK_URL',
    ENV_SECRET_KEY: 'MESSAGE_NOTIFICATION_WEBHOOK_SECRET',
  },
  // 蛋糕私聊监控群（面试预约成功/失败/取消、降级兜底等）
  PRIVATE_CHAT_MONITOR: {
    ENV_URL_KEY: 'PRIVATE_CHAT_MONITOR_WEBHOOK_URL',
    ENV_SECRET_KEY: 'PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET',
  },
  // 河南自招中心外部群；只接收显式配置的托管机器人通知。
  HENAN_PRIVATE_CHAT_MONITOR: {
    ENV_URL_KEY: 'HENAN_PRIVATE_CHAT_MONITOR_WEBHOOK_URL',
    ENV_SECRET_KEY: 'HENAN_PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET',
  },
} as const;

export type FeishuWebhookChannel = keyof typeof FEISHU_WEBHOOK_CHANNELS;

/**
 * 告警节流配置
 */
export const ALERT_THROTTLE = {
  WINDOW_MS: 5 * 60 * 1000, // 5 分钟节流窗口
  MAX_COUNT: 3, // 窗口内最大告警次数
} as const;
