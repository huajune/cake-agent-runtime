import { isDanglingCheckReply } from '@/agent/runner/dangling-reply';

describe('isDanglingCheckReply', () => {
  it('命中 badcase batch_6a4790c7 的悬空承接句', () => {
    expect(isDanglingCheckReply('我帮你查下花桥中骏附近的岗位')).toBe(true);
  });

  it('命中其他将来时承接变体', () => {
    expect(isDanglingCheckReply('我先帮你看下哈')).toBe(true);
    expect(isDanglingCheckReply('我这就帮你核实一下')).toBe(true);
    expect(isDanglingCheckReply('好的，我看一下')).toBe(true);
  });

  it('放行带否定结论的回复（真实修复产物）', () => {
    expect(isDanglingCheckReply('花桥附近暂时没合适的岗位哈')).toBe(false);
  });

  it('放行带反问推进的回复', () => {
    expect(isDanglingCheckReply('你平时主要在上海还是昆山呀？')).toBe(false);
    expect(isDanglingCheckReply('我帮你查下，你大概在哪个商圈呀')).toBe(false);
  });

  it('放行转人工衔接话术', () => {
    expect(isDanglingCheckReply('我让同事帮你确认一下，稍等哈')).toBe(false);
  });

  it('放行带事实数字的回复', () => {
    expect(isDanglingCheckReply('这家离你大概 4.7 公里，你看下')).toBe(false);
    expect(isDanglingCheckReply('薪资 24 元一小时，你看下合不合适')).toBe(false);
  });

  it('放行空文本与长文本', () => {
    expect(isDanglingCheckReply('')).toBe(false);
    expect(
      isDanglingCheckReply('我帮你查过了，这家店在嘉定绿苑路，班次是晚上十一点半到凌晨一点半'),
    ).toBe(false);
  });

  it('放行不含承接动词的普通短回复', () => {
    expect(isDanglingCheckReply('好的哈')).toBe(false);
    expect(isDanglingCheckReply('嗯嗯，理解你的想法')).toBe(false);
  });

  it('放行让候选人自己看的祈使句（非第一人称承诺）', () => {
    expect(isDanglingCheckReply('你先看一下上面的岗位介绍哈')).toBe(false);
    expect(isDanglingCheckReply('你看一下这几家哪个方便')).toBe(false);
  });

  it('放行完成态的结果陈述（查已发生，不是空头承诺）', () => {
    expect(isDanglingCheckReply('帮你查到啦，门店就在你家附近')).toBe(false);
    expect(isDanglingCheckReply('帮你核实过了，这家周末能排班')).toBe(false);
  });

  it('拦截"这个我帮你确认下"类兜底话术（字段缺失兜底已改为当轮转人工，豁免依据不复存在）', () => {
    expect(isDanglingCheckReply('这个我帮你确认下')).toBe(true);
    expect(isDanglingCheckReply('这个我帮你确认一下哈')).toBe(true);
    expect(isDanglingCheckReply('这个帮你问下~')).toBe(true);
  });

  it('拦截查岗类将来时承诺', () => {
    expect(isDanglingCheckReply('这个我帮你查下')).toBe(true);
    expect(isDanglingCheckReply('我帮你确认下')).toBe(true);
  });
});
