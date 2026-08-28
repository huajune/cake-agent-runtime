import { detectAssistantEcho } from '@resolution/notary/assistant-echo';
import { verifyCitation } from '@resolution/notary/citation-verifier';
import { normalizedIncludes } from '@resolution/notary/text-normalization';

describe('notary citation primitives', () => {
  it('verifyCitation 逐字命中候选人来源语料', () => {
    expect(verifyCitation({ quote: '学历:本科ABC' }, ['学历： 本 科ＡＢＣ'])).toEqual({
      verified: true,
    });
  });

  it('空引文和不存在的引文都拒收', () => {
    expect(verifyCitation({ quote: '  ' }, ['任意原文']).reason).toBe('empty_citation');
    expect(verifyCitation({ quote: '我本科毕业了' }, ['我的学历是大学本科']).reason).toBe(
      'citation_not_found',
    );
  });

  it('不折叠标点，否定分界不能被伪造引文抹掉', () => {
    expect(normalizedIncludes('不，是学生', '不是学生')).toBe(false);
    expect(normalizedIncludes('不，是学生', '不，是学生')).toBe(true);
  });

  it('detectAssistantEcho 只标记达到最短长度且命中 Assistant 的引文', () => {
    expect(detectAssistantEcho({ quote: '欢迎应聘服务员' }, ['欢迎应聘服务员，请问多大？'])).toBe(
      true,
    );
    expect(detectAssistantEcho({ quote: '男' }, ['性别男，对吗？'])).toBe(false);
  });
});
