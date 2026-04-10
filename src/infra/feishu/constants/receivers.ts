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
  NAN_GUA: { openId: 'ou_954fb7341fd7fdd320de2d419d26df19', name: '南瓜' },
  LI_YUHANG: { openId: 'ou_e6868065cb0baa3c0304441a6a8c16e7', name: '李宇航' },
  ZHU_DONGSHENG: { openId: 'ou_9834f6ccffb3abdbeeabbc28581af6df', name: '祝东升' },
} as const satisfies Record<string, FeishuReceiver>;

/**
 * 托管 bot wxid → 飞书接收人映射。
 * 用于群任务通知时 @对应负责人。
 */
export const BOT_TO_RECEIVER: Record<string, FeishuReceiver> = {
  '1688855974513959': FEISHU_RECEIVER_USERS.GAO_YAQI, // 琪琪组 - 高雅琪
  '1688854747775509': FEISHU_RECEIVER_USERS.AI_JIANG, // 艾酱组 - 朱洁
  '1688855171908166': FEISHU_RECEIVER_USERS.LI_YUHANG, // 宇航组 - 李宇杭
  '1688854363869800': FEISHU_RECEIVER_USERS.ZHU_DONGSHENG, // 东升组 - 祝东升
  '1688854359801821': FEISHU_RECEIVER_USERS.NAN_GUA, // 南瓜组 - 李涵婷
};
