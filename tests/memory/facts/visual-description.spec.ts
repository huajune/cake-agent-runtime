import {
  hasSelfReportedPhoneProvenance,
  isDigitsOnlyName,
  isResumeImageMessage,
  isVisualDescriptionMessage,
  keepSelfReportedMessages,
} from '@/memory/facts/visual-description';
import { extractHighConfidenceFacts } from '@/memory/facts/high-confidence-facts';

/**
 * badcase 2026-08-04 `vkikct39`（chat 6a714c00…，P0）：候选人转发 BOSS 直聘岗位截图，
 * vision 描述被回写进用户消息内容，描述里**发布方**的手机号与"18-40岁"岗位年龄区间
 * 被当成候选人自陈落档，最终提交进真实报名 —— AI 面试短信发到了招募经理手机上。
 */
describe('visual-description（第三方图片内容不得当候选人自陈）', () => {
  const POSTER_PHONE = '13788930869';
  const BOSS_SCREENSHOT =
    '[图片消息] BOSS直聘岗位截图：标题"周结深圳晚班服务员"，年龄要求 18-40岁，' +
    `联系电话 ${POSTER_PHONE}，客户公司为百胜咨询（上海）有限公司。`;

  describe('消息分类', () => {
    it('识别 vision 描述回写消息', () => {
      expect(isVisualDescriptionMessage(BOSS_SCREENSHOT)).toBe(true);
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
      expect(keepSelfReportedMessages([BOSS_SCREENSHOT, typed])).toEqual([typed]);
    });
  });

  describe('hasSelfReportedPhoneProvenance', () => {
    it('号码只出现在岗位截图描述里时判为无自陈出处', () => {
      expect(hasSelfReportedPhoneProvenance(POSTER_PHONE, [BOSS_SCREENSHOT])).toBe(false);
    });

    it('候选人自己敲出的号码有出处（容忍空格分隔）', () => {
      expect(hasSelfReportedPhoneProvenance('13788930869', ['我的电话 137 8893 0869'])).toBe(true);
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
    it('岗位截图里的"18-40岁"不再被提成候选人年龄', () => {
      const facts = extractHighConfidenceFacts([BOSS_SCREENSHOT], []);
      expect(facts?.interview_info.age ?? null).toBeNull();
    });

    it('候选人自己说的年龄仍然提取', () => {
      const facts = extractHighConfidenceFacts(['我今年22岁'], []);
      expect(facts?.interview_info.age?.value).toBe('22');
    });
  });
});
