import {
  hasSelfReportedPhoneProvenance,
  keepSelfReportedMessages,
} from '@resolution/evidence/corpus';
import { isDigitsOnlyName } from '@resolution/candidate/name';
import { isSelfReportedVisualMessage as isResumeImageMessage } from '@resolution/visual';
// 标记形态判定已收拢至 @infra/utils/message-markup（原 isVisualDescriptionMessage）
import { isVisualDescriptionText as isVisualDescriptionMessage } from '@/infra/utils/message-markup.util';
import { produceRuleFactClaims } from '@resolution/evidence/producers/rule-track';
import { projectRuleFactClaims } from '@resolution/evidence/merge';

function extractRuleFacts(...args: Parameters<typeof produceRuleFactClaims>) {
  return projectRuleFactClaims(produceRuleFactClaims(...args));
}

/**
 * badcase 2026-08-04 `vkikct39`（chat 6a714c00…，P0）：候选人转发 BOSS 直聘岗位截图，
 * vision 描述被回写进用户消息内容，描述里的「18岁以上」门槛句与交换微信截图里
 * **招聘者（招募经理本人）的微信号**被当成候选人自陈落档，最终提交进真实报名 ——
 * AI 面试短信因此发到了经理自己的手机上（运营原话"报名填我的电话干嘛"）。
 *
 * fixture 必须用生产真实字符串（2026-08-05 复核修正）：
 * - 年龄串是「面试基本都过，18岁以上+健康证即可」——**没有「要求/需要/限/须」触发词**，
 *   extractAge 既有的岗位范围守卫剥不掉它，这才是真实穿透路径；
 * - 早期版本写成「年龄要求 18-40岁」，带触发词会被既有守卫拦下，年龄断言在
 *   没有本修复时也通过——测试空转。
 */
