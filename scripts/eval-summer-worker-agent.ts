import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { TestExecutionService } from '../src/biz/test-suite/services/test-execution.service';
import type { TestChatResponse } from '../src/biz/test-suite/dto/test-chat.dto';
import { MessageRole } from '../src/biz/test-suite/enums/test.enum';

interface Turn {
  message: string;
  fixedHistory?: Array<{ role: MessageRole; content: string }>;
}

interface EvalCase {
  id: string;
  title: string;
  turns: Turn[];
  expect: {
    summerIntent: 'default_no' | 'explicit_yes' | 'explicit_no' | 'sticky_yes' | 'flexible';
    forbidSummerConfirmation?: boolean;
    forbidAlternativeUpsell?: boolean;
    requireSummerGrounding?: boolean;
  };
}

interface ToolCall {
  toolName?: string;
  input?: unknown;
  output?: unknown;
}

const CASES: EvalCase[] = [
  {
    id: 'default-age-student',
    title: '19 岁学生未提暑假工：默认否，不主动追问',
    turns: [{ message: '我今年19岁，在读学生，想在上海徐家汇附近找工作' }],
    expect: { summerIntent: 'default_no', forbidSummerConfirmation: true },
  },
  {
    id: 'uncertain-does-not-flip',
    title: '候选人不确定是否算暑假工：不改变默认值',
    turns: [{ message: '我不知道自己算不算暑假工，想在上海徐家汇附近找兼职' }],
    expect: { summerIntent: 'default_no', forbidSummerConfirmation: true },
  },
  {
    id: 'explicit-summer-only',
    title: '明确只找暑假工：严格按暑假工查岗，无岗直接拒绝',
    turns: [{ message: '我只找暑假工，在上海徐家汇附近，有合适的吗？' }],
    expect: {
      summerIntent: 'explicit_yes',
      forbidAlternativeUpsell: true,
      requireSummerGrounding: true,
    },
  },
  {
    id: 'summer-alias-sticky',
    title: '“暑假做，长期也可”：允许推荐普通长期兼职，但不得改写身份',
    turns: [{ message: '我暑假做，长期也可以，在上海徐家汇附近有兼职吗？' }, { message: '可以' }],
    expect: {
      summerIntent: 'flexible',
      forbidSummerConfirmation: true,
    },
  },
  {
    id: 'explicit-not-summer',
    title: '本人明确否认暑假工：允许按长期兼职继续',
    turns: [{ message: '我不是暑假工，打算长期做，想找上海徐家汇附近的兼职' }],
    expect: { summerIntent: 'explicit_no', forbidSummerConfirmation: true },
  },
  {
    id: 'summer-exclusion',
    title: '排除暑假工不构成暑假工自认',
    turns: [{ message: '不要给我推荐暑假工，普通兼职就行，上海徐家汇附近' }],
    expect: { summerIntent: 'explicit_no', forbidSummerConfirmation: true },
  },
  {
    id: 'candidate-clears-state',
    title: '先明确暑假工、后由本人明确改口：状态才解除',
    turns: [
      { message: '我是暑假工，想在上海徐家汇附近找兼职' },
      { message: '我不是暑假工，刚才说错了，我打算长期做' },
    ],
    expect: { summerIntent: 'explicit_no', forbidSummerConfirmation: true },
  },
  {
    id: 'badcase-consent-is-not-denial',
    title: 'BadCase 回归：“可以”不能被解释为“不是暑假工”',
    turns: [
      {
        message: '可以',
        fixedHistory: [
          { role: MessageRole.USER, content: '暑假做\n长期也可' },
          {
            role: MessageRole.ASSISTANT,
            content:
              '奥乐齐有一个普通兼职岗位，岗位编号521923。明天下午3-4点可以面试，你愿意预约吗？',
          },
        ],
      },
    ],
    expect: {
      summerIntent: 'sticky_yes',
      forbidSummerConfirmation: true,
      forbidAlternativeUpsell: true,
      requireSummerGrounding: true,
    },
  },
];

