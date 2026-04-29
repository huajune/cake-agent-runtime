import { detectOutputLeak } from '@/channels/wecom/message/utils/output-leak-guard.util';

describe('detectOutputLeak', () => {
  it('returns null for normal candidate-facing content', () => {
    expect(detectOutputLeak('好的～面试时间安排在明天 14:00，地点是绿地缤纷城店。')).toBeNull();
    expect(detectOutputLeak('收到，我帮你登记一下，请发下姓名和电话。')).toBeNull();
    expect(detectOutputLeak('')).toBeNull();
  });

  it('flags stage-switch leakage (badcase vllg7hlu)', () => {
    expect(
      detectOutputLeak('阶段已切换到 job_consultation，等待候选人回复年龄信息。'),
    ).not.toBeNull();
    expect(detectOutputLeak('阶段切换到 interview_scheduling')).not.toBeNull();
    expect(detectOutputLeak('阶段推进到 booking_confirmation')).not.toBeNull();
  });

  it('flags internal stage strategy field names', () => {
    expect(detectOutputLeak('当前阶段策略是先收集年龄')).not.toBeNull();
    expect(detectOutputLeak('effectiveStageStrategy: ...')).not.toBeNull();
    expect(detectOutputLeak('nextStage = job_consultation')).not.toBeNull();
    expect(detectOutputLeak('disallowedActions 不允许这样做')).not.toBeNull();
  });

  it('flags wait-for-candidate echo of stage transition', () => {
    expect(detectOutputLeak('等待候选人提供年龄信息')).not.toBeNull();
    expect(detectOutputLeak('等待候选人补充健康证信息')).not.toBeNull();
    expect(detectOutputLeak('等待候选人确认门店信息')).not.toBeNull();
  });

  it('flags tool-call echo', () => {
    expect(detectOutputLeak('调用 advance_stage 切换阶段')).not.toBeNull();
    expect(detectOutputLeak('我来调用duliday_job_list查一下')).not.toBeNull();
    expect(detectOutputLeak('invoke request_handoff')).not.toBeNull();
  });

  it('flags raw JSON tool result snippets', () => {
    expect(detectOutputLeak('{"success":true,"jobId":1}')).not.toBeNull();
    expect(detectOutputLeak("{ 'success' : false }")).not.toBeNull();
  });

  it('flags markdown code fences', () => {
    expect(detectOutputLeak('```json\n{}\n```')).not.toBeNull();
    expect(detectOutputLeak('```typescript\nconst x = 1;')).not.toBeNull();
  });

  it('does not over-trigger on benign uses of stage word in regular Chinese', () => {
    // "阶段" 单独出现不算泄漏（招聘对话里可能合法说"现在这个阶段"）
    expect(detectOutputLeak('我们这个岗位的招聘阶段是先做线上面试')).toBeNull();
    // 普通 success 字段单词（无引号 JSON 结构）不应误伤
    expect(detectOutputLeak('面试 success 与否取决于你和门店店长聊得怎么样')).toBeNull();
  });
});