describe('visual-description（第三方图片内容不得当候选人自陈）', () => {
  const POSTER_PHONE = '13788930869';
  /** 生产原文节选：岗位卡片描述（含穿透既有守卫的「18岁以上」句） */
  const BOSS_JOB_CARD =
    '[图片消息] BOSS直聘岗位卡片：达美乐-兼职服务员，发布方跃橙云服B轮，地点佛山南海区桂城，' +
    '薪资5000-6000元/月。下方文字补充：13.8元/时，节假日34.5元/时。面试基本都过，18岁以上+健康证即可。';
  /** 生产原文节选：交换微信截图（号码是招聘者本人微信号） */
  const BOSS_WECHAT_EXCHANGE =
    '[图片消息] BOSS直聘聊天记录截图：候选人点击同意交换微信；' +
    `系统显示微信号-${POSTER_PHONE}可复制；候选人后续发送"你好加了"。`;

  describe('消息分类', () => {
    it('识别 vision 描述回写消息', () => {
      expect(isVisualDescriptionMessage(BOSS_JOB_CARD)).toBe(true);
      expect(isVisualDescriptionMessage('[表情消息] 一个笑脸')).toBe(true);
      expect(isVisualDescriptionMessage('我是在里水，离金明都店比较近')).toBe(false);
    });

    it('候选人自己的简历图片不算第三方内容', () => {
      const resume = '[图片消息] 简历图片：姓名 李耀海，手机号 13500001111，年龄 22';
      expect(isVisualDescriptionMessage(resume)).toBe(true);
      expect(isResumeImageMessage(resume)).toBe(true);
      expect(keepSelfReportedMessages([resume])).toEqual([resume]);
    });

    it('带"简历附件："行的图片消息同样保留', () => {
      const resume = '[图片消息] 手写简历，姓名 李耀海\n简历附件：https://example.com/a.jpg';
      expect(keepSelfReportedMessages([resume])).toHaveLength(1);
    });

    it('岗位截图被剔除，候选人手打文本保留', () => {
      const typed = '我是在里水 距离你们金明都那个店比较近';
      expect(keepSelfReportedMessages([BOSS_JOB_CARD, typed])).toEqual([typed]);
    });
  });

  describe('hasSelfReportedPhoneProvenance', () => {
    it('号码只出现在岗位截图描述里时判为无自陈出处', () => {
      expect(hasSelfReportedPhoneProvenance(POSTER_PHONE, [BOSS_WECHAT_EXCHANGE])).toBe(false);
    });

    it('候选人自己敲出的号码有出处（容忍空格分隔）', () => {
      expect(hasSelfReportedPhoneProvenance('13788930869', ['我的电话 137 8893 0869'])).toBe(true);
    });

    // 评审阻断项（引用向量）：调用方（session.service）构建自陈语料时必须先剥引用块——
    // 引用块里是经理原文，其中的号码不是候选人自陈。本用例钉住纯函数层面的语义：
    // 语料剥净后，仅存在于引用块中的号码判无出处。
    it('引用块里的经理号码不算自陈出处（语料须先剥引用块）', () => {
      const rawWithQuote = '[引用 店长：有问题打我电话13800001111] 好的';
      const stripped = '好的'; // stripQuotedBlocks(rawWithQuote) 的结果
      expect(hasSelfReportedPhoneProvenance('13800001111', [stripped], { prefiltered: true })).toBe(
        false,
      );
      // 反面：不剥引用块时会误判有出处——这正是调用方必须剥的原因
      expect(
        hasSelfReportedPhoneProvenance('13800001111', [rawWithQuote], { prefiltered: true }),
      ).toBe(true);
    });

    it('候选人简历图片里的号码有出处', () => {
      const resume = '[图片消息] 简历图片：姓名 李耀海，手机号 13788930869';
      expect(hasSelfReportedPhoneProvenance(POSTER_PHONE, [resume])).toBe(true);
    });
  });

  describe('isDigitsOnlyName', () => {
    it('纯手机号形态的 name 被判非姓名', () => {
      expect(isDigitsOnlyName('13788930869')).toBe(true);
      expect(isDigitsOnlyName(' 137-8893-0869 ')).toBe(true);
    });

    it('真实姓名与含数字昵称不误伤', () => {
      expect(isDigitsOnlyName('李耀海')).toBe(false);
      expect(isDigitsOnlyName('小明666')).toBe(false);
      expect(isDigitsOnlyName('')).toBe(false);
      expect(isDigitsOnlyName(null)).toBe(false);
    });
  });

  describe('规则提取轨回归', () => {
    it('岗位截图里的"18岁以上"不再被提成候选人年龄', () => {
      const facts = extractRuleFacts([BOSS_JOB_CARD], []);
      expect(facts?.interview_info.age ?? null).toBeNull();
    });

    // 对照钉子：同一句话若是候选人手打（非图片描述），既有提取器会命中「18岁」——
    // 证明上一条用例的 null 来自自陈收窄，而不是 extractAge 的岗位范围守卫
    //（该守卫只拦「要求/需要/限/须」前缀的范围句，本串没有触发词）。
    // 若本断言未来变红，说明 extractAge 口径变了，上一条用例需要重新选穿透串。
    it('对照：同串手打文本会命中既有年龄提取器', () => {
      const facts = extractRuleFacts(['面试基本都过，18岁以上+健康证即可。'], []);
      expect(facts?.interview_info.age).toBe('18');
    });

    it('候选人自己说的年龄仍然提取', () => {
      const facts = extractRuleFacts(['我今年22岁'], []);
      expect(facts?.interview_info.age).toBe('22');
    });

    it('岗位截图里的"仅限男"不再被提成候选人性别', () => {
      const facts = extractRuleFacts(
        ['[图片消息] 岗位截图：招夜班理货，要求仅限男，22-50岁'],
        [],
      );
      expect(facts?.interview_info.gender ?? null).toBeNull();
    });

    // 收窄只针对身份字段。候选人发地图/门店截图指位置是被期待的能力
    // （badcase oaz6inzf 的诉求正是"图上已经看到是北京了还问城市"），不能被这次收窄打掉。
    it('图片描述里的城市仍然可用于定位（收窄不外溢到 preferences/地理）', () => {
      const facts = extractRuleFacts(
        ['[图片消息] 地图截图：北京市顺义区富林路卫星店'],
        [],
      );
      expect(facts?.preferences.city?.value).toBe('北京');
    });
  });
});
