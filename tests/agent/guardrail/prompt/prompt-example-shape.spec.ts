import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { REGISTERED_PROMPT_EXAMPLE_VALUES } from '@agent/guardrail/prompt/example-registry';
import { CANDIDATE_PHONE_RE } from '@resolution/candidate/phone';

interface PromptSurface {
  id: string;
  source: string;
}

interface TextFragment {
  text: string;
  line: number;
}

interface ExampleShapeViolation {
  source: string;
  line: number;
  kind: 'person_name' | 'phone';
  value: string;
}

const PROMPT_ASSETS: readonly PromptSurface[] = [
  {
    id: 'candidate-consultation',
    source: 'src/agent/generator/context/prompts/candidate-consultation.md',
  },
  {
    id: 'candidate-consultation-final-check',
    source: 'src/agent/generator/context/prompts/candidate-consultation-final-check.md',
  },
];

/** ContextService.registerSections 的 14 个模型可见 section 实例；StaticSection 有两个实例。 */
const PROMPT_SECTION_BUILDERS: readonly PromptSurface[] = [
  { id: 'identity', source: 'src/agent/generator/context/sections/identity.section.ts' },
  { id: 'base-manual', source: 'src/agent/generator/context/sections/static.section.ts' },
  { id: 'policy', source: 'src/agent/generator/context/sections/policy.section.ts' },
  {
    id: 'runtime-context',
    source: 'src/agent/generator/context/sections/runtime-context.section.ts',
  },
  { id: 'final-check', source: 'src/agent/generator/context/sections/static.section.ts' },
  { id: 'red-lines', source: 'src/agent/generator/context/sections/red-lines.section.ts' },
  { id: 'thresholds', source: 'src/agent/generator/context/sections/thresholds.section.ts' },
  {
    id: 'stage-strategy',
    source: 'src/agent/generator/context/sections/stage-strategy.section.ts',
  },
  { id: 'memory', source: 'src/agent/generator/context/sections/memory.section.ts' },
  { id: 'turn-hints', source: 'src/agent/generator/context/sections/turn-hints.section.ts' },
  {
    id: 'hard-constraints',
    source: 'src/agent/generator/context/sections/hard-constraints.section.ts',
  },
  { id: 'datetime', source: 'src/agent/generator/context/sections/datetime.section.ts' },
  { id: 'channel', source: 'src/agent/generator/context/sections/channel.section.ts' },
  {
    id: 'group-inventory',
    source: 'src/agent/generator/context/sections/group-inventory.section.ts',
  },
];

/** 全部一线工具的 description / schema describe 模型可见面；显式枚举防新文件静默漏扫。 */
const TOOL_DESCRIPTION_BUILDERS: readonly PromptSurface[] = [
  { id: 'advance-stage', source: 'src/tools/advance-stage.tool.ts' },
  { id: 'cancel-work-order', source: 'src/tools/duliday-cancel-work-order.tool.ts' },
  { id: 'interview-booking', source: 'src/tools/duliday-interview-booking.tool.ts' },
  { id: 'interview-precheck', source: 'src/tools/duliday-interview-precheck.tool.ts' },
  { id: 'job-list', source: 'src/tools/duliday-job-list.tool.ts' },
  { id: 'modify-interview-time', source: 'src/tools/duliday-modify-interview-time.tool.ts' },
  { id: 'geocode', source: 'src/tools/geocode.tool.ts' },
  { id: 'invite-to-group', source: 'src/tools/invite-to-group.tool.ts' },
  { id: 'raise-risk-alert', source: 'src/tools/raise-risk-alert.tool.ts' },
  { id: 'read-resume-attachment', source: 'src/tools/read-resume-attachment.tool.ts' },
  { id: 'recall-history', source: 'src/tools/recall-history.tool.ts' },
  { id: 'request-handoff', source: 'src/tools/request-handoff.tool.ts' },
  { id: 'save-image-description', source: 'src/tools/save-image-description.tool.ts' },
  { id: 'send-store-location', source: 'src/tools/send-store-location.tool.ts' },
  { id: 'skip-reply', source: 'src/tools/skip-reply.tool.ts' },
];

const EXTRACTION_PROMPTS: readonly PromptSurface[] = [
  { id: 'session-extraction', source: 'src/memory/services/session-extraction.prompt.ts' },
];

const ALL_SURFACES = [
  ...PROMPT_ASSETS,
  ...PROMPT_SECTION_BUILDERS,
  ...TOOL_DESCRIPTION_BUILDERS,
  ...EXTRACTION_PROMPTS,
] as const;

