import {
  detectOutputLeak,
  hasTechnicalDocumentationShape,
  isInternalReasoningArtifactOnly,
  isToolCallArtifactOnly,
  stripInternalReasoningArtifacts,
  stripMarkdownCodeFences,
  tryUnwrapEnvelopeReply,
} from '@agent/guardrail/output/rules/internal-info-leaks.rule';

describe('internal reasoning artifacts — 2026-08-20 production cluster', () => {
  it.each([
    '</antThinking>',
    'Now confirmed 0 results twice. Proceeding with the script and group invite',
    '我应该简洁地回答这两个问题',
    '根据工具查询结果，接下来应该先告诉候选人暂无岗位',
  ])('detects evidence-backed leak form: %s', (draft) => {
    expect(detectOutputLeak(draft)).not.toBeNull();
    expect(isInternalReasoningArtifactOnly(draft)).toBe(true);
  });

  it('strips only the leaked line and preserves candidate-facing content verbatim', () => {
    const draft = [
      'Now confirmed 0 results twice. Proceeding with the script and group invite',
      '目前附近暂时没有合适岗位，有新岗位我再及时告诉你。',
    ].join('\n');
    expect(stripInternalReasoningArtifacts(draft)).toBe(
      '目前附近暂时没有合适岗位，有新岗位我再及时告诉你。',
    );
  });

  it('does not treat ordinary first-person recruiter wording as internal reasoning', () => {
    const reply = '我先帮你看看附近的岗位，你比较想做餐饮还是零售呀？';
    expect(detectOutputLeak(reply)).toBeNull();
    expect(stripInternalReasoningArtifacts(reply)).toBe(reply);
  });
});

describe('stripMarkdownCodeFences', () => {
  it('removes fence markers while preserving the wrapped form template verbatim', () => {
    const draft = [
      '面试时间有周三、周四、周五的 10:30-15:00，你先填下资料。',
      '',
      '```text',
      '面试要求：先将以下资料补充下发给我，我来帮你约面试',
      '姓名：',
      '联系方式：',
      '```',
    ].join('\n');

    const stripped = stripMarkdownCodeFences(draft);

    expect(stripped).toContain('面试要求：先将以下资料补充下发给我，我来帮你约面试');
    expect(stripped).toContain('姓名：');
    expect(stripped).toContain('联系方式：');
    expect(stripped).not.toContain('```');
    // 剥离后不再命中泄漏词库——这是 runner 确定性快通道的放行前提
    expect(detectOutputLeak(stripped)).toBeNull();
  });

  it('keeps trailing content when the fence marker shares a line with text', () => {
    const stripped = stripMarkdownCodeFences('```text 面试要求：补充资料\n姓名：\n```');
    expect(stripped).toBe('面试要求：补充资料\n姓名：');
  });

  it('collapses the blank gap left by removed fence lines', () => {
    const stripped = stripMarkdownCodeFences('第一段\n\n```\n表单内容\n```\n\n第二段');
    expect(stripped).not.toMatch(/\n{3,}/);
    expect(stripped).toContain('表单内容');
  });

  it('returns text unchanged when there is no fence', () => {
    const plain = '正常回复，没有围栏。\n1. 选项一\n2. 选项二';
    expect(stripMarkdownCodeFences(plain)).toBe(plain);
  });

  it('does not clear other leak patterns: tool-name leak still detected after stripping', () => {
    const stripped = stripMarkdownCodeFences('```json\n{"name":"duliday_job_list"}\n```');
    expect(detectOutputLeak(stripped)).not.toBeNull();
  });
});

/**
 * 模型降级时可能停止发起工具调用，把调用语法当正文输出。
 * 这类输出必须被识别为内部信息泄漏，不能交给宽泛重写生成新事实。
 */
