import { ContextService } from '@agent/generator/context/context.service';
import { RedLinesSection } from '@agent/generator/context/sections/procedural/red-lines.section';
import { promptModelOf } from '../../../helpers/prompt-model.fixture';

// 真实旧策略的三个版本，分别来自 2026-04-30、06-17、09-24 数据迁移。
const historicalInsuranceRules = [
  '已约面阶段问社保/五险一金/公积金，直答"兼职岗位不缴纳社保"；严禁说"以门店为准 / 入职后再确认"。',
  '已约面阶段问社保/五险一金/公积金：兼职岗直答"兼职岗位不缴纳社保"；全职岗按岗位福利字段如实回答，无字段时只说"我帮你确认下"；严禁笼统说"以门店为准 / 入职后再确认"。',
  '已约面阶段问社保、五险一金或公积金时，兼职岗明确说明不缴纳社保；全职岗按岗位福利字段如实回答，无字段时先说明需要确认；严禁将未确认的责任推给门店或推迟到入职后。',
];

function modelWithRules(rules: string[]) {
  const model = promptModelOf();
  model.strategy.redLines.rules = rules;
  return model;
}

describe('SW-02 接管历史策略中的保险口径', () => {
  const service = new ContextService();
  beforeAll(async () => service.onModuleInit());

  it.each(historicalInsuranceRules)('最终提示词不再混入旧红线：%s', (oldRule) => {
    const preserved = ['禁止编造岗位信息', '岗位明确写不缴纳社保时，按本轮岗位信息如实说明。'];
    const model = modelWithRules([preserved[0], oldRule, preserved[1]]);
    const prompt = service.compose(model).systemPrompt;

    expect(prompt).not.toContain(oldRule);
    expect(prompt).toContain('insuranceFundList');
    expect(prompt).toContain('明细为空、缺失或未明确时，不等于没有');
    expect(prompt.indexOf(preserved[0])).toBeLessThan(prompt.indexOf(preserved[1]));
    // 不删除含相同政策词的新规则，也不改写数据库来源的内存对象。
    for (const rule of preserved) expect(prompt).toContain(rule);
    expect(model.strategy.redLines.rules).toEqual([preserved[0], oldRule, preserved[1]]);
  });

  it('只有已废止红线时不输出空红线段落', () => {
    expect(
      new RedLinesSection().build(modelWithRules(historicalInsuranceRules.map((r) => ` ${r} `))),
    ).toEqual([]);
  });
});