const SUMMER_CONFIRMATION_PATTERN =
  /(?:回复|回|说|确认|补充).{0,18}[“"']?不是暑假工[”"']?|是否(?:是)?暑假工|是暑假工还是|暑假工还是/;
const COERCED_DENIAL_PATTERN =
  /(?:按|作为|以).{0,12}(?:非暑假工|不是暑假工).{0,16}(?:登记|报名|预约)|(?:回复|回|说).{0,18}不是暑假工/;
const ALTERNATIVE_UPSELL_PATTERN =
  /(?:要不要|是否|可以|愿意).{0,15}(?:考虑|看看|转为|改成|按).{0,12}(?:普通兼职|长期兼职|小时工|全职)|(?:普通兼职|长期兼职|小时工|全职).{0,12}(?:要不要|愿意|考虑吗|可以吗)/;

function asToolCalls(response: TestChatResponse): ToolCall[] {
  return Array.isArray(response.response.toolCalls)
    ? (response.response.toolCalls as ToolCall[])
    : [];
}

function jsonContains(value: unknown, needle: string): boolean {
  return JSON.stringify(value ?? '').includes(needle);
}

function inspectCase(testCase: EvalCase, responses: TestChatResponse[]) {
  const replyText = responses.map((response) => response.actualOutput).join('\n');
  const toolCalls = responses.flatMap(asToolCalls);
  const summerJobCalls = toolCalls.filter(
    (call) => call.toolName === 'duliday_job_list' && jsonContains(call.input, '暑假工'),
  );
  const identityRewriteInTools = toolCalls.some(
    (call) =>
      call.toolName === 'duliday_interview_precheck' &&
      (jsonContains(call.input, '不是暑假工') || jsonContains(call.input, '非暑假工')),
  );
  const failures: string[] = [];

  if (COERCED_DENIAL_PATTERN.test(replyText)) {
    failures.push('回复诱导候选人按“不是暑假工/非暑假工”登记');
  }
  if (identityRewriteInTools && testCase.expect.summerIntent === 'sticky_yes') {
    failures.push('precheck 工具参数把暑假工改写成了“不是暑假工/非暑假工”');
  }
  if (testCase.expect.forbidSummerConfirmation && SUMMER_CONFIRMATION_PATTERN.test(replyText)) {
    failures.push('不应主动追问或要求确认是否暑假工');
  }
  if (testCase.expect.forbidAlternativeUpsell && ALTERNATIVE_UPSELL_PATTERN.test(replyText)) {
    failures.push('暑假工场景主动推销普通兼职/长期兼职/小时工/全职');
  }
  if (testCase.expect.requireSummerGrounding && summerJobCalls.length === 0) {
    const hasPrecheckBlock = toolCalls.some(
      (call) =>
        call.toolName === 'duliday_interview_precheck' &&
        jsonContains(call.output, 'blocked_non_summer_job'),
    );
    const directlyAcknowledgedSummer = /暑假工|暑期工/.test(replyText);
    if (!hasPrecheckBlock && !directlyAcknowledgedSummer) {
      failures.push('未看到暑假工查岗、precheck 拦截或明确暑假工口径');
    }
  }

  return { failures, toolCalls, replyText };
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const executionService = app.get(TestExecutionService);
  const runId = Date.now();
  const report: Array<{
    id: string;
    title: string;
    passed: boolean;
    failures: string[];
    turns: Array<{ user: string; assistant: string; tools: string[]; durationMs: number }>;
  }> = [];

  try {
    for (const [caseIndex, testCase] of CASES.entries()) {
      const sessionId = `summer-agent-eval-${runId}-${testCase.id}`;
      const history: Array<{ role: MessageRole; content: string }> = [];
      const responses: TestChatResponse[] = [];
      const turns: Array<{ user: string; assistant: string; tools: string[]; durationMs: number }> =
        [];

      process.stdout.write(`\n[${caseIndex + 1}/${CASES.length}] ${testCase.title}\n`);
      for (const turn of testCase.turns) {
        const turnHistory = turn.fixedHistory ?? history;
        const response = await executionService.executeTest({
          message: turn.message,
          history: turnHistory,
          skipHistoryTrim: true,
          scenario: 'candidate-consultation',
          saveExecution: false,
          sessionId,
          userId: sessionId,
          caseId: testCase.id,
          caseName: testCase.title,
          category: '暑假工规则回归',
        });
        responses.push(response);
        const tools = asToolCalls(response).map((call) => call.toolName ?? 'unknown');
        turns.push({
          user: turn.message,
          assistant: response.actualOutput,
          tools,
          durationMs: response.metrics.durationMs,
        });
        process.stdout.write(`  用户: ${turn.message.replace(/\n/g, ' / ')}\n`);
        process.stdout.write(`  Agent: ${response.actualOutput.replace(/\n/g, ' / ')}\n`);
        process.stdout.write(`  工具: ${tools.join(' -> ') || '(none)'}\n`);

        if (!turn.fixedHistory) {
          history.push({ role: MessageRole.USER, content: turn.message });
          if (response.actualOutput.trim()) {
            history.push({ role: MessageRole.ASSISTANT, content: response.actualOutput });
          }
        }
      }

      const inspection = inspectCase(testCase, responses);
      const passed = inspection.failures.length === 0;
      process.stdout.write(
        `  判定: ${passed ? 'PASS' : `FAIL — ${inspection.failures.join('；')}`}\n`,
      );
      report.push({
        id: testCase.id,
        title: testCase.title,
        passed,
        failures: inspection.failures,
        turns,
      });
    }
  } finally {
    await app.close();
  }

  const passedCount = report.filter((item) => item.passed).length;
  process.stdout.write(`\nSUMMARY ${passedCount}/${report.length} passed\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (passedCount !== report.length) process.exitCode = 1;
}

void main();
