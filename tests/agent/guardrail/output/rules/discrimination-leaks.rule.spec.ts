import { DISCRIMINATION_LEAK_RULES } from '@agent/guardrail/output/rules/discrimination-leaks.rule';

function ruleById(ruleId: string) {
  const rule = DISCRIMINATION_LEAK_RULES.find((r) => r.ruleId === ruleId);
  if (!rule) throw new Error(`rule ${ruleId} not registered`);
  return rule;
}

const screeningLeak = ruleById('discriminatory_screening_leak');
const originProbe = ruleById('sensitive_origin_probe');

describe('discriminatory_screening_leak', () => {
  // 2026-08-06 badcase（chat 6a744a86，记录 249939）：属性与"要求"之间插一个"有"
  // 就整条漏拦，投递给候选人后当场被质问。
  it.each([
    '这家对户籍有要求，方便问一下你老家是哪里的吗',
    '这家门店户籍这块有要求',
    '这个岗位专业方面有明确要求',
    '民族有限制',
    '户籍要求比较特殊',
  ])('拦住把敏感门槛作为条件说出口：%s', (reply) => {
    expect(screeningLeak.keywords.test(reply)).toBe(true);
  });

  it.each([
    '户籍没有要求',
    '这家没有户籍要求',
    '专业要求：不限',
    '专业不限，学历初中以上就行',
    '户籍这块没有要求，哪里人都能报',
  ])('放行"不卡这类条件"的合规安抚：%s', (reply) => {
    expect(screeningLeak.keywords.test(reply)).toBe(false);
  });
});

describe('sensitive_origin_probe', () => {
  // 生产实测的 6 条同族探问（2026-07-10 ~ 08-06 窗口），4 条自带编造借口。
  it.each([
    '这家对户籍有要求，方便问一下你老家是哪里的吗',
    '方便问下你是哪里人呀，公司这边登记需要核对下户籍信息',
    '方便问下你是天津本地人吗？公司这边登记需要核对下户籍信息',
    '方便问一下你今年多大、是哪边人吗？',
    '方便问下你今年多大呀？还有老家是哪边的？我帮你核对下能不能报',
    '你这边有想去的城市吗？或者你老家是哪边的，我帮你看看那边有没有包住的岗位',
  ])('拦住向候选人打听籍贯/老家/是否本地人：%s', (reply) => {
    expect(originProbe.keywords.test(reply)).toBe(true);
  });

  it.each([
    // 与地域筛选无关的关怀/排班话术：同窗口内的真实回复，不得误伤。
    '你先忙家里的事，回老家路上注意安全',
    '明天那个面试你要是赶不上也不用管，等你回老家回来后随时微我，我第一时间帮你重新约',
    '你周末回老家的话，会影响出勤吗？如果周末经常不在，可能和门店排班对不上',
    // 合规替代品：开放式问常驻/意向城市。
    '方便问一下你常驻在哪个城市吗？我帮你看下匹配的岗位',
    '你想去哪个城市工作呀',
    // 放宽口径不是探问。
    '不管哪里人都能报',
    '本地人外地人都招的',
    // 收资 checklist 的表单字段是既定报名流程，不在覆盖范围。
    '麻烦把下面资料填下发我，我帮你约：\n姓名：\n联系方式：\n籍贯/户籍：',
  ])('放行关怀话术、中性询问与收资表单字段：%s', (reply) => {
    expect(originProbe.keywords.test(reply)).toBe(false);
  });
});
