export interface FeishuReceiver {
  openId: string;
  name: string;
}

/**
 * 飞书通知接收人公共配置。
 * 统一维护成员 open_id，避免不同告警场景重复硬编码。
 */
export const FEISHU_RECEIVER_USERS = {
  AI_JIANG: { openId: 'ou_72e8d17db5dab36e4feeddfccaa6568d', name: '艾酱' },
  GAO_YAQI: { openId: 'ou_54b8b053840d689ae42d3ab6b61800d8', name: '高雅琪' },
} as const satisfies Record<string, FeishuReceiver>;
