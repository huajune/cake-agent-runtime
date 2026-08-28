/**
 * 生产形态回归族（PR #1000 评审工作约定的验收核心）。
 *
 * 共因：单测喂干净文本，生产喂「时间后缀 + debounce 拼接 + [图片消息] 占位 +
 * [引用 …] 块」的脏文本。本套件用 tests/helpers/production-message.fixture 统一
 * 构造生产形态输入，回归全部字段解析器与规则轨授权域。
 */

import { parseGender } from '@resolution/candidate/gender';
import { parseAge } from '@resolution/candidate/age';
import { parseHealthCertificateMatch } from '@resolution/candidate/health-cert';
import { parseHeight, parseWeight } from '@resolution/candidate/height-weight';
import { parseCandidateFieldsFromText } from '@resolution/candidate/collected-fields';
import { matchIdentityStatement } from '@resolution/candidate/student-identity';
import { produceTurnHints } from '@resolution/turn-hints/producers/rule-track';
import { projectTurnHints } from '@resolution/turn-hints/reducer';
import type { BrandItem } from '@/sponge/sponge.types';
import type { FinalizedVisualFactSheet } from '@resolution/signal/visual';
import {
  IMAGE_PLACEHOLDER,
  PROD_TIME_SUFFIX,
  debounceJoin,
  imageDescription,
  quotedBlock,
  withTimeSuffix,
} from '../helpers/production-message.fixture';

const brandData: BrandItem[] = [];

describe('生产形态：字段解析器', () => {
  it('gender：时间后缀 + 混合疑问子句不吞自陈（P1-10）', () => {
    expect(parseGender(withTimeSuffix('我是女的，请问多少钱？'))?.value).toBe('女');
    expect(parseGender(withTimeSuffix('找女装导购的工作，我是女的'))?.value).toBe('女');
    // 疑问/要求语境仍不得误报
    expect(parseGender(withTimeSuffix('你们要男的女的？'))).toBeNull();
    expect(parseGender(withTimeSuffix('招女生吗'))).toBeNull();
  });

  it('gender：debounce 拼接批里的自陈可召回', () => {
    expect(parseGender(debounceJoin('有什么兼职吗？', '我是男的'))?.value).toBe('男');
  });

  it('age：要求语境 + 时间后缀不误采，表单回填可召回（P1-13）', () => {
    expect(parseAge(withTimeSuffix('岗位要求 年龄22以上可做吗'))).toBeNull();
    expect(parseAge(withTimeSuffix('年龄：28'))?.value).toBe(28);
    expect(parseAge(debounceJoin('性别男 年龄28', '想找兼职'))?.value).toBe(28);
  });

  it('health-cert：跨子句「没办过」不翻转已声明的有证（P0-6）', () => {
    expect(parseHealthCertificateMatch(withTimeSuffix('我有健康证，社保还没办过'))?.value).toBe(
      '有',
    );
    expect(parseHealthCertificateMatch(withTimeSuffix('健康证没办过，可以办'))?.value).toBe(
      '无但接受办理健康证',
    );
  });

  it('height/weight：模糊尾缀 + 混合要求子句（P2-2）', () => {
    expect(parseHeight(withTimeSuffix('身高170左右'))?.value).toBe(170);
    expect(parseWeight(withTimeSuffix('体重60多'))?.value).toBe(60);
    expect(parseHeight(withTimeSuffix('岗位身高要求165以上是吧，我身高170'))?.value).toBe(170);
    expect(parseHeight(withTimeSuffix('身高要求165以上'))).toBeNull();
  });

  it('is_student：大三/在校类自陈确定性命中（P1-12）', () => {
    expect(matchIdentityStatement(withTimeSuffix('我大三，找周末兼职'))).toBe('学生');
    expect(matchIdentityStatement(withTimeSuffix('目前在校'))).toBe('学生');
    // 疑问句仍不猜
    expect(matchIdentityStatement(withTimeSuffix('你们要学生吗'))).toBeNull();
  });

  it('collected-fields：时间后缀 + 引用块逐条清洗（P1-11）', () => {
    const fields = parseCandidateFieldsFromText(
      [
        withTimeSuffix(`${quotedBlock('王店长', '联系电话13899990000')} 好的`),
        withTimeSuffix('健康证：没办过，可以办'),
        withTimeSuffix('姓名：张三 电话13812345678'),
      ],
      1,
    );
    // 引用块里店长的号码不得被当候选人手机号
    expect(fields.phone?.value).toBe('13812345678');
    expect(fields.healthCert?.value).toBe(2);
    expect(fields.name?.value).toBe('张三');
  });
});

describe('生产形态：规则轨授权域（P0-1）', () => {
  const resumeSheet: FinalizedVisualFactSheet = {
    kind: 'resume',
    fields: [],
    rawDescription: '个人简历\n姓名：李梅\n年龄：25\n学历：大专',
    degraded: false,
  };

  it('先图后文合并批：图片占位不吞同批手打身份自陈', () => {
    const facts = projectTurnHints(
      produceTurnHints(
        [withTimeSuffix(IMAGE_PLACEHOLDER), withTimeSuffix('我是女的，25岁')],
        brandData,
      ),
    );
    expect(facts?.interview_info?.gender).toBe('女');
    expect(facts?.interview_info?.age).toBe('25');
  });

  it('拼接单串（回归前形态）确会丢身份抽取——固化教训防止回退', () => {
    const joined = debounceJoin(IMAGE_PLACEHOLDER, '我是女的，25岁');
    const facts = projectTurnHints(produceTurnHints([joined], brandData));
    expect(facts?.interview_info?.gender).toBeUndefined();
  });

  it('带时间后缀的简历描述消息可按内容查到 sheet 并放行身份抽取', () => {
    const content = imageDescription('个人简历\n姓名：李梅\n年龄：25\n学历：大专');
    const facts = projectTurnHints(
      produceTurnHints([withTimeSuffix(content)], brandData, {
        visualSheetsByContent: new Map([[content, resumeSheet]]),
      }),
    );
    expect(facts?.interview_info?.age).toBe('25');
    expect(facts?.interview_info?.education).toBe('大专');
  });

  it('job_posting 截图的身份字段不入档（发布方门槛不是候选人自陈）', () => {
    const content = imageDescription('招聘海报，要求18-40岁，联系电话13777776666');
    const jobSheet: FinalizedVisualFactSheet = {
      kind: 'job_posting',
      fields: [],
      rawDescription: '招聘海报，要求18-40岁，联系电话13777776666',
      degraded: false,
    };
    const facts = projectTurnHints(
      produceTurnHints([withTimeSuffix(content)], brandData, {
        visualSheetsByContent: new Map([[content, jobSheet]]),
      }),
    );
    expect(facts?.interview_info?.age).toBeUndefined();
    expect(facts?.interview_info?.phone).toBeUndefined();
  });

  it('身份 fallback 的疑问号门按消息生效：疑问消息不污染同批陈述消息', () => {
    const facts = projectTurnHints(
      produceTurnHints(
        [withTimeSuffix('有什么兼职吗？'), withTimeSuffix('我目前待岗')],
        brandData,
      ),
    );
    expect(facts?.interview_info?.is_student).toBe(false);
  });

  it('时间后缀本身不产生任何字段（星期三不是自陈）', () => {
    const facts = produceTurnHints([`好的\n${PROD_TIME_SUFFIX}`], brandData);
    expect(facts?.claims.filter((claim) => claim.field.startsWith('interview_info')) ?? []).toEqual(
      [],
    );
  });
});
