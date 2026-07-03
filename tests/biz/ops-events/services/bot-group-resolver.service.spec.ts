import { BotGroupResolverService } from '@biz/ops-events/services/bot-group-resolver.service';
import type { BotService } from '@channels/wecom/bot/bot.service';

describe('BotGroupResolverService', () => {
  const service = new BotGroupResolverService();

  it('resolves CongLing sync alias to 宇航组', () => {
    expect(service.resolve('prod-sync:CongLingKaiShiDeXianShiShiJie')).toEqual({
      managerName: 'CongLingKaiShiDeXianShiShiJie',
      groupName: '宇航组',
    });
    expect(service.resolve('CongLingKaiShiDeXianShiShiJie')).toEqual({
      managerName: 'CongLingKaiShiDeXianShiShiJie',
      groupName: '宇航组',
    });
  });

  it('keeps the CongLing alias on LiYuHang cake agent id', () => {
    expect(service.resolveAgentId('prod-sync:CongLingKaiShiDeXianShiShiJie')).toBe(
      'LiYuHang-cake-1',
    );
  });

  it('resolves bare numeric prod ids', () => {
    expect(service.resolve('1688855171908166')).toEqual({
      managerName: 'LiYuHang',
      groupName: '宇航组',
    });
  });

  it('strips prod-sync: prefix on numeric ids before lookup', () => {
    // 同步前缀版本应与裸 id 解析到同一小组（归一化生效）。
    expect(service.resolve('prod-sync:1688855171908166')).toEqual({
      managerName: 'LiYuHang',
      groupName: '宇航组',
    });
    expect(service.resolveAgentId('prod-sync:1688855171908166')).toBe('LiYuHang-cake-1');
  });

  it('resolves guoxiaoyang (晓阳组) on both bare and synced forms', () => {
    const expected = { managerName: '郭晓阳', groupName: '晓阳组' };
    expect(service.resolve('guoxiaoyang')).toEqual(expected);
    expect(service.resolve('prod-sync:guoxiaoyang')).toEqual(expected);
  });

  it('returns null for unmapped / synthetic bots', () => {
    expect(service.resolve('unknown-bot')).toBeNull();
    expect(service.resolve('agent-test-bot')).toBeNull();
    expect(service.resolve('1688855753660960')).toBeNull(); // 兜底表无、且未注入 Stride
    expect(service.resolve(null)).toBeNull();
    expect(service.resolve('')).toBeNull();
  });

  it('prefers the dynamic Stride mapping, indexed by both wxid and wecomUserId', async () => {
    const fakeBotService = {
      getConfiguredBotList: jest.fn(async () => [
        { wxid: '9999999999', wecomUserId: 'newbot', name: '新人', groupName: '新组' },
      ]),
    } as unknown as BotService;
    const dynamic = new BotGroupResolverService(fakeBotService);

    await dynamic.warmUp();
    const expected = { managerName: '新人', groupName: '新组' };
    expect(dynamic.resolve('9999999999')).toEqual(expected); // 数字形态 wxid
    expect(dynamic.resolve('newbot')).toEqual(expected); // 名字形态 wecomUserId
    expect(dynamic.resolve('prod-sync:newbot')).toEqual(expected); // 同步前缀归一化
    // 动态表里没有的 bot 仍回退兜底表（不破坏既有解析）。
    expect(dynamic.resolve('1688855171908166')).toEqual({
      managerName: 'LiYuHang',
      groupName: '宇航组',
    });
  });
});
