import { countScenarioDialogueTurns } from '@test-suite/utils/scenario-turn-count.util';

describe('countScenarioDialogueTurns', () => {
  it('counts user history messages plus the current scenario message', () => {
    expect(
      countScenarioDialogueTurns({
        message: '现在上海还有岗位吗',
        history: [
          { role: 'user', content: '你好' },
          { role: 'assistant', content: '你好呀' },
          { role: 'user', content: '我想找兼职' },
        ],
      }),
    ).toBe(3);
  });

  it('does not double count when the current message is already in history', () => {
    expect(
      countScenarioDialogueTurns({
        message: '我明天能面试吗',
        history: [
          { role: 'user', content: '我明天能面试吗' },
          { role: 'assistant', content: '可以，我帮你看看' },
        ],
      }),
    ).toBe(1);
  });

  it('supports localized user role labels', () => {
    expect(
      countScenarioDialogueTurns({
        message: '工资多少',
        history: [{ role: '候选人', content: '还招人吗' }],
      }),
    ).toBe(2);
  });
});
