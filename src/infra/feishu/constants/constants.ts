/**
 * 飞书相关常量配置
 * 硬编码配置作为默认值，支持环境变量覆盖
 */

/**
 * 飞书 Webhook 配置
 */
export const FEISHU_WEBHOOKS = {
  // 飞书告警群（系统告警、话术降级等）
  ALERT: {
    URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/6443d7e6-384c-4750-b9de-b98b8cb2b5b2',
    SECRET: 'i2b5xaeTXmK3S7RnqHOjsb',
  },
  // 面试报名通知群（面试预约成功通知）
  INTERVIEW_BOOKING: {
    URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/c3e291d6-74bd-4a7c-b983-7a9d10e5f031',
    SECRET: 'HqZxSdbyK0P6X3thQFdbHb',
  },
} as const;

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

/**
 * 飞书通知接收人配置
 * 使用飞书 open_id（可从飞书管理后台获取）
 *
 * 获取 open_id 方法：
 * 1. 在飞书群里 @某人，然后复制消息链接，链接中包含 open_id
 * 2. 或通过飞书开放平台 API 获取用户信息
 * 3. 飞书管理后台 → 通讯录 → 成员详情页可查看
 *
 * 注意：自定义机器人只支持使用 open_id @ 人，不支持手机号/邮箱
 *
 * 使用场景：
 * - DEFAULT: 普通告警（ERROR 级别），如 Agent API 错误等
 * - FALLBACK: 话术降级告警，需要人工介入回复用户
 * - CRITICAL: 严重告警（CRITICAL 级别），如用户长时间无响应
 * - INTERVIEW_BOOKING: 面试预约成功通知
 */
export const ALERT_RECEIVERS = {
  // 默认告警接收人列表（Agent 错误、消息处理错误等）
  DEFAULT: [{ openId: 'ou_72e8d17db5dab36e4feeddfccaa6568d', name: '艾酱' }] as Array<{
    openId: string;
    name: string;
  }>,

  // 话术降级告警接收人（需要人工介入回复用户）
  FALLBACK: [{ openId: 'ou_54b8b053840d689ae42d3ab6b61800d8', name: '琪琪' }] as Array<{
    openId: string;
    name: string;
  }>,

  // 严重告警接收人（CRITICAL 级别，如用户无响应）
  CRITICAL: [{ openId: 'ou_72e8d17db5dab36e4feeddfccaa6568d', name: '艾酱' }] as Array<{
    openId: string;
    name: string;
  }>,

  // 面试预约成功通知接收人
  INTERVIEW_BOOKING: [{ openId: 'ou_54b8b053840d689ae42d3ab6b61800d8', name: '琪琪' }] as Array<{
    openId: string;
    name: string;
  }>,
} as const;
