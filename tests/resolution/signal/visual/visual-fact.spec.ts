import {
  fieldValues,
  finalizeVisualFactSheet,
  isResumeImageDescription,
  isSelfReportedVisualMessage,
  parseStoredVisualFactSheet,
  sanitizeVisualDescription,
} from '@/resolution/signal/visual';
import {
  EMOTION_MESSAGE_PREFIX,
  IMAGE_MESSAGE_PREFIX,
  isVisualDescriptionText,
  stripResumeAttachmentLines,
  stripVisualPrefix,
} from '@/resolution/signal/markers';

describe('resolution/signal/visual · finalizeVisualFactSheet', () => {
  const DESC = 'BOSS直聘岗位卡片：达美乐-兼职服务员，佛山南海区桂城';

  it('job_posting 字段默认归 publisher；candidate_address 例外归 candidate（裁决 A7）', () => {
    const sheet = finalizeVisualFactSheet(
      {
        kind: 'job_posting',
        fields: [
          { key: 'phone', value: '13788930869' },
          { key: 'brand', value: '达美乐' },
          { key: 'candidate_address', value: '南海区桂城街道' },
        ],
      },
      DESC,
    );
    expect(sheet.degraded).toBe(false);
    expect(sheet.fields.find((f) => f.key === 'phone')?.ownership).toBe('publisher');
    expect(sheet.fields.find((f) => f.key === 'brand')?.ownership).toBe('publisher');
    expect(sheet.fields.find((f) => f.key === 'candidate_address')?.ownership).toBe('candidate');
  });

  it('resume/certificate 默认归 candidate；chat_screenshot 默认 unknown', () => {
    expect(
      finalizeVisualFactSheet(
        { kind: 'resume', fields: [{ key: 'phone', value: '13500001111' }] },
        '简历图片：…',
      ).fields[0].ownership,
    ).toBe('candidate');
    expect(
      finalizeVisualFactSheet(
        { kind: 'chat_screenshot', fields: [{ key: 'phone', value: '13788930869' }] },
        '聊天截图…',
      ).fields[0].ownership,
    ).toBe('unknown');
  });

  it('显式 ownership 优先于 kind 默认', () => {
    const sheet = finalizeVisualFactSheet(
      { kind: 'chat_screenshot', fields: [{ key: 'phone', value: '137', ownership: 'candidate' }] },
      '聊天截图…',
    );
    expect(sheet.fields[0].ownership).toBe('candidate');
  });

  it('非法 kind / 非法结构一律降级 other（行为等同现状）', () => {
    expect(finalizeVisualFactSheet({ kind: 'poster' }, DESC).degraded).toBe(true);
    expect(finalizeVisualFactSheet('junk', DESC).degraded).toBe(true);
    expect(finalizeVisualFactSheet(null, DESC).degraded).toBe(true);
    expect(finalizeVisualFactSheet({ kind: 'other' }, '').degraded).toBe(true);
  });

  it('白名单外 key 只丢字段不拖垮整表（批测 32/50 实证：模型常发明 position/distance 等 key）', () => {
    const sheet = finalizeVisualFactSheet(
      {
        kind: 'job_posting',
        fields: [
          { key: 'position', value: '服务员' },
          { key: 'distance', value: '3.3km' },
          { key: 'brand', value: '达美乐' },
        ],
      },
      DESC,
    );
    expect(sheet.degraded).toBe(false);
    expect(sheet.kind).toBe('job_posting');
    expect(sheet.fields).toHaveLength(1);
    expect(sheet.fields[0].key).toBe('brand');
  });

  it("身份证形态的值一律丢弃（B3'：模型无视证件号禁令的确定性兜底）", () => {
    const sheet = finalizeVisualFactSheet(
      {
        kind: 'certificate',
        fields: [
          { key: 'other', value: '412727200401157416' },
          { key: 'name', value: '毛梦港' },
        ],
      },
      '健康证截图',
    );
    expect(sheet.fields).toHaveLength(1);
    expect(sheet.fields[0].key).toBe('name');
  });

  it('空值字段被剔除；kind 合法但 fields 缺省时按空数组', () => {
    const sheet = finalizeVisualFactSheet(
      { kind: 'map_location', fields: [{ key: 'city', value: '  ' }] },
      '高德地图截图',
    );
    expect(sheet.degraded).toBe(false);
    expect(sheet.fields).toHaveLength(0);
  });

  it('parseStoredVisualFactSheet 对库中 jsonb round-trip', () => {
    const sheet = finalizeVisualFactSheet(
      { kind: 'map_location', fields: [{ key: 'city', value: '北京市' }] },
      '高德地图截图：北京市顺义区',
    );
    const stored = JSON.parse(JSON.stringify(sheet));
    const parsed = parseStoredVisualFactSheet(stored);
    expect(parsed?.kind).toBe('map_location');
    expect(fieldValues(parsed!, 'city')).toEqual(['北京市']);
    expect(parseStoredVisualFactSheet({ garbage: true })).toBeNull();
  });
});