// CI 静态形状扫描，不参与任何运行时自然语言裁决。姓名只认「姓名/名字：值」或紧邻
// 姓名语境、以常见姓氏开头的引号串；避免把“周结算”“陆家嘴”等普通短语误作人名。
const EXPLICIT_NAME_VALUE = /(?:姓名|名字)\s*[：:]\s*([一-鿿]{2,4})/gu;
const QUOTED_CJK_VALUE = /["“「『]([一-鿿]{2,4})["”」』]/gu;
const COMMON_SURNAME_PREFIXES = new Set(
  [...'赵钱孙李周吴郑王冯陈卫蒋沈韩杨朱秦许何吕张曹金魏陶姜谢彭鲁韦马方袁柳史唐薛雷贺倪汤罗郝安常傅顾孟黄萧尹姚汪毛戴宋熊董梁杜阮贾郭林徐高夏蔡田胡霍陆邓曾廖钟'],
);
const PERSON_CONTEXT_MARKERS = ['姓名', '名字', '真名', '称呼', '昵称'];

function lineOffset(text: string, index: number): number {
  return text.slice(0, index).split('\n').length - 1;
}

function extractTsStringFragments(source: string, fileName: string): TextFragment[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const fragments: TextFragment[] = [];
  const push = (node: ts.Node, text: string): void => {
    fragments.push({
      text,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      push(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      push(node.head, node.head.text);
      for (const span of node.templateSpans) push(span.literal, span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return fragments;
}

function readModelVisibleFragments(surface: PromptSurface): TextFragment[] {
  const absolutePath = resolve(process.cwd(), surface.source);
  const source = readFileSync(absolutePath, 'utf8');
  if (surface.source.endsWith('.md')) {
    return [{ text: source.replace(/<!--[\s\S]*?-->/gu, ''), line: 1 }];
  }
  return extractTsStringFragments(source, surface.source);
}

function findViolationsInFragment(
  fragment: TextFragment,
  source: string,
): ExampleShapeViolation[] {
  const violations: ExampleShapeViolation[] = [];
  const seen = new Set<string>();
  const record = (
    kind: ExampleShapeViolation['kind'],
    value: string,
    index: number,
  ): void => {
    if (REGISTERED_PROMPT_EXAMPLE_VALUES.has(value)) return;
    const key = `${kind}:${value}:${index}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({
      source,
      line: fragment.line + lineOffset(fragment.text, index),
      kind,
      value,
    });
  };

  for (const match of fragment.text.matchAll(EXPLICIT_NAME_VALUE)) {
    record('person_name', match[1], match.index);
  }
  for (const match of fragment.text.matchAll(QUOTED_CJK_VALUE)) {
    const value = match[1];
    const window = fragment.text.slice(Math.max(0, match.index - 16), match.index + match[0].length + 16);
    const looksLikeName =
      REGISTERED_PROMPT_EXAMPLE_VALUES.has(value) ||
      (COMMON_SURNAME_PREFIXES.has(value[0]) &&
        PERSON_CONTEXT_MARKERS.some((marker) => window.includes(marker)));
    if (looksLikeName) record('person_name', value, match.index);
  }

  const phonePattern = new RegExp(CANDIDATE_PHONE_RE.source, 'gu');
  for (const match of fragment.text.matchAll(phonePattern)) {
    record('phone', match[1], match.index);
  }
  return violations;
}

function scanSurface(surface: PromptSurface): ExampleShapeViolation[] {
  return readModelVisibleFragments(surface).flatMap((fragment) =>
    findViolationsInFragment(fragment, surface.source),
  );
}

describe('prompt example shape CI guard', () => {
  it('keeps the census surface explicit: 2 assets, 14 sections, all tool descriptions, extraction prompt', () => {
    expect(PROMPT_ASSETS).toHaveLength(2);
    expect(PROMPT_SECTION_BUILDERS).toHaveLength(14);
    expect(TOOL_DESCRIPTION_BUILDERS.length).toBeGreaterThanOrEqual(13);
    expect(EXTRACTION_PROMPTS).toHaveLength(1);
    expect(new Set(ALL_SURFACES.map((surface) => surface.id)).size).toBe(ALL_SURFACES.length);
  });

  it('rejects unregistered person-name and phone shapes from every enumerated model-visible surface', () => {
    const violations = ALL_SURFACES.flatMap(scanSurface);
    expect(violations).toEqual([]);
  });

  it('proves the scanner catches unregistered values in production-shaped prompt text', () => {
    const productionShapedPrompt = [
      '[引用 候选人：上一轮资料]',
      '[图片消息]',
      '候选人连续消息一：姓名：王小明',
      '候选人连续消息二：手机号 13712345678',
      '[消息发送时间：2026-08-13 10:24:31]',
    ].join('\n');

    expect(
      findViolationsInFragment({ text: productionShapedPrompt, line: 1 }, 'injected-fixture'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'person_name', value: '王小明' }),
        expect.objectContaining({ kind: 'phone', value: '13712345678' }),
      ]),
    );
  });
});
