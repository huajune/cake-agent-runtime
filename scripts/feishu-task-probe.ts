/**
 * 飞书任务清单探测脚本（PRD R6 上线前实测；默认只读）。
 *
 * 用法：
 *   pnpm ts-node -r tsconfig-paths/register -P scripts/tsconfig.json scripts/feishu-task-probe.ts [选项]
 *
 * 选项：
 *   --env <path>          环境文件，默认 .env.production（读生产飞书应用凭证；默认只读不写）
 *   --tasklist <guid>     清单 guid，默认取 FEISHU_TASK_TASKLIST_GUID；为空时只列出应用可见的清单
 *   --write               允许写：试建一条测试任务（加负责人、加评论）随后删除
 *   --setup-fields        与 --write 同用：为清单补建缺失的自定义字段与分组
 *   --assignee <open_id>  --write 时测试任务的负责人；用于验证 open_id 是否属于本应用
 *
 * 只读模式输出：清单信息、分组、自定义字段（含单选选项）、与期望表头的差异、
 * 现有群卡片 @ 用的 open_id 清单（提醒：open_id 按应用区分，是否属于本应用只能靠 --write 实测）。
 */

// 环境文件必须在业务模块 import 之前加载（ConfigService 读 process.env）；函数声明有提升，可先用。
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
require('dotenv').config({
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  path: require('node:path').resolve(__dirname, '..', parseArgs(process.argv.slice(2)).env),
});

interface CliOptions {
  env: string;
  tasklist: string | null;
  write: boolean;
  setupFields: boolean;
  assignee: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    env: '.env.production',
    tasklist: null,
    write: false,
    setupFields: false,
    assignee: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--env') options.env = argv[++i] ?? options.env;
    else if (arg === '--tasklist') options.tasklist = argv[++i] ?? null;
    else if (arg === '--write') options.write = true;
    else if (arg === '--setup-fields') options.setupFields = true;
    else if (arg === '--assignee') options.assignee = argv[++i] ?? null;
  }
  return options;
}

const cli = parseArgs(process.argv.slice(2));

import { ConfigService } from '@nestjs/config';
import { toErrorStack } from '@infra/utils/error.util';
import { FeishuApiService } from '@infra/feishu/services/api.service';
import { BOT_TO_RECEIVER } from '@infra/feishu/constants/receivers';
import { FeishuTaskClient } from '@notification/feishu-task/feishu-task.client';
import {
  DEFAULT_FIELD_NAMES,
  type FieldKey,
} from '@notification/feishu-task/intervention-task.service';
import {
  CATEGORY_META,
  PRIORITY_LABELS,
  UNCLASSIFIED_LABEL,
  sectionNameOf,
  type InterventionTaskCategory,
} from '@notification/feishu-task/intervention-task-category';
import { resolveOptionColorIndex } from '@notification/feishu-task/intervention-task-colors';
import type {
  CreateCustomFieldOptionInput,
  FeishuCustomFieldType,
} from '@notification/feishu-task/feishu-task.types';
import { HANDOFF_REASON_CATALOG } from '@enums/handoff-reason.enum';

/** 各字段类型与初始选项名；顺序由 DEFAULT_FIELD_NAMES 键顺序派生（列顺序 = 创建顺序，事后不可重排）。 */
const FIELD_SPECS: Record<FieldKey, { type: FeishuCustomFieldType; options?: string[] }> = {
  priority: { type: 'single_select', options: Object.values(PRIORITY_LABELS) },
  category: {
    type: 'single_select',
    options: Object.values(CATEGORY_META).map((meta) => meta.label),
  },
  nickname: { type: 'text' },
  reasonCode: {
    type: 'single_select',
    options: [...HANDOFF_REASON_CATALOG.map((item) => item.label), UNCLASSIFIED_LABEL],
  },
  name: { type: 'text' },
  phone: { type: 'text' },
  hostingAccount: { type: 'single_select', options: [] },
  workOrderId: { type: 'text' },
  interviewTime: { type: 'text' },
  interventionCount: { type: 'number' },
};

const EXPECTED_FIELDS: Array<{
  key: FieldKey;
  type: FeishuCustomFieldType;
  options?: CreateCustomFieldOptionInput[];
}> = (Object.keys(DEFAULT_FIELD_NAMES) as FieldKey[]).map((key) => ({
  key,
  type: FIELD_SPECS[key].type,
  options: FIELD_SPECS[key].options?.map((name) => ({
    name,
    colorIndex: resolveOptionColorIndex(key, name),
  })),
}));