describe('resolution/signal/visual · 文本识别（与 channels 旧实现逐字一致）', () => {
  it('isResumeImageDescription 与旧正则同判', () => {
    expect(isResumeImageDescription('简历图片：姓名张三')).toBe(true);
    expect(isResumeImageDescription('手写简历，姓名张三')).toBe(true);
    expect(isResumeImageDescription('「简历」截图')).toBe(true);
    expect(isResumeImageDescription('Boss直聘简历列表截图')).toBe(false);
    expect(isResumeImageDescription('BOSS直聘岗位卡片')).toBe(false);
  });

  it('stripResumeAttachmentLines 剥附件行并压缩空行', () => {
    expect(stripResumeAttachmentLines('简历图片：张三\n简历附件：http://a\n电话 137')).toBe(
      '简历图片：张三\n电话 137',
    );
  });

  it('前缀识别与剥离', () => {
    expect(isVisualDescriptionText(`${IMAGE_MESSAGE_PREFIX} 描述`)).toBe(true);
    expect(isVisualDescriptionText(`${EMOTION_MESSAGE_PREFIX} 微笑`)).toBe(true);
    expect(isVisualDescriptionText('我在里水')).toBe(false);
    expect(stripVisualPrefix('[图片消息] 简历图片：张三')).toBe('简历图片：张三');
  });

  describe('rawDescription 证件号脱敏（08-07 扫描日报红标 2，chat 6a1e42e6）', () => {
    it('masks 18-digit and 15-digit ID numbers in free text', () => {
      expect(sanitizeVisualDescription('张三 13800000000 身份证 440582199003072316 入职')).toBe(
        '张三 13800000000 身份证 [身份证号已脱敏] 入职',
      );
      expect(sanitizeVisualDescription('旧证号 440582900307231')).toBe('旧证号 [身份证号已脱敏]');
      expect(sanitizeVisualDescription('尾号带X 44058219900307231X')).toBe(
        '尾号带X [身份证号已脱敏]',
      );
    });

    it('leaves phone numbers and other digit runs alone（手机号是要真消费的字段）', () => {
      const desc = '联系电话 13800000000，会议号 8123456789，工号 12345';
      expect(sanitizeVisualDescription(desc)).toBe(desc);
    });

    it('does not touch longer digit runs (19+ 位银行卡等，宁可漏不可错)', () => {
      const desc = '卡号 6222020200112345678';
      expect(sanitizeVisualDescription(desc)).toBe(desc);
    });

    it('finalize 与 parseStored 两侧的 rawDescription 都已脱敏', () => {
      const raw = '员工名单：李四 13900000000 440582199003072316';
      const sheet = finalizeVisualFactSheet({ kind: 'other', fields: [] }, raw);
      expect(sheet.rawDescription).not.toContain('440582199003072316');
      expect(sheet.rawDescription).toContain('[身份证号已脱敏]');
      // 存量行读取路径同样过一遍，无需迁移即可止血
      const stored = parseStoredVisualFactSheet({ kind: 'other', fields: [], rawDescription: raw });
      expect(stored?.rawDescription).not.toContain('440582199003072316');
    });
  });

  it('isSelfReportedVisualMessage：sheet 优先、文本标记兜底', () => {
    const certSheet = finalizeVisualFactSheet({ kind: 'certificate' }, '健康证截图');
    expect(isSelfReportedVisualMessage('[图片消息] 健康证截图', certSheet)).toBe(true);
    const jobSheet = finalizeVisualFactSheet({ kind: 'job_posting' }, '岗位截图');
    expect(isSelfReportedVisualMessage('[图片消息] 岗位截图', jobSheet)).toBe(false);
    // 无 sheet：证件类文本认不出（这正是 sheet 的增量），简历文本标记兜底可认
    expect(isSelfReportedVisualMessage('[图片消息] 健康证截图', null)).toBe(false);
    expect(isSelfReportedVisualMessage('[图片消息] 简历图片：张三', null)).toBe(true);
  });
});
