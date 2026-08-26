import { produceTurnHints } from '@resolution/evidence/producers/rule-track';
import { projectTurnHints } from '@resolution/evidence/merge';
import { finalizeVisualFactSheet, type FinalizedVisualFactSheet } from '@/resolution/signal/visual';

function extractTurnHints(...args: Parameters<typeof produceTurnHints>) {
  return projectTurnHints(produceTurnHints(...args));
}

/**
 * visual-fact-structuring R1/R1e/R3 规则轨授权域回归。
 *
 * 三通道模型（产品方案附录 A.2）在规则轨的投影：
 * - job_posting sheet：全关（薪资≠期望薪资、门店城市≠候选人城市、门槛≠候选人属性）
 * - map_location sheet：仅地理
 * - resume/certificate sheet：身份可提但 phone 除外（裁决 B3：medium+确认升级）
 * - 无 sheet 视觉消息：身份关、偏好和地理开
 */
describe('规则轨 · sheet 授权域', () => {
  const JOB_DESC =
    '[图片消息] BOSS直聘岗位卡片：达美乐-兼职服务员，佛山南海区桂城，薪资5000-6000元/月。面试基本都过，18岁以上+健康证即可。';
  const jobSheet = finalizeVisualFactSheet(
    {
      kind: 'job_posting',
      fields: [{ key: 'brand', value: '达美乐' }],
    },
    JOB_DESC,
  );
  const sheets = (entries: Array<[string, FinalizedVisualFactSheet]>) =>
    new Map(entries.map(([content, sheet]) => [content.trim(), sheet] as const));

  it('R1e：岗位卡薪资不再进 pref.salary（vkikct39 同案 6000元/月 污染）', () => {
    const withSheet = extractTurnHints([JOB_DESC], [], {
      visualSheetsByContent: sheets([[JOB_DESC, jobSheet]]),
    });
    expect(withSheet?.preferences.salary ?? null).toBeNull();
    expect(withSheet?.interview_info.age ?? null).toBeNull();

    // 对照：无 sheet（旧数据/降级）保持 PR #870 现状——偏好照旧提取，身份仍拦
    const withoutSheet = extractTurnHints([JOB_DESC], []);
    expect(withoutSheet?.preferences.salary).toBe('6000元/月');
    expect(withoutSheet?.interview_info.age ?? null).toBeNull();
  });

  it('R1e：岗位卡门店城市不进 pref.city（x3pdj7qh 族）', () => {
    const desc = '[图片消息] 招聘平台截图：杭州滨江区中赢国际店在招服务员';
    const sheet = finalizeVisualFactSheet(
      { kind: 'job_posting', fields: [{ key: 'store', value: '中赢国际店' }] },
      desc,
    );
    const facts = extractTurnHints([desc], [], {
      visualSheetsByContent: sheets([[desc, sheet]]),
    });
    expect(facts?.preferences.city ?? null).toBeNull();
  });

  it('R3：map_location 仅地理——城市可提，身份/偏好全关', () => {
    const desc = '[图片消息] 高德地图截图：北京市顺义区富林路，用户定位点附近，18号楼';
    const sheet = finalizeVisualFactSheet(
      { kind: 'map_location', fields: [{ key: 'city', value: '北京市' }] },
      desc,
    );
    const facts = extractTurnHints([desc], [], {
      visualSheetsByContent: sheets([[desc, sheet]]),
    });
    expect(facts?.preferences.city?.value).toBe('北京');
    expect(facts?.interview_info.age ?? null).toBeNull();
  });

  it('B3：简历 sheet 身份可提但 phone 不经规则轨落 high', () => {
    // 结构化逐行形态（vision 简历提取的真实输出形态；规则轨结构化正则要求行首锚定）
    const desc = '[图片消息] 简历图片：\n姓名：李耀海\n电话：13500001111\n年龄：22\n学历：大专';
    const sheet = finalizeVisualFactSheet({ kind: 'resume' }, desc);
    const facts = extractTurnHints([desc], [], {
      visualSheetsByContent: sheets([[desc, sheet]]),
    });
    expect(facts?.interview_info.age).toBe('22');
    expect(facts?.interview_info.name).toBe('李耀海');
    // phone 刻意不经规则轨（high）——LLM 轨 medium + 确认问答升级（裁决 B3）
    expect(facts?.interview_info.phone ?? null).toBeNull();
  });

  it('certificate sheet：证件属自陈材料身份域开；无 sheet 时文本标记认不出证件、身份域关', () => {
    // 结构化逐行形态（vision 证件提取的输出要求"按字段逐项输出"）
    const desc = '[图片消息] 食品健康证：\n姓名：毛梦港\n发证日期：2026-08-02\n从业范围：食品';
    const certSheet = finalizeVisualFactSheet({ kind: 'certificate' }, desc);
    const withSheet = extractTurnHints([desc], [], {
      visualSheetsByContent: sheets([[desc, certSheet]]),
    });
    const withoutSheet = extractTurnHints([desc], []);
    expect(withSheet?.interview_info.name).toBe('毛梦港');
    expect(withoutSheet?.interview_info.name ?? null).toBeNull();
    // phone 域在证件上同样关闭（B3——本图无号码，此断言防未来回归）
    expect(withSheet?.interview_info.phone ?? null).toBeNull();
  });

  // 评审阻断项回归（2026-08-05）：生产窗口消息带 injectTimeContext 时间后缀，
  // sheetFor 查表键若不剥后缀则 sheet 授权域静默失效——fixture 必须带真实后缀。
  it('带时间后缀的窗口消息仍能命中 sheet（生产真实形态）', () => {
    const suffixed = `${JOB_DESC}\n[消息发送时间：2026-08-05 14:00 星期三]`;
    const facts = extractTurnHints([suffixed], [], {
      visualSheetsByContent: sheets([[JOB_DESC, jobSheet]]),
    });
    // sheet 命中 → job_posting 全关（薪资/年龄都不提取）
    expect(facts?.preferences.salary ?? null).toBeNull();
    expect(facts?.interview_info.age ?? null).toBeNull();
  });

  // 评审阻断项回归：education 兜底路径同受身份域门控——
  // 岗位截图"学历要求：大专以上"不得被 extractEducation 兜底捡走。
  it('岗位截图里的学历要求不进 education（兜底路径门控）', () => {
    const desc = '[图片消息] BOSS直聘岗位截图：学历要求：大专以上，经验不限';
    const sheet = finalizeVisualFactSheet({ kind: 'job_posting' }, desc);
    const withSheet = extractTurnHints([desc], [], {
      visualSheetsByContent: sheets([[desc, sheet]]),
    });
    const withoutSheet = extractTurnHints([desc], []);
    expect(withSheet?.interview_info.education ?? null).toBeNull();
    expect(withoutSheet?.interview_info.education ?? null).toBeNull();
    // 对照：手打自述学历照常提取
    const typed = extractTurnHints(['我是大专学历'], []);
    expect(typed?.interview_info.education ?? null).not.toBeNull();
  });

  it('手打文本不受任何影响', () => {
    const facts = extractTurnHints(['我今年22岁，想找佛山的兼职'], [], {
      visualSheetsByContent: sheets([]),
    });
    expect(facts?.interview_info.age).toBe('22');
    expect(facts?.preferences.city?.value).toBe('佛山');
  });
});