describe('isToolCallArtifactOnly', () => {
  it('识别 XML 骨架残文（trace …_1785222323383）', () => {
    const draft = [
      '<tool_call>',
      '<invoke name="duliday_job_list">',
      '<parameter name="cityNameList">["广州"]</parameter>',
      '<parameter name="regionNameList">["海珠区"]</parameter>',
      '<parameter name="includeJobSalary">true</parameter>',
      '</invoke>',
    ].join('\n');
    expect(isToolCallArtifactOnly(draft)).toBe(true);
  });

  it('识别 JSON 残文（trace …_1785222466898）', () => {
    expect(
      isToolCallArtifactOnly(
        '{"name": "geocode", "parameters": {"address": "沈河区东陵路", "city": "沈阳"}}',
      ),
    ).toBe(true);
  });

  it('识别调用式与裸工具名残文（trace …_1785222571474 / …_1785222602702）', () => {
    expect(isToolCallArtifactOnly('geocode(address="海珠", city="广州")')).toBe(true);
    expect(isToolCallArtifactOnly('duliday_job_list')).toBe(true);
    expect(isToolCallArtifactOnly('geocode')).toBe(true);
  });

  it('放行含候选人可见正文的回复——哪怕它同时泄漏了工具名', () => {
    expect(isToolCallArtifactOnly('我调用 duliday_job_list 帮你查了下，海珠这边有三家在招')).toBe(
      false,
    );
  });

  it('放行正常回复与空文本', () => {
    expect(isToolCallArtifactOnly('好的，你在哪个区呀？我帮你看看附近的岗位')).toBe(false);
    expect(isToolCallArtifactOnly('')).toBe(false);
  });

  // 2026-08-04 审计漏杀实证：`<function invite_to_group>` 流进 rewrite 编出
  // "已经拉你进群了"并投递（…_1785727574268）；`</thinking><function=skip_reply>`
  // 同窗漏判（…_1785809940049）。旧 XML 组只认 function_call/s，参数值也剥不掉。
  it('识别 <function> 裸标签残文（trace …_1785727574268）', () => {
    const draft = [
      '<function invite_to_group>',
      '<parameter=city>',
      '上海',
      '</parameter>',
      '<parameter=industry>',
      '餐饮',
      '</parameter>',
      '</function>',
    ].join('\n');
    expect(isToolCallArtifactOnly(draft)).toBe(true);
  });

  it('识别 thinking + function= 残文（trace …_1785809940049）', () => {
    expect(isToolCallArtifactOnly('</thinking>\n\n<function=skip_reply>\n</function>')).toBe(true);
  });

  // 裸 `</function_calls>` 不含已注册工具名，仍必须依靠 XML 标签判据命中。
  it('识别裸 </function_calls> 闭合标签残文（badcase 8pu8f8we）', () => {
    expect(isToolCallArtifactOnly('</function_calls>')).toBe(true);
    expect(isToolCallArtifactOnly('<function_calls>')).toBe(true);
    expect(isToolCallArtifactOnly('</function_call>')).toBe(true);
  });

  // 2026-08-04 审计静默误伤 ×2：JSON 信封裹着完整正文，字符串字面量剥离把好回复
  // 连壳剥掉后被判纯残文整轮静默。信封不算残文，应走拆封路径。
  it('JSON 信封不算残文（trace …_1785736076695 / …_1785820152687）', () => {
    expect(
      isToolCallArtifactOnly(
        '{"censorStatus":"ok","_replyInstruction":"不客气～面试当天记得带好身份证，有问题随时找我哈"}',
      ),
    ).toBe(false);
    expect(
      isToolCallArtifactOnly(
        '{\n"agent_response": "好的，我帮你看下罗湖附近在招的岗位哈～\\n\\n先问下，你倾向哪类工作呀？比如餐饮、零售、咖啡茶饮这些，还是不限品牌都可以看看？"\n}',
      ),
    ).toBe(false);
  });

  it('tool_use 信封仍判残文（trace …_1785746625937，reason 是内部理由非话术）', () => {
    expect(
      isToolCallArtifactOnly(
        '{"type":"tool_use","id":"toolu_bdrk_01QZ7X8Y9Z0A1B2C3D4E5F6G","name":"request_handoff","input":{"reasonCode":"salary_admin_inquiry","reason":"候选人追问必胜客十里河店培训期具体天数，岗位数据未明确该信息","missingJobInfo":["培训期天数"],"actionAdvice":"确认必胜客十里河店的培训期天数并告知候选人"}}',
      ),
    ).toBe(true);
  });
});

