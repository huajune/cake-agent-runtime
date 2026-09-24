import {
  DESCRIPTION_MAX_LENGTH,
  buildTaskDescription,
  containsSensitiveTopic,
  redactSensitiveNumbers,
  type DescriptionInput,
} from '@notification/feishu-task/intervention-task-description';

function baseInput(overrides: Partial<DescriptionInput> = {}): DescriptionInput {
  return {
    category: 'T2',
    categoryLabel: '预约协调',
    reasonCodeLabel: '改约/取消',
    reason: '候选人要改到周四下午',
    workOrderId: 12345,
    jobId: 678,
    brandStore: '瑞幸-徐家汇店',
    interviewTimeText: '2026-09-23 10:00',
    lastCandidateMessage: '周四下午可以吗',
    recentMessages: [
      { role: 'user', content: '你好', timestamp: 1_790_000_000_000 },
      { role: 'assistant', content: '您好，请问方便什么时候面试？', timestamp: 1_790_000_060_000 },
      { role: 'user', content: '周四下午可以吗', timestamp: 1_790_000_120_000 },
    ],
    chatId: 'chat-1',
    hostingAccountName: '东升',
    candidatePhone: '13812345678',
    triggeredAt: new Date('2026-09-22T02:00:00Z'),
    ...overrides,
  };
}

describe('redactSensitiveNumbers', () => {
  it('隐藏 18 位与 15 位身份证号', () => {
    expect(redactSensitiveNumbers('我身份证是310101199001011234')).toBe(
      '我身份证是[身份证号已隐藏]',
    );
    expect(redactSensitiveNumbers('号码 31010119900101123X 对吗')).toBe(
      '号码 [身份证号已隐藏] 对吗',
    );
    expect(redactSensitiveNumbers('老证 310101900101123')).toBe('老证 [身份证号已隐藏]');
  });

  it('隐藏 16–19 位银行卡号', () => {
    expect(redactSensitiveNumbers('卡号6222021234567890123')).toBe('卡号[银行卡号已隐藏]');
    expect(redactSensitiveNumbers('6222 0212 3456 7890')).toBe('6222 0212 3456 7890'); // 带空格不算连续数字，保守不动
  });

  it('保留候选人本人手机号，隐藏第三方手机号', () => {
    const text = '我是13812345678，我朋友是13987654321，还有 139 8765 4322';
    expect(redactSensitiveNumbers(text, '13812345678')).toBe(
      '我是13812345678，我朋友是[第三方手机号已隐藏]，还有 [第三方手机号已隐藏]',
    );
  });

  it('没有本人手机号时所有手机号都隐藏', () => {
    expect(redactSensitiveNumbers('电话13812345678', null)).toBe('电话[第三方手机号已隐藏]');
  });

  it('工单号等短数字不受影响', () => {
    expect(redactSensitiveNumbers('工单 1234567 岗位 98765')).toBe('工单 1234567 岗位 98765');
  });
});

describe('containsSensitiveTopic', () => {
  it('残障 / 工伤 / 健康状况命中', () => {
    expect(containsSensitiveTopic('我有听障可以吗')).toBe(true);
    expect(containsSensitiveTopic('上周工伤还没赔')).toBe(true);
    expect(containsSensitiveTopic('身体不好能做吗')).toBe(true);
  });

  it('「健康证」是岗位要求，不算健康内容', () => {
    expect(containsSensitiveTopic('需要健康证吗')).toBe(false);
    expect(containsSensitiveTopic('健康证怎么办')).toBe(false);
  });
});

describe('buildTaskDescription', () => {
  it('固定段在前，随后按时间正序贴对话', () => {
    const text = buildTaskDescription(baseInput());
    expect(text).toContain('【原因】候选人要改到周四下午');
    expect(text).toContain('【工单】12345');
    expect(text).toContain('【岗位】瑞幸-徐家汇店 · jobId 678');
    expect(text).toContain('【面试时间】2026-09-23 10:00');
    expect(text).toContain('【托管账号】东升');
    expect(text).toContain('【候选人最后一句】周四下午可以吗');
    const transcriptIndex = text.indexOf('【近期对话】');
    expect(transcriptIndex).toBeGreaterThan(text.indexOf('【会话ID】'));
    expect(text.indexOf('候选人] 你好')).toBeLessThan(text.indexOf('候选人] 周四下午可以吗'));
  });

  it('无工单时注明「系统无工单记录」', () => {
    expect(buildTaskDescription(baseInput({ workOrderId: null }))).toContain(
      '【工单】系统无工单记录',
    );
  });

  it('对话原文脱敏第三方手机号与身份证号', () => {
    const text = buildTaskDescription(
      baseInput({
        recentMessages: [
          { role: 'user', content: '帮我朋友也报一下 13987654321', timestamp: 1 },
          { role: 'user', content: '身份证310101199001011234', timestamp: 2 },
        ],
      }),
    );
    expect(text).not.toContain('13987654321');
    expect(text).not.toContain('310101199001011234');
    expect(text).toContain('[第三方手机号已隐藏]');
    expect(text).toContain('[身份证号已隐藏]');
  });

  it('T7 不贴对话原文', () => {
    const text = buildTaskDescription(baseInput({ category: 'T7', categoryLabel: '风险与合规' }));
    expect(text).not.toContain('【近期对话】\n');
    expect(text).toContain('详见企微会话');
    expect(text).not.toContain('候选人] 你好');
  });

  it('对话含残障 / 工伤内容时不贴原文', () => {
    const text = buildTaskDescription(
      baseInput({
        recentMessages: [{ role: 'user', content: '我有听障，门店能接受吗', timestamp: 1 }],
        lastCandidateMessage: '我有听障，门店能接受吗',
      }),
    );
    expect(text).not.toContain('听障');
    expect(text).toContain('【候选人最后一句】涉及敏感内容，详见企微会话');
  });

  it('每条截 150 字、从最新往回填、总长不超过 2800', () => {
    const long = '很长的一句话'.repeat(60); // 360 字
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: 'user' as const,
      content: `${i}-${long}`,
      timestamp: 1_790_000_000_000 + i * 1000,
    }));
    const text = buildTaskDescription(baseInput({ recentMessages: messages }));
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH);
    expect(text).toContain('候选人] 39-');
    expect(text).not.toContain('候选人] 0-');
    const lines = text.split('\n').filter((line) => line.startsWith('['));
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(150 + '[09-22 10:00 候选人] '.length);
    }
  });
});
