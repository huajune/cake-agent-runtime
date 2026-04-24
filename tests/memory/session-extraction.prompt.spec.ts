import { SESSION_EXTRACTION_SYSTEM_PROMPT } from '@memory/services/session-extraction.prompt';

describe('SESSION_EXTRACTION_SYSTEM_PROMPT', () => {
  it('should prevent fallback recommendations from overwriting the current applied job', () => {
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain(
      '不得把这些备选内容覆盖为 applied_store / applied_position',
    );
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain(
      '只记录用户当前正在报名、约面或明确追问详情的那个',
    );
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('保持 null，不要从较晚出现的备选推荐里猜');
  });
});