const EXPECTED_SECTIONS = (Object.keys(CATEGORY_META) as InterventionTaskCategory[]).map(
  sectionNameOf,
);

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function main(): Promise<void> {
  const configService = new ConfigService(process.env as Record<string, string>);
  const api = new FeishuApiService(configService);
  const client = new FeishuTaskClient(api);
  const tasklistGuid = cli.tasklist ?? process.env.FEISHU_TASK_TASKLIST_GUID?.trim() ?? '';

  log(`== 环境文件: ${cli.env}（app_id=${api.getAppId() || '未配置'}）`);
  log(`== 模式: ${cli.write ? '写（--write）' : '只读'}`);

  if (!tasklistGuid) {
    log('== 未指定清单 guid，列出应用可见清单：');
    const tasklists = await client.listTasklists();
    if (tasklists.length === 0) log('  （无：应用可能缺 task:tasklist 权限，或尚未创建清单）');
    for (const item of tasklists) log(`  - ${item.name}  guid=${item.guid}  ${item.url ?? ''}`);
    return;
  }

  const tasklist = await client.getTasklist(tasklistGuid);
  log(
    `== 清单: ${tasklist ? `${tasklist.name} (${tasklist.guid})` : '读取失败（权限或 guid 错误）'}`,
  );

  const sections = await client.listSections(tasklistGuid, { refresh: true });
  log(`== 分组 ${sections.length} 个：`);
  for (const section of sections) log(`  - ${section.name}  guid=${section.guid}`);
  const missingSections = EXPECTED_SECTIONS.filter(
    (name) => !sections.some((s) => s.name === name),
  );
  if (missingSections.length > 0) log(`  缺分组: ${missingSections.join('、')}`);

  const catalog = await client.getFieldCatalog(tasklistGuid, { refresh: true });
  const fields = catalog ? Array.from(catalog.fieldsByName.values()) : [];
  log(`== 自定义字段 ${fields.length} 个：`);
  for (const field of fields) {
    const options = field.options.map((o) => `${o.name}${o.isHidden ? '(隐藏)' : ''}`).join(' / ');
    log(
      `  - ${field.name} [${field.type}] guid=${field.guid}${options ? `  选项: ${options}` : ''}`,
    );
  }
  const missingFields = EXPECTED_FIELDS.filter(
    (expected) => !fields.some((field) => field.name === DEFAULT_FIELD_NAMES[expected.key]),
  );
  log(
    missingFields.length === 0
      ? '== 期望表头齐全'
      : `== 缺字段: ${missingFields.map((f) => DEFAULT_FIELD_NAMES[f.key]).join('、')}`,
  );

  log('== 现有群卡片 @ 用的 open_id（是否属于本应用需 --write --assignee 实测）：');
  for (const [botImId, receiver] of Object.entries(BOT_TO_RECEIVER)) {
    log(`  - bot ${botImId} → ${receiver.name} ${receiver.openId}`);
  }

  if (!cli.write) {
    log('== 只读模式结束；加 --write 试建测试任务，--write --setup-fields 补建表头。');
    return;
  }

  if (cli.setupFields) {
    for (const name of missingSections) {
      const guid = await client.resolveSectionGuid(tasklistGuid, name);
      log(`  建分组 ${name}: ${guid ?? '失败'}`);
    }
    for (const expected of missingFields) {
      const created = await client.createCustomField(tasklistGuid, {
        name: DEFAULT_FIELD_NAMES[expected.key],
        type: expected.type,
        options: expected.options,
      });
      log(`  建字段 ${DEFAULT_FIELD_NAMES[expected.key]}: ${created?.guid ?? '失败'}`);
    }
  }

  log('== 试建测试任务…');
  const members = cli.assignee ? [{ id: cli.assignee }] : [];
  const task = await client.createTask({
    summary: '【测试】feishu-task-probe 试建，脚本随后删除',
    description: '由 scripts/feishu-task-probe.ts 创建，用于验证权限 / 负责人通知 / 字段写入。',
    dueAt: new Date(Date.now() + 60 * 60 * 1000),
    members,
    tasklistGuid,
    clientToken: `probe-${Date.now()}`,
  });
  if (!task) {
    log('  创建失败（看上方 warn：权限 / open_id / 清单）');
    return;
  }
  log(`  已创建 guid=${task.guid} url=${task.url ?? '-'}`);
  if (cli.assignee) {
    const added = await client.addMembers(task.guid, [{ id: cli.assignee }]);
    log(
      `  加负责人 ${cli.assignee}: ${added ? '成功（请确认任务助手是否收到通知）' : '失败（open_id 可能不属于本应用）'}`,
    );
  }
  const commentId = await client.addComment(task.guid, '探测评论：请确认负责人是否收到评论通知。');
  log(`  加评论: ${commentId !== null ? '成功' : '失败'}`);
  log('  60 秒后删除测试任务（期间可在客户端观察创建者 / 来源显示）…');
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  const deleted = await client.deleteTask(task.guid);
  log(`  删除: ${deleted ? '成功' : '失败，请手动删除'}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`探测失败: ${toErrorStack(error)}\n`);
  process.exit(1);
});
