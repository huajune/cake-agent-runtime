import { buildVisualSheetIndex, extractCandidateTexts } from '@resolution/signal/self-report';
import { finalizeVisualFactSheet, type FinalizedVisualFactSheet } from '@resolution/signal/visual';
import { appendTimeContext } from '@resolution/signal/markers';

/**
 * 出处池（引文公证语料）的自陈材料准入回归。
 *
 * 生产形态：候选人发来**本人健康证图片**，vision 把描述回写进 user 消息，其中逐字含
 * 「姓名：X，性别：X，年龄：X」。sheet 缺席时文本兜底只认「简历/履历」开头，证件类描述
 * 以证件自身抬头起头 → 整条被排除出出处池 → 模型引用它填字段被判
 * `source_text_not_found`，随后重复追问已答字段。
 *
 * 权威口径：visual-fact-pipeline.md 附录 A「出处门语料 = 手打 + 简历/证件 sheet 消息」。
 */
describe('出处池 · 自陈材料准入', () => {
  const CERT_DESC =
    '[图片消息] 青岛市公共卫生从业人员健康证明，类型：餐饮服务，姓名：周小雨，性别：女，年龄：30，发证日期：2025年12月22日';
  const certSheet = finalizeVisualFactSheet(
    { kind: 'certificate', fields: [{ key: 'name', value: '周小雨' }] },
    CERT_DESC,
  );

  const userMessage = (content: string) => ({ role: 'user', content });
  const sheets = (entries: Array<[string, FinalizedVisualFactSheet]>) =>
    new Map(entries.map(([content, sheet]) => [content.trim(), sheet] as const));

  it('回归：证件 sheet 在场时，本人健康证原话进出处池', () => {
    const texts = extractCandidateTexts([userMessage(CERT_DESC)], {
      visualSheetsByContent: sheets([[CERT_DESC, certSheet]]),
    });

    expect(texts).toHaveLength(1);
    // 公证按逐字子串命中，这三段正是生产里被误判 source_text_not_found 的引文
    expect(texts[0]).toContain('姓名：周小雨');
    expect(texts[0]).toContain('性别：女');
    expect(texts[0]).toContain('年龄：30');
  });

  it('对照：无 sheet 时证件描述仍被排除（修复前的生产形态）', () => {
    expect(extractCandidateTexts([userMessage(CERT_DESC)])).toEqual([]);
  });

  it('sheet 键剥时间后缀：生产窗口消息带后缀仍能命中索引', () => {
    const withSuffix = appendTimeContext(CERT_DESC, '2026-08-31 14:38');
    // 索引由库行装配（库里的 content 无后缀），查表侧是带后缀的窗口消息
    const index = buildVisualSheetIndex([{ content: CERT_DESC, visualFacts: certSheet }]);

    const texts = extractCandidateTexts([userMessage(withSuffix)], {
      visualSheetsByContent: index,
    });
    expect(texts[0]).toContain('姓名：周小雨');
  });

  it('简历文本兜底不回退：无 sheet 时「简历」开头仍进出处池', () => {
    const resume = '[图片消息] 简历：李某，26岁，有三年餐饮经验';
    expect(extractCandidateTexts([userMessage(resume)])[0]).toContain('26岁');
  });

  it('第三方截图不因接入 sheet 而放行：job_posting / chat_screenshot 仍排除', () => {
    const jobDesc =
      '[图片消息] BOSS直聘岗位卡片：达美乐兼职服务员，薪资6000元/月，联系人13800001111';
    const jobSheet = finalizeVisualFactSheet(
      { kind: 'job_posting', fields: [{ key: 'brand', value: '达美乐' }] },
      jobDesc,
    );
    const chatDesc = '[图片消息] 聊天记录截图：对方说手机号是13900002222';
    const chatSheet = finalizeVisualFactSheet({ kind: 'chat_screenshot', fields: [] }, chatDesc);

    expect(
      extractCandidateTexts([userMessage(jobDesc), userMessage(chatDesc)], {
        visualSheetsByContent: sheets([
          [jobDesc, jobSheet],
          [chatDesc, chatSheet],
        ]),
      }),
    ).toEqual([]);
  });

  it('降级 sheet 回落文本兜底，不误放行', () => {
    const index = buildVisualSheetIndex([{ content: CERT_DESC, visualFacts: { bogus: true } }]);
    expect(index.size).toBe(0);
    expect(
      extractCandidateTexts([userMessage(CERT_DESC)], { visualSheetsByContent: index }),
    ).toEqual([]);
  });

  it('手打文本不受影响', () => {
    const texts = extractCandidateTexts([userMessage('我叫周小雨，今年30岁')]);
    expect(texts).toEqual(['我叫周小雨，今年30岁']);
  });
});
