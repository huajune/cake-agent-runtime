import { isGenderConfirmedInline } from '@resolution/evidence/producers/gender-confirmation';
import { assistantMsg, userMsg, withTimeSuffix } from '../../../helpers/production-message.fixture';

describe('isGenderConfirmedInline（性别表内确认，PR #1000 评审 P0-4）', () => {
  const inlineAskForm = assistantMsg(
    '帮你登记报名需要确认下面几项：\n姓名：\n联系电话：\n性别：女（如有误请改）\n年龄：',
  );

  it('肯定应答（都对的）清除确认位', () => {
    expect(isGenderConfirmedInline('女', [inlineAskForm, userMsg(withTimeSuffix('都对的'))])).toBe(
      true,
    );
  });

  it('同值复打按确认处理，反值复打是纠正', () => {
    expect(
      isGenderConfirmedInline('女', [inlineAskForm, userMsg(withTimeSuffix('我是女的'))]),
    ).toBe(true);
    expect(
      isGenderConfirmedInline('女', [inlineAskForm, userMsg(withTimeSuffix('不对，我是男的'))]),
    ).toBe(false);
  });

  it('无表内确认问句时肯定应答不构成确认', () => {
    expect(isGenderConfirmedInline('女', [userMsg('好的')])).toBe(false);
  });

  it('第一条实质应答不是肯定语时不确认（宁可漏不可错）', () => {
    expect(
      isGenderConfirmedInline('女', [inlineAskForm, userMsg(withTimeSuffix('几点面试来着'))]),
    ).toBe(false);
  });

  it('非男女值恒不确认', () => {
    expect(isGenderConfirmedInline(null, [inlineAskForm, userMsg('对的')])).toBe(false);
    expect(isGenderConfirmedInline('未知', [inlineAskForm, userMsg('对的')])).toBe(false);
  });
});
