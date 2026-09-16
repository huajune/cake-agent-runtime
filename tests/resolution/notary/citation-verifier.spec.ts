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

  it('纯数字引文必须在来源里独立成数，不能是手机号等更长数字串里的一段', () => {
    expect(verifyCitation({ quote: '22' }, ['手机号：13910384722']).reason).toBe(
      'citation_not_found',
    );
    expect(verifyCitation({ quote: '22' }, ['年龄：22']).verified).toBe(true);
    expect(verifyCitation({ quote: '65' }, ['65\n实际65']).verified).toBe(true);
    // 一行一个数作答：空白是分界，不能被去空白折叠成 22160
    expect(verifyCitation({ quote: '22' }, ['22\n160']).verified).toBe(true);
    expect(verifyCitation({ quote: '160' }, ['22\n160']).verified).toBe(true);
    // 候选人在数字中间打空格仍算同一个数
    expect(verifyCitation({ quote: '13910384709' }, ['139 1038 4709']).verified).toBe(true);
    expect(verifyCitation({ quote: '２２' }, ['我22岁']).verified).toBe(true);
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
