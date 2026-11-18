import type { FeishuReceiver } from '@infra/feishu/interfaces/receiver.interface';

// 仅用于通知行为测试的虚拟身份，与生产名单无关。
export const TEST_OPERATIONS_RECEIVER: FeishuReceiver = {
  openId: 'ou_test_operations',
  name: '运营测试',
};
export const TEST_BOT_RECEIVERS: Record<string, FeishuReceiver> = {
  '1688855974513959': TEST_OPERATIONS_RECEIVER,
  '1688855468965879': { openId: 'ou_test_account', name: '账号测试' },
};
