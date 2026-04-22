/**
 * 图片描述服务测试脚本
 *
 * 用法：npx ts-node -r tsconfig-paths/register scripts/test-image-description.ts [imageUrl]
 *
 * 默认使用招聘截图 URL 测试，也可以传入自定义图片 URL。
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { LlmExecutorService } from '../src/llm/llm-executor.service';
import { ModelRole } from '../src/llm/llm.types';

const SYSTEM_PROMPT = [
  '你是招聘场景的图片分析助手。候选人发来的图片大多是招聘平台截图。',
  '请提取关键信息，用简洁中文输出（2-3句话）：',
  '\n- 招聘截图：提取岗位名称、薪资、门店/公司、距离、工作要求等关键信息',
  '\n- 地图/位置截图：提取地点名称和位置信息',
  '\n- 聊天截图：提取关键对话内容',
  '\n- 表情包/无实际信息的图片：简短说明即可',
  '\n不要添加评价或建议，只提取事实信息。',
].join('');

// 默认测试图片（已入库的招聘截图）
const DEFAULT_IMAGE_URL =
  'https://area-i.oss-cn-beijing.aliyuncs.com/puppet_workeasy_71e8cf1c4ffc40c68e90438d0504dae5/link_msg/76bcd1b7-7b0d-42ec-8bde-31c478162f8a/caf4eff2-ed4a-4c41-9a43-51923feab7fc.jpg';

async function main() {
  const imageUrl = process.argv[2] || DEFAULT_IMAGE_URL;
  console.log(`\n🖼️  测试图片: ${imageUrl}\n`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const llm = app.get(LlmExecutorService);

  try {
    console.log(`⏳ 调用 Vision 模型 (${ModelRole.Vision})...\n`);
    const start = Date.now();

    const result = await llm.generate({
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image' as const, image: new URL(imageUrl) },
            { type: 'text' as const, text: '请描述这张图片的内容。' },
          ],
        },
      ],
      role: ModelRole.Vision,
      maxOutputTokens: 256,
    });

    const elapsed = Date.now() - start;

    console.log('✅ 描述结果:');
    console.log(`   ${result.text.trim()}\n`);
    console.log(
      `📊 Token 消耗: input=${result.usage.inputTokens}, output=${result.usage.outputTokens}, total=${result.usage.totalTokens}`,
    );
    console.log(`⏱️  耗时: ${elapsed}ms\n`);
  } catch (error) {
    console.error('❌ 失败:', error.message);
  } finally {
    await app.close();
  }
}

main();
