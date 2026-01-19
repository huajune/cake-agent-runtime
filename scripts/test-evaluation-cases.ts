/**
 * LLM 评估服务测试脚本
 *
 * 用于快速验证评估 prompt 优化效果
 *
 * 运行方式：
 * pnpm run build && node dist/scripts/test-evaluation-cases.js
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { LlmEvaluationService } from '../src/test-suite/services/llm-evaluation.service';

/**
 * 测试案例：从实际测试数据中提取的典型场景
 */
const TEST_CASES = [
  {
    name: '事实性错误 - 应该低分',
    userMessage: '班次1：(中午) 11:30 — (下午) 13:30\n班次2：(下午) 17:30 — (晚上) 22:00\n成都你六姐-上海黄兴大润发店\n服务员\n这还招人吗',
    expectedOutput: '招的\n考虑的话，我现在给你报名，明天可以面试',
    actualOutput: '我看了下哈，黄兴大润发这家店暂时没在招，不过附近你六姐其他店在招服务员和后厨，时薪都是24元，也是中午班和晚班，要不要我帮你看看附近的？',
    expectedScore: '10-20分（事实相反）',
    oldScore: 90,
  },
  {
    name: '年龄限制错误 - 应该低分',
    userMessage: '您好\n请问来伊份兼职退休女的可以应聘嘛？',
    expectedOutput: '这个岗位要40以内哈，不好意思',
    actualOutput: '你好呀😊\n\n可以的哈，退休也能做呢。想找离哪儿近的店呀？',
    expectedScore: '10-20分（岗位要求错误）',
    oldScore: 30,
  },
  {
    name: '信息完整 - 应该高分',
    userMessage: '好的知道了，那我明天过去面试吗',
    expectedOutput: '稍等，我约下',
    actualOutput: '对的，明天过去面试一下～\n\n先把下面信息发我，我帮你约哈：\n• 姓名\n• 联系方式\n• 性别\n• 年龄',
    expectedScore: '85-95分（信息完整）',
    oldScore: 90,
  },
  {
    name: '只说"我查一下" - 应该低分',
    userMessage: '多少钱一个小时，工资周结，还是月结',
    expectedOutput: '时薪24~28\n月工时≤40小时:24元/小时\n月工时40＞80小时：超出40h的部分26元/小时\n工时80以上：超出80h的部分28元/小时\n月结',
    actualOutput: '我这边查一下，稍等~',
    expectedScore: '30-40分（信息缺失）',
    oldScore: null,
  },
  {
    name: '合理询问 - 应该中等分',
    userMessage: '我在泉水附近',
    expectedOutput: '肯德基-大连湾秀泊街28-1\n班次1：(凌晨) 05:30 — (下午) 14:00\n...',
    actualOutput: '你有意向的品牌么？这样我帮你看看附近哪家店在招～',
    expectedScore: '75-85分（合理澄清）',
    oldScore: 80,
  },
];

async function main() {
  console.log('🚀 启动 LLM 评估服务测试...\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'], // 减少日志噪音
  });

  const evaluationService = app.get(LlmEvaluationService);

  console.log('📊 测试案例总数:', TEST_CASES.length);
  console.log('━'.repeat(80));
  console.log('');

  let passCount = 0;
  const results: Array<{
    name: string;
    oldScore: number | null;
    newScore: number;
    expectedScore: string;
    reason: string;
    status: '✅' | '⚠️' | '❌';
  }> = [];

  for (const [index, testCase] of TEST_CASES.entries()) {
    console.log(`\n[${index + 1}/${TEST_CASES.length}] ${testCase.name}`);
    console.log('━'.repeat(80));
    console.log('用户消息:', testCase.userMessage.slice(0, 100) + '...');
    console.log('期望回复:', testCase.expectedOutput.slice(0, 100) + '...');
    console.log('实际回复:', testCase.actualOutput.slice(0, 100) + '...');
    console.log('');

    try {
      const result = await evaluationService.evaluate({
        userMessage: testCase.userMessage,
        expectedOutput: testCase.expectedOutput,
        actualOutput: testCase.actualOutput,
      });

      const expectedRange = testCase.expectedScore;
      let status: '✅' | '⚠️' | '❌' = '⚠️';

      // 简单判断是否符合预期
      if (expectedRange.includes('10-20') && result.score <= 25) {
        status = '✅';
        passCount++;
      } else if (expectedRange.includes('30-40') && result.score >= 25 && result.score <= 45) {
        status = '✅';
        passCount++;
      } else if (expectedRange.includes('75-85') && result.score >= 70 && result.score <= 90) {
        status = '✅';
        passCount++;
      } else if (expectedRange.includes('85-95') && result.score >= 80) {
        status = '✅';
        passCount++;
      } else {
        status = '❌';
      }

      results.push({
        name: testCase.name,
        oldScore: testCase.oldScore,
        newScore: result.score,
        expectedScore: expectedRange,
        reason: result.reason,
        status,
      });

      console.log(`${status} 评估结果:`);
      console.log(`   旧评分: ${testCase.oldScore ?? 'null'}`);
      console.log(`   新评分: ${result.score}`);
      console.log(`   预期: ${expectedRange}`);
      console.log(`   通过: ${result.passed ? '是' : '否'}`);
      console.log(`   理由: ${result.reason}`);
      console.log(`   Token: ${result.tokenUsage?.totalTokens ?? 'N/A'}`);
    } catch (error) {
      console.error('❌ 评估失败:', error instanceof Error ? error.message : error);
      results.push({
        name: testCase.name,
        oldScore: testCase.oldScore,
        newScore: 0,
        expectedScore: testCase.expectedScore,
        reason: '评估异常',
        status: '❌',
      });
    }
  }

  // 打印汇总
  console.log('\n\n');
  console.log('━'.repeat(80));
  console.log('📈 测试结果汇总');
  console.log('━'.repeat(80));
  console.log('');

  console.table(
    results.map((r) => ({
      案例: r.name,
      状态: r.status,
      旧评分: r.oldScore ?? 'null',
      新评分: r.newScore,
      预期: r.expectedScore,
    })),
  );

  console.log('');
  console.log(`✅ 通过: ${passCount}/${TEST_CASES.length}`);
  console.log(`❌ 失败: ${TEST_CASES.length - passCount}/${TEST_CASES.length}`);
  console.log(`📊 通过率: ${((passCount / TEST_CASES.length) * 100).toFixed(1)}%`);
  console.log('');

  if (passCount === TEST_CASES.length) {
    console.log('🎉 恭喜！所有测试案例都符合预期！');
  } else if (passCount >= TEST_CASES.length * 0.8) {
    console.log('⚠️  大部分测试通过，但仍有改进空间');
  } else {
    console.log('⚠️  评估效果不理想，需要继续优化 prompt');
  }

  console.log('');
  console.log('💡 建议：');
  console.log('   1. 检查失败案例的评估理由');
  console.log('   2. 如需调整，修改 llm-evaluation.service.ts 中的评分规则');
  console.log('   3. 重新运行此脚本验证');
  console.log('');

  await app.close();
}

main().catch((error) => {
  console.error('❌ 测试脚本执行失败:', error);
  process.exit(1);
});
