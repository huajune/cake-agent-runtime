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

describe('detectInvalidModelOutput - 工具调用文本化泄漏', () => {
  // 生产形态：模型没走 tool-call 通道，把调用整块写成 JSON（pretty-print，带换行）。
  const LEAKED_BLOB = `{
  "tool_name": "duliday_interview_booking",
  "arguments": {
    "jobId": 529147,
    "interviewTime": "2026-09-02 13:30:00"
  }
}`;

  it('正文含协议名字键 + 入参键 → block', () => {
    const hit = detectInvalidModelOutput(LEAKED_BLOB);
    expect(hit?.ruleId).toBe('invalid_model_output');
    expect(hit?.action).toBe('block');
  });

  it('blob 混在候选人可见文本中间同样命中', () => {
    const hit = detectInvalidModelOutput(`好的，我这就帮你提交\n${LEAKED_BLOB}\n稍等一下`);
    expect(hit?.action).toBe('block');
  });

  it.each([
    ['单行紧凑形态', '{"tool_name":"duliday_job_list","arguments":{"cityName":"上海"}}'],
    ['驼峰名字键', '{"toolName": "invite_to_group", "args": {"chatId": "abc"}}'],
    ['tool_use 形态', '{"tool_use": "geocode", "tool_input": {"address": "浦东"}}'],
  ])('%s 命中', (_label, text) => {
    expect(detectInvalidModelOutput(text)?.action).toBe('block');
  });

  it('裸 name 键不命中——普通 JSON 里太常见', () => {
    expect(detectInvalidModelOutput('{"name": "张三", "arguments": {"age": 22}}')).toBeNull();
  });

  it('只有名字键、没有入参键不命中', () => {
    expect(detectInvalidModelOutput('{"tool_name": "duliday_job_list"}')).toBeNull();
  });

  it('名字键与入参键相隔整段不算同一个 blob', () => {
    const text = `{"tool_name": "duliday_job_list"}${'。正常话术'.repeat(120)}{"arguments": {}}`;
    expect(detectInvalidModelOutput(text)).toBeNull();
  });

  it('正常回复不命中', () => {
    expect(detectInvalidModelOutput('已经帮你约好周四下午三点，记得带身份证')).toBeNull();
  });
});
