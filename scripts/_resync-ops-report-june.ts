/**
 * 一次性：清空运营日报飞书表 → 重推 6 月工作日（含新「招募经理」列）。
 * 周末自动跳过（pushReport 内置）。今天 06-09 不推，留给当晚 cron。
 *
 * 运行：
 *   npx ts-node -r tsconfig-paths/register --transpile-only /tmp/resync-ops-report-june.ts --dry-run
 *   npx ts-node -r tsconfig-paths/register --transpile-only /tmp/resync-ops-report-june.ts --apply
 */
import * as fs from 'fs';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { SupabaseModule } from '@infra/supabase/supabase.module';
import { FeishuModule } from '@infra/feishu/feishu.module';
import { RedisModule } from '@infra/redis/redis.module';
import { HostingMemberConfigModule } from '@biz/hosting-config/hosting-member-config.module';
import { OpsEventsModule } from '@biz/ops-events/ops-events.module';
import { OpsDailyReportCronService } from '@biz/ops-events/ops-daily-report.cron';
import { FeishuBitableApiService } from '@infra/feishu/services/bitable-api.service';

// 预加载 PROD 环境（覆盖 process.env，确保读到生产 Supabase / Stride / 海绵）。
for (const line of fs.readFileSync('.env.production', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SupabaseModule,
    FeishuModule,
    RedisModule,
    HostingMemberConfigModule,
    OpsEventsModule,
  ],
})
class ResyncModule {}

const APP_TOKEN = 'TM0hb4fmtaa5jusAnlnc32Nfnpg';
const TABLE_ID = 'tblusTgxaBKp9BA7';
const DATES = [
  '2026-06-01',
  '2026-06-02',
  '2026-06-03',
  '2026-06-04',
  '2026-06-05',
  '2026-06-08',
];

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(`模式: ${apply ? 'APPLY（会改生产表）' : 'DRY-RUN（只读）'}`);

  const app = await NestFactory.createApplicationContext(ResyncModule, {
    logger: ['error', 'warn', 'log'],
  });
  const bitable = app.get(FeishuBitableApiService);
  const report = app.get(OpsDailyReportCronService);

  // 先快照现有 record_id（含周末 05-31 / 06-07）——稍后只删这批旧行。
  const existing = await bitable.getAllRecords(APP_TOKEN, TABLE_ID);
  const oldIds = existing.map((r) => r.record_id);
  console.log(`现有记录: ${existing.length} 行`);

  if (!apply) {
    for (const d of DATES) console.log(`[dry-run] 将重推 ${d}`);
    console.log(`[dry-run] 重推完成后将删除旧的 ${oldIds.length} 行`);
    console.log('dry-run 结束');
    await app.close();
    return;
  }

  // 1) 先重推 6 月工作日（追加新行；此刻新旧并存）。
  let totalWritten = 0;
  for (const d of DATES) {
    const res = await report.pushReport(d);
    console.log(`重推 ${d}: rows=${res.rows} written=${res.written}`);
    totalWritten += res.written;
  }
  console.log(`重推完成，共写入 ${totalWritten} 行`);

  // 2) 仅当重推确有写入，才删除旧行（避免重推失败把表清空）。
  if (totalWritten === 0) {
    console.warn('重推写入 0 行，保守起见跳过删除旧行（请人工核查）。');
  } else if (oldIds.length > 0) {
    const del = await bitable.batchDeleteRecords(APP_TOKEN, TABLE_ID, oldIds);
    console.log(`删除旧行: 成功 ${del.success} 失败 ${del.failed}`);
  }

  await app.close();
}

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
