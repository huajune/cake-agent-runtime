import {
  containsSimulatedToolExchange,
  detectInvalidModelOutput,
} from '@agent/guardrail/output/rules/invalid-model-output.rule';

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

describe('containsSimulatedToolExchange - generator 零工具重生成判据', () => {
  it('JSON 调用形态（与 containsLeakedToolCallBlob 同源）命中', () => {
    expect(
      containsSimulatedToolExchange(
        '{"tool_name":"duliday_interview_booking","arguments":{"jobId":529147}}',
      ),
    ).toBe(true);
  });

  it.each([
    [
      'Anthropic XML 调用（chat 6a97b336 09-07 假预约）',
      '<function_calls>\n<invoke name="duliday_interview_precheck">\n<parameter name="mode">validate</parameter>\n</invoke>\n</function_calls>',
    ],
    [
      'tool_calls XML 调用',
      '<tool_calls>\n<invoke name="duliday_interview_precheck">\n<parameter name="jobId">529171</parameter>\n</invoke>\n</tool_calls>',
    ],
    [
      'Qwen 函数标记',
      '<function=advance_stage>\n<parameter=nextStage>job_consultation</parameter>\n</function>',
    ],
    [
      '方括号 API 往返（chat 6a978813 09-02 假"没查到"）',
      '[API 调用: geocode] 参数: {"address": "布吉三联大酒店", "city": "深圳"}\n[API 返回: {"_cityConfirmed": "已确认城市：深圳", "resolution": "unique"}]',
    ],
    [
      '回执标记',
      '<function result>\n{"_cityConfirmed":"已确认城市：南京市","resolution":"unique"}',
    ],
    ['tool_response 尾标', '{ "error": { "code": 429 } } </tool_response>'],
  ])('%s 命中', (_label, text) => {
    expect(containsSimulatedToolExchange(text)).toBe(true);
  });

  it('同构记录表 JSON 假回执命中（chat 6aa0cf1e 09-09 编造 5 家门店）', () => {
    const fakeJobList = JSON.stringify(
      {
        jobList: [
          {
            jobId: 432206,
            jobName: '瑞幸咖啡-佛山北滘公园店-店员-小时工',
            distanceKm: 0.8,
            salary: '20元/小时',
          },
          {
            jobId: 431895,
            jobName: '奈雪的茶-佛山北滘店-店员-小时工',
            distanceKm: 0.9,
            salary: '19-22元/小时',
          },
        ],
      },
      null,
      2,
    );
    expect(containsSimulatedToolExchange(fakeJobList)).toBe(true);
    expect(
      containsSimulatedToolExchange(
        '[消息发送时间：2026-09-01 18:25 星期二] { "source": "job_list", "results": [ {"jobId": 1, "storeName": "a", "brandName": "b", "workTime": "07:00-19:00"}, {"jobId": 2, "storeName": "c", "brandName": "d", "workTime": "08:00-20:00"} ] }',
      ),
    ).toBe(true);
  });

  it('单键对象数组不命中——候选人贴进来的 proposal / 表单结构', () => {
    expect(
      containsSimulatedToolExchange(
        '[{"properties":{"labelTitle":"社会身份","value":"社会人士"}},{"properties":{"labelTitle":"年龄","value":"26"}}]',
      ),
    ).toBe(false);
  });

  it('单个对象或 2 个共享键以下的数组不命中', () => {
    expect(containsSimulatedToolExchange('[{"jobId": 1, "storeName": "a", "salary": "20"}]')).toBe(
      false,
    );
    expect(
      containsSimulatedToolExchange('[{"jobId": 1, "storeName": "a"}, {"jobId": 2, "note": "b"}]'),
    ).toBe(false);
  });

  it('自然语言思考与普通回复不命中', () => {
    expect(containsSimulatedToolExchange('候选人还没给地址，先问区域。')).toBe(false);
    expect(containsSimulatedToolExchange('这家店在[静安大悦城]，你方便过去吗')).toBe(false);
    expect(containsSimulatedToolExchange('{"replyInstruction":"继续推进岗位咨询"}')).toBe(false);
    expect(containsSimulatedToolExchange('')).toBe(false);
  });
});
