import {
  classifySupplementLabel,
  findScreeningFailure,
  matchesScreeningFailure,
} from '@/tools/duliday/supplement-label-classifier';

describe('classifySupplementLabel', () => {
  describe('collect labels', () => {
    it.each(['学历', '有无健康证', '能干几个月', '一周能上几天班', '每天几到几点可以上班'])(
      'classifies %s as collect',
      (label) => {
        const result = classifySupplementLabel(label);
        expect(result.type).toBe('collect');
      },
    );
  });

  describe('screening labels — blacklist parentheses', () => {
    it('extracts failSignals from 专业（非新媒、食品）', () => {
      const result = classifySupplementLabel('专业（非新媒、食品）');
      expect(result.type).toBe('screening');
      if (result.type !== 'screening') return;
      expect(result.mode).toBe('blacklist');
      expect(result.failSignals).toEqual(expect.arrayContaining(['新媒', '食品']));
    });

    it('extracts failSignals from 是否学生（不要学生）', () => {
      const result = classifySupplementLabel('是否学生（不要学生）');
      expect(result.type).toBe('screening');
      if (result.type !== 'screening') return;
      expect(result.mode).toBe('blacklist');
      expect(result.failSignals).toEqual(['学生']);
    });

    it('supports 不接受 variant and halfwidth parentheses', () => {
      const result = classifySupplementLabel('岗位倾向(不接受夜班)');
      expect(result.type).toBe('screening');
      if (result.type !== 'screening') return;
      expect(result.mode).toBe('blacklist');
      expect(result.failSignals).toEqual(['夜班']);
    });
  });

  describe('screening labels — rhetorical', () => {
    it('classifies 周四六日都能上班吗 as rhetorical screening', () => {
      const result = classifySupplementLabel('周四六日都能上班吗');
      expect(result.type).toBe('screening');
      if (result.type !== 'screening') return;
      expect(result.mode).toBe('rhetorical');
      expect(result.failSignals).toEqual(
        expect.arrayContaining(['不能', '不一定', '做不了']),
      );
    });

    it('treats 问号结尾 the same as 吗 句', () => {
      const result = classifySupplementLabel('能接受晚班吗？');
      expect(result.type).toBe('screening');
    });
  });

  describe('screening labels — binary 是否 prefix without blacklist', () => {
    it('classifies 是否接受加班 as binary screening', () => {
      const result = classifySupplementLabel('是否接受加班');
      expect(result.type).toBe('screening');
      if (result.type !== 'screening') return;
      expect(result.mode).toBe('binary');
    });
  });

  describe('priority: blacklist wins over rhetorical', () => {
    it('classifies 专业（非食品）吗 as blacklist rather than rhetorical', () => {
      const result = classifySupplementLabel('专业（非食品）吗');
      expect(result.type).toBe('screening');
      if (result.type !== 'screening') return;
      expect(result.mode).toBe('blacklist');
      expect(result.failSignals).toEqual(['食品']);
    });
  });
});

describe('matchesScreeningFailure', () => {
  it('returns the matched signal when candidate answer contains blacklist keyword', () => {
    const cls = classifySupplementLabel('专业（非新媒、食品）');
    if (cls.type !== 'screening') throw new Error('expected screening');
    expect(matchesScreeningFailure(cls, '食品类')).toBe('食品');
    expect(matchesScreeningFailure(cls, '新媒体方向')).toBe('新媒');
  });

  it('returns null when candidate answer does not contain any blacklist keyword', () => {
    const cls = classifySupplementLabel('专业（非新媒、食品）');
    if (cls.type !== 'screening') throw new Error('expected screening');
    expect(matchesScreeningFailure(cls, '会计')).toBeNull();
    expect(matchesScreeningFailure(cls, '计算机')).toBeNull();
  });

  it('catches 不一定/不能 for rhetorical labels (badcase 69e9bba2)', () => {
    const cls = classifySupplementLabel('周四六日都能上班吗');
    if (cls.type !== 'screening') throw new Error('expected screening');
    expect(matchesScreeningFailure(cls, '不一定')).toBe('不一定');
    expect(matchesScreeningFailure(cls, '不能保证')).toBe('不能');
    expect(matchesScreeningFailure(cls, '保证不了')).toBe('保证不了');
  });

  it('returns null for rhetorical label when answer is affirmative or empty', () => {
    const cls = classifySupplementLabel('周四六日都能上班吗');
    if (cls.type !== 'screening') throw new Error('expected screening');
    expect(matchesScreeningFailure(cls, '可以')).toBeNull();
    expect(matchesScreeningFailure(cls, '能')).toBeNull();
    expect(matchesScreeningFailure(cls, '')).toBeNull();
  });

  it('does not false-match 不用/不错 that contain 不 but are not fail signals', () => {
    const cls = classifySupplementLabel('周四六日都能上班吗');
    if (cls.type !== 'screening') throw new Error('expected screening');
    expect(matchesScreeningFailure(cls, '不用担心')).toBeNull();
  });
});

describe('findScreeningFailure', () => {
  it('returns null when supplementAnswers is undefined or empty', () => {
    expect(findScreeningFailure(undefined)).toBeNull();
    expect(findScreeningFailure({})).toBeNull();
  });

  it('ignores collect-type labels even if answer looks suspicious', () => {
    expect(
      findScreeningFailure({
        学历: '食品类专业本科', // collect 类，不做筛选
        能干几个月: '不一定',
      }),
    ).toBeNull();
  });

  it('catches blacklist violation (badcase 69e9bba2)', () => {
    const result = findScreeningFailure({
      '专业（非新媒、食品）': '食品类',
    });
    expect(result).toEqual({
      label: '专业（非新媒、食品）',
      answer: '食品类',
      matched: '食品',
    });
  });

  it('catches rhetorical-style negative answer (badcase 69e9bba2)', () => {
    const result = findScreeningFailure({
      周四六日都能上班吗: '不一定',
    });
    expect(result).toEqual({
      label: '周四六日都能上班吗',
      answer: '不一定',
      matched: '不一定',
    });
  });

  it('catches 是否学生（不要学生） when candidate explicitly mentions 学生', () => {
    // 候选人明确提到"学生"关键词才触发；模糊的"是，在读大三"要靠 Agent 继续追问
    const result = findScreeningFailure({
      '是否学生（不要学生）': '我是大三学生',
    });
    expect(result?.label).toBe('是否学生（不要学生）');
    expect(result?.matched).toBe('学生');
  });

  it('passes when all screening answers are acceptable', () => {
    expect(
      findScreeningFailure({
        '是否学生（不要学生）': '社会人士',
        '专业（非新媒、食品）': '会计',
        周四六日都能上班吗: '可以',
        一周能上几天班: '3天', // collect 类会被跳过
      }),
    ).toBeNull();
  });

  it('skips empty or whitespace-only answers', () => {
    expect(
      findScreeningFailure({
        '专业（非新媒、食品）': '   ',
      }),
    ).toBeNull();
  });
});
