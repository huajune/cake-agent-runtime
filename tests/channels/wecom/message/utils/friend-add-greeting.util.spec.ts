import { isPureFriendAddGreeting } from '@wecom/message/utils/friend-add-greeting.util';

describe('isPureFriendAddGreeting', () => {
  describe('排除：纯系统消息', () => {
    it.each([
      '请求添加你为朋友',
      '我通过了你的联系人验证请求，现在我们可以开始聊天了',
      '我通过了你的朋友验证请求',
    ])('「%s」应判为纯握手语（排除破冰）', (content) => {
      expect(isPureFriendAddGreeting(content)).toBe(true);
    });
  });

  describe('排除：纯默认招呼语「我是{昵称}」', () => {
    it.each(['我是🍪', '我是ZXY', '我是欣欣', '我是晚风', '我是平平安安', '我是', '我是。'])(
      '「%s」应判为纯默认招呼语（排除破冰）',
      (content) => {
        expect(isPureFriendAddGreeting(content)).toBe(true);
      },
    );
  });

  describe('保留：带求职意图的「我是…」算破冰', () => {
    it.each([
      '我是找工作的',
      '我是兼职',
      '我是找兼职的',
      '我是应聘的',
      '我是应聘者',
      '我是boss',
      '我是boss上的',
      '我是来找暑假工的',
    ])('「%s」带求职意图，不应排除', (content) => {
      expect(isPureFriendAddGreeting(content)).toBe(false);
    });
  });

  describe('保留：真实消息 / 群转介 / 长自我介绍', () => {
    it.each([
      '你好',
      '你好 我在青浦区',
      '双江路这边',
      '我是群聊"独立客&上海零售兼职②群"的Create·奇',
      '我是从大众点评看到招聘信息过来咨询的朋友',
    ])('「%s」不是纯默认招呼语', (content) => {
      expect(isPureFriendAddGreeting(content)).toBe(false);
    });
  });

  describe('边界', () => {
    it('空 / 空白 / null / undefined 返回 false', () => {
      expect(isPureFriendAddGreeting('')).toBe(false);
      expect(isPureFriendAddGreeting('   ')).toBe(false);
      expect(isPureFriendAddGreeting(null)).toBe(false);
      expect(isPureFriendAddGreeting(undefined)).toBe(false);
    });

    it('首尾空白不影响判定', () => {
      expect(isPureFriendAddGreeting('  我是🍪  ')).toBe(true);
      expect(isPureFriendAddGreeting('  请求添加你为朋友 ')).toBe(true);
    });
  });
});
