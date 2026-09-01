import { detectInvalidModelOutput } from '@agent/guardrail/output/rules/invalid-model-output.rule';

describe('detectInvalidModelOutput - 控制标记', () => {
  it.each(['[NO_REPLY]', '[no_reply]', '[NO REPLY]', '【skip】', '（silence）', '[SKIP_REPLY]'])(
    '整条回复只是控制标记 %s → block',
    (text) => {
      const hit = detectInvalidModelOutput(text);
      expect(hit?.ruleId).toBe('invalid_model_output');
      expect(hit?.action).toBe('block');
    },
  );

  it('正文里的方括号内容不命中', () => {
    expect(detectInvalidModelOutput('这家店在[静安大悦城]，你方便过去吗')).toBeNull();
  });

  it('正常回复不命中', () => {
    expect(detectInvalidModelOutput('好的，已经帮你记下了')).toBeNull();
  });
});
