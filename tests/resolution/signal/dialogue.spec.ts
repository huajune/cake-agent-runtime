import {
  isAffirmativeAnswer,
  isAffirmativeAnswerSequence,
  normalizeShortAnswer,
} from '@resolution/signal/dialogue';

const seq = (text: string) => isAffirmativeAnswerSequence(normalizeShortAnswer(text));
const single = (text: string) => isAffirmativeAnswer(normalizeShortAnswer(text));

describe('isAffirmativeAnswerSequence（组合式肯定，recap 确认通道）', () => {
  it.each(['对', '对的', '没问题', '好的', '确认', '嗯嗯'])(
    '单短答与作证词表行为一致：%s',
    (text) => {
      expect(single(text)).toBe(true);
      expect(seq(text)).toBe(true);
    },
  );

  it.each([
    '对的，没问题',
    '嗯嗯可以',
    '是的没错',
    '对对对',
    '嗯嗯，好的',
    '可以',
    '可以的',
    '对的，是我的本名',
  ])('组合式确认命中：%s', (text) => {
    expect(seq(text)).toBe(true);
  });

  it.each([
    '行', // 2026-08-27 生产复现：不在表里导致 recap 确认整轮退化（batch …_1787812777667）
    '行的',
    '行吧',
    '好',
    '好嘞',
    '好呀',
    '中',
    '妥了',
    '要得',
    '得嘞',
    '没毛病',
    '阔以',
    '可以呀',
    'OK',
    'ok',
    'okay',
    '嗯呐',
    '约吧',
    '提交吧',
    '报名吧',
    '行，没问题',
    '好的确认无误',
  ])('复述确认扩展词命中（recap 通道）：%s', (text) => {
    expect(seq(text)).toBe(true);
  });

  it.each([
    '行吗', // 疑问形态：吗 不是 token，切分失败
    '行不行',
    '好了', // "好了"是叫停/收尾语气，不是对提交的放行
    '中午',
    '不行',
    '不好',
    '别提交了',
    '先别约吧',
  ])('扩展词的疑问/否定/歧义形态不命中：%s', (text) => {
    expect(seq(text)).toBe(false);
  });

  it.each([
    '对的，但是电话错了', // 否定混排必须留给 correct 纠错路径，不得判确认
    '可以问一下',
    '可以问一下吗',
    '不对',
    '不是',
    '好的我再想想',
    '对吗',
    '没问题吗',
    '年龄不是25，是26',
    '',
  ])('掺入异质内容整体不命中：%s', (text) => {
    expect(seq(text)).toBe(false);
  });

  it('超长输入直接判否（短答语义 + 防歧义切分回溯放大）', () => {
    expect(seq(`${'嗯'.repeat(30)}呢`)).toBe(false);
  });

  it('作证词表不随组合通道扩散：可以/组合句仍不命中单短答匹配', () => {
    expect(single('可以')).toBe(false);
    expect(single('对的，没问题')).toBe(false);
    expect(single('嗯嗯可以')).toBe(false);
  });
});