describe('tryUnwrapEnvelopeReply', () => {
  it('拆出 censorStatus 信封正文（trace …_1785736076695）', () => {
    expect(
      tryUnwrapEnvelopeReply(
        '{"censorStatus":"ok","_replyInstruction":"不客气～面试当天记得带好身份证，有问题随时找我哈"}',
      ),
    ).toBe('不客气～面试当天记得带好身份证，有问题随时找我哈');
  });

  it('拆出 agent_response 信封正文（trace …_1785820152687）', () => {
    expect(
      tryUnwrapEnvelopeReply(
        '{\n"agent_response": "好的，我帮你看下罗湖附近在招的岗位哈～先问下，你倾向哪类工作呀？"\n}',
      ),
    ).toBe('好的，我帮你看下罗湖附近在招的岗位哈～先问下，你倾向哪类工作呀？');
  });

  it('tool_use 结构键一律不拆（内部升级理由不是候选人话术）', () => {
    expect(
      tryUnwrapEnvelopeReply(
        '{"type":"tool_use","name":"request_handoff","input":{"reason":"候选人追问必胜客十里河店培训期具体天数"}}',
      ),
    ).toBeNull();
    expect(
      tryUnwrapEnvelopeReply(
        '{"name":"geocode","arguments":{"address":"沈河区东陵路","city":"沈阳"}}',
      ),
    ).toBeNull();
  });

  it('多个候选正文时不猜测', () => {
    expect(
      tryUnwrapEnvelopeReply(
        '{"a":"你好呀我是招聘经理今天有岗位","b":"另一条完整中文回复内容在这里"}',
      ),
    ).toBeNull();
  });

  it('正文自身带泄漏形态时不拆', () => {
    expect(
      tryUnwrapEnvelopeReply(
        '{"agent_response":"阶段已切换到岗位咨询阶段，等待候选人反馈意向信息"}',
      ),
    ).toBeNull();
  });

  it('非 JSON / 短中文 / 非对象不拆', () => {
    expect(tryUnwrapEnvelopeReply('好的，我帮你看下')).toBeNull();
    expect(tryUnwrapEnvelopeReply('{"censorStatus":"ok"}')).toBeNull();
    expect(tryUnwrapEnvelopeReply('["好的，我帮你看下罗湖附近在招的岗位哈"]')).toBeNull();
  });
});

/**
 * 确定性剥围栏快通道的领域合规前置。
 */
describe('hasTechnicalDocumentationShape', () => {
  it('识别跨域接口设计答案（trace …_1785222187376，剥围栏后原样投递给了候选人）', () => {
    const stripped = stripMarkdownCodeFences(
      [
        '明白。既然 TjybappHousingConfirm 表中的金额字段已经是“元 × 10000”的整型存储，那么接口返回时直接透传原值即可。',
        '',
        '```json',
        '{',
        '"confirm_id": "C202310250001",',
        '"amount": 150000',
        '}',
        '```',
        '',
        '### 核心映射规则',
        '| 原始表字段 | 返回JSON字段 | 处理方式 |',
        '| `amount` | `amount` | 整型原值透传 |',
      ].join('\n'),
    );

    expect(detectOutputLeak(stripped)).toBeNull(); // 剥完词库确实不再命中——正是旧快通道放行的原因
    expect(hasTechnicalDocumentationShape(stripped)).toBe(true);
  });

  it('放行报名表模板——2026-07-21 锚定判例的最小修复路径不受影响', () => {
    const stripped = stripMarkdownCodeFences(
      [
        '面试时间有周三、周四的 10:30-15:00，你先填下资料。',
        '```text',
        '姓名：',
        '联系方式：',
        '性别：',
        '年龄：',
        '应聘门店：上海宝山芈城科创中心店',
        '```',
      ].join('\n'),
    );

    expect(hasTechnicalDocumentationShape(stripped)).toBe(false);
  });

  it('放行只含单一弱信号的正常回复', () => {
    expect(hasTechnicalDocumentationShape('这个岗位要求填几个字段，你把姓名发我就行')).toBe(false);
    expect(hasTechnicalDocumentationShape('')).toBe(false);
  });
});

/**
 * 泄漏检测与残文剥离必须共用 TOOL_CALL_XML_TAG_SOURCE，
 * 确保 `</function_calls>` 等新形态不会只在一侧生效。
 */
describe('detectOutputLeak — 工具调用 XML 标签', () => {
  it.each([
    '</function_calls>',
    '<function_calls>',
    '</function_call>',
    '<tool_call>',
    '</tool_use>',
    '<invoke name="foo">',
    '</thinking>',
  ])('命中工具调用标签形态：%s', (draft) => {
    expect(detectOutputLeak(draft)).not.toBeNull();
  });

  it('放行不含工具调用标签的正常候选人话术', () => {
    expect(detectOutputLeak('好的，你在哪个区呀？我帮你看看附近的岗位')).toBeNull();
    expect(detectOutputLeak('薪资是基础 24 元/时，月工时超 40 小时的部分 26 元/时')).toBeNull();
    // 中文正文里出现半角尖括号不应被误判成标签
    expect(detectOutputLeak('面试时间 10:00 <到> 12:00 之间都可以')).toBeNull();
  });
});
