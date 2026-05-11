import axios from 'axios';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 把本地复盘后的 BadCase 状态扭转到飞书表格。
 *
 * 用法：
 *   pnpm tsx scripts/writeback-badcase-status.ts                       # dry-run
 *   pnpm tsx scripts/writeback-badcase-status.ts --apply               # 实写
 *   pnpm tsx scripts/writeback-badcase-status.ts --env .env.production # 指定 env 文件
 */

type BadcaseStatus = '待分析' | '处理中' | '待验证' | '已解决';

type Plan = {
  badcaseId: string;
  recordId: string;
  current: BadcaseStatus;
  target: BadcaseStatus;
  reason: string;
};

const PLANS: Plan[] = [
  // 三层托管 guard（worker / 投递前置 / 投递段间）已落地
  {
    badcaseId: '1tsdimfg',
    recordId: 'recvi99nkgBYyb',
    current: '待分析',
    target: '已解决',
    reason: '三层托管 guard 已落地（Worker 拉起 + 投递前 + 段间）',
  },
  // === 拉群链路系统性失败排查 2026-05-11 ===
  // ZhuDongSheng × 上海零售③ 'room not found' —— 运营已把 ZhuDongSheng bot 拉进 3 个上海零售群
  {
    badcaseId: '2tn5zktx',
    recordId: 'recviOu2E41d57',
    current: '待分析',
    target: '已解决',
    reason:
      'ZhuDongSheng bot 未加入上海零售③群导致 invite errcode=400400；运营手工拉 bot 入 3 个上海零售群止血。代码侧增加 next-candidate 兜底 + 告警，预防同类问题',
  },
  {
    badcaseId: '0h1fkrkq',
    recordId: 'recvj0dZvNmrKb',
    current: '待分析',
    target: '已解决',
    reason: '同 2tn5zktx（同群同根因，运营加 bot 后已止血）',
  },
  // 候选人实际已在群（实测企业级 memberList 命中），招募经理备注为误报
  {
    badcaseId: '2tmmb83q',
    recordId: 'recvj1t3DWZogG',
    current: '待分析',
    target: '已解决',
    reason:
      '误报：企业级 /groupChat/list 实测候选人 imContactId=7881299683986519 nickName=就叫这个名字 已在"独立客&北京餐饮兼职②群"，invite 返回 already_in_group 正确',
  },
  // city="北京市" 字符串不规范化导致 no_group_in_city；Fix 2.A 城市规范化已修复
  {
    badcaseId: '2k2km06k',
    recordId: 'recviTzB4T8GWO',
    current: '待分析',
    target: '已解决',
    reason:
      'Agent 传 city="北京市" 与 simpleList labels "北京" 严格相等失败导致 no_group_in_city；新增 normalizeCity 工具去 市/省 后缀，invite 现在能命中"独立客&北京餐饮兼职②群"',
  },
  // 业务事实：琪琪未运营北京零售兼职群池；Agent 行为正确（未承诺拉群，未骗用户）
  {
    badcaseId: 'cawp805w',
    recordId: 'recvieWuV0xT1R',
    current: '待分析',
    target: '已解决',
    reason:
      '业务事实非缺陷：琪琪侧暂未运营北京零售兼职群池，invite 返 no_group_in_city 为预期；Agent reply "附近暂时没看到在招的岗位，后续有匹配的再联系你" 未承诺拉群也未骗用户。如需承接北京零售候选人，需运营建群',
  },
  // === 2026-05-11 二次批量修复：代码已落，待线上观察后再标已解决 ===
  // ❶ 0nmr8jh6: request_handoff no_active_case 走 general_handoff 飞书告警（intervention.service.ts + request-handoff.tool.ts），等首次告警卡片真实命中
  {
    badcaseId: '0nmr8jh6',
    recordId: 'recvieKzCpWQUW',
    current: '待分析',
    target: '处理中',
    reason:
      'Fix 1 已落：request_handoff 无 active case 时走 InterventionService.dispatch({kind:"general_handoff"})，会暂停托管+飞书 @ 招募经理。等首次告警卡片真实命中后扭转已解决',
  },
  // ❷ i41pab8n: reply-fact-guard phase 1（仅告警不改写）+ group_promise_without_invite 规则
  {
    badcaseId: 'i41pab8n',
    recordId: 'recviUKMIilkgg',
    current: '待分析',
    target: '处理中',
    reason:
      'Fix 3 phase 1 已落：reply-fact-guard 命中 group_full_without_invite/group_promise_without_invite 时飞书 ops 告警，phase 1 不改写回复。等告警样本积累 1-2 周后评估改写阈值',
  },
  // ❸ q3g3mlzo: 前科红线已加进 strategy_config.red_lines
  {
    badcaseId: 'q3g3mlzo',
    recordId: 'recvj6oWmvH1Nt',
    current: '待分析',
    target: '处理中',
    reason:
      'strategy_config.red_lines 已追加"前科/案底/失信被执行人"红线，candidate 主动声明刑事/失信记录时强制 request_handoff。等线上首次命中后扭转已解决',
  },
  // ❹ kjc5877z: stage_goals[interview_scheduling].disallowedActions 已追加
  {
    badcaseId: 'kjc5877z',
    recordId: 'recvj0YAr2RvQb',
    current: '待分析',
    target: '处理中',
    reason:
      'strategy_config.stage_goals[interview_scheduling].disallowedActions 已追加"周末/晚上/调休不便时间硬冲突→request_handoff(modify_appointment)"。等命中后扭转',
  },
  // ❺ i2hqccba: 历史申诉红线已加进 red_lines
  {
    badcaseId: 'i2hqccba',
    recordId: 'recvj0nFEygU0e',
    current: '待分析',
    target: '处理中',
    reason:
      'strategy_config.red_lines 已追加"为什么没过/上次面试结果"等历史申诉红线，强制 request_handoff(interview_result_inquiry)。等命中后扭转',
  },
  // ❻ m5lpfwi0: extraction prompt 加引用前缀禁抽 + nameFieldGuard 增加 nameMatchesManager 兜底
  {
    badcaseId: 'm5lpfwi0',
    recordId: 'recviazQwqJCJa',
    current: '待分析',
    target: '处理中',
    reason:
      '双层兜底：(a) session-extraction.prompt 加禁止抽取"[引用 XXX：...]" 前缀里的 XXX 作为候选人姓名；(b) duliday-interview-precheck 在 nameFieldGuard 增加 nameMatchesManager 判定，姓名命中招募经理 botUserId 时也标 suspicious 并清回 missingFields',
  },
  // ❼ slg3jqi9: precheck 新增 detectRealNameInsistence + nameFieldGuard.mustHandoff
  {
    badcaseId: 'slg3jqi9',
    recordId: 'recviO9bsxqxRP',
    current: '待分析',
    target: '处理中',
    reason:
      'duliday-interview-precheck 增加 detectRealNameInsistence（"这就是真名/真名就是/少数民族"等坚持信号）；nameFieldGuard 升级到 mustHandoff=true，Agent 必须调 request_handoff(other) 而非继续逼候选人改名',
  },
  // ❽ zmp4egzr: precheck 加 detectAgeBoundary（下限锚 23 岁）
  {
    badcaseId: 'zmp4egzr',
    recordId: 'recviZQG38X08S',
    current: '待分析',
    target: '处理中',
    reason:
      'duliday-interview-precheck 新增 detectAgeBoundary：候选人年龄 ≥23 且 < 岗位下限，或 ≤ 岗位上限+2 岁时输出 ageBoundary 字段，强制 Agent 调 request_handoff(other) 转人工评估，不再以年龄硬门槛直接劝退',
  },
  // ❾ gay6j94c: 本案 Agent 未承诺群也未拉，属业务期望模糊；fact-guard 扩展覆盖同类"嘴上说群没真拉"风险
  {
    badcaseId: 'gay6j94c',
    recordId: 'recviUrAGDpdpI',
    current: '待分析',
    target: '处理中',
    reason:
      '本案 Agent 没向候选人承诺群也没拉群（招募经理觉得应兜底拉群，属于业务期望模糊不是结构性 bug）。但同步在 reply-fact-guard 增加 group_promise_without_invite 规则，覆盖"承诺拉群/群里通知却没真调 invite_to_group"的同类风险，phase 1 告警观察',
  },
  // === 2026-05-11 precheck/booking 职责重新分工回归批次（v2c）收尾：业务结果 14/14 通过 ===
  // 详细执行报告：tmp/precheck-booking-regression-20260511.execution-report.md
  // 遗留低优先级：SCREENING-BATCH69（无 feishu recordId，无法 writeback）/ slg3jqi9（已在上方处理中条目，本轮 mustHandoff 分支未直接命中，保持观察）
  {
    badcaseId: '9m5v6vbz',
    recordId: 'recvi4uBscXwpD',
    current: '待分析',
    target: '已解决',
    reason:
      '回归 SCN-P2-20260429-005 验证：Agent 对可疑姓名/占位电话做信息补齐，未 booking，precheck/booking 职责分工正确',
  },
  {
    badcaseId: 'iqzhjb15',
    recordId: 'recvhBgBRDx3mn',
    current: '待分析',
    target: '已解决',
    reason:
      '回归 SCN-PREBOOK-20260511-REALNAME-ALEX 验证：英文名作为登记姓名时 precheck 标 suspicious，Agent 要求本名后再 booking',
  },
  {
    badcaseId: 'lrge9l4q',
    recordId: 'recvhXziDt4jps',
    current: '待分析',
    target: '已解决',
    reason:
      '回归 SCN-PREBOOK-20260511-REALNAME-MISSING 验证：多人缺实名且日期过期场景，Agent 正确要求补齐姓名/确认日期',
  },
  {
    badcaseId: 'c3ymz98k',
    recordId: 'recvhv3W5D57HM',
    current: '待分析',
    target: '已解决',
    reason:
      '回归 SCN-PREBOOK-20260511-CUTOFF-C3YMZ98K 验证：没有把今日过 cutoff 的时段当可约，正确推荐次日',
  },
  {
    badcaseId: 'i2u0pd6j',
    recordId: 'recvhv3W5D17Bq',
    current: '待分析',
    target: '已解决',
    reason:
      '回归 SCN-PREBOOK-20260511-CUTOFF-I2U0PD6J 验证：最终按 cutoff 推荐次日；前置 duliday_job_list 调用噪音判定为低优先级遗留',
  },
  {
    badcaseId: 'y361y5gg',
    recordId: 'recvhv3W5Dy24G',
    current: '待分析',
    target: '已解决',
    reason:
      '回归 SCN-PREBOOK-20260511-CUTOFF-TIME-SPECIFIED 验证：用户指定今日时段但 cutoff 已过，Agent 改问次日具体时段',
  },
  {
    badcaseId: 'ub4vrq3v',
    recordId: 'recvhv3W5D2OcQ',
    current: '待分析',
    target: '已解决',
    reason:
      '回归 SCN-PREBOOK-20260511-UB4VRQ3V 验证：健康证枚举收敛为有/无，正确触发 advance_stage',
  },
  {
    badcaseId: 'klre1d4n',
    recordId: 'recvhAU7sPHLR0',
    current: '待分析',
    target: '已解决',
    reason:
      '回归 SCN-PREBOOK-20260511-DATEONLY-KLRE1D4N 验证：date-only slot 被转成明确可约时段后继续补资料，未误把日期当时间',
  },
  {
    badcaseId: 'ul3ocqsa',
    recordId: 'recvi9Tek1iNat',
    current: '待分析',
    target: '已解决',
    reason:
      '回归 SCN-PREBOOK-20260511-MULTI-TIME-UL3OCQSA 验证：今日时段 cutoff 后未 booking，改问次日具体时段',
  },
  {
    badcaseId: '2j20ew2z',
    recordId: 'recvhv3W5DzBxM',
    current: '待分析',
    target: '已解决',
    reason:
      '回归 SCN-PREBOOK-20260511-2J20EW2Z 验证：目标点通过（25+ 不再追问学生身份）；前置 duliday_job_list 调用噪音判定为低优先级遗留',
  },
];

type EnvMap = Record<string, string>;

function writeStdout(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function parseEnv(envPath: string): EnvMap {
  if (!fs.existsSync(envPath)) {
    throw new Error(`找不到环境文件: ${envPath}`);
  }
  const text = fs.readFileSync(envPath, 'utf-8');
  const env: EnvMap = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const envIdx = args.indexOf('--env');
  return {
    apply: args.includes('--apply'),
    envPath:
      envIdx >= 0 && envIdx < args.length - 1
        ? path.resolve(args[envIdx + 1])
        : path.resolve(process.cwd(), '.env.local'),
  };
}

async function getTenantToken(appId: string, appSecret: string): Promise<string> {
  const response = await axios.post(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: appId, app_secret: appSecret },
    { timeout: 15000 },
  );
  if (response.data.code !== 0) {
    throw new Error(`获取飞书 Token 失败: ${response.data.msg}`);
  }
  return response.data.tenant_access_token as string;
}

async function updateStatus(
  token: string,
  appToken: string,
  tableId: string,
  recordId: string,
  status: BadcaseStatus,
): Promise<void> {
  const response = await axios.put(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    { fields: { 状态: status } },
    {
      timeout: 15000,
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (response.data.code !== 0) {
    throw new Error(`更新状态失败 record=${recordId}: ${response.data.msg}`);
  }
}

async function main(): Promise<void> {
  const { apply, envPath } = parseArgs();
  const env = parseEnv(envPath);

  const appId = env.FEISHU_APP_ID;
  const appSecret = env.FEISHU_APP_SECRET;
  const appToken = env.FEISHU_BITABLE_BADCASE_APP_TOKEN;
  const tableId = env.FEISHU_BITABLE_BADCASE_TABLE_ID;

  if (!appId || !appSecret || !appToken || !tableId) {
    throw new Error(`环境变量不完整 envPath=${envPath}`);
  }

  writeStdout(`[writeback-status] envPath=${envPath} apply=${apply}`);
  writeStdout(`[writeback-status] 计划变更 ${PLANS.length} 条:`);
  for (const plan of PLANS) {
    writeStdout(
      `  - ${plan.badcaseId} (${plan.recordId}) ${plan.current} → ${plan.target}  // ${plan.reason}`,
    );
  }

  if (!apply) {
    writeStdout('\n[dry-run] 未传 --apply，仅打印计划，未发起请求');
    return;
  }

  const token = await getTenantToken(appId, appSecret);
  let success = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const plan of PLANS) {
    try {
      await updateStatus(token, appToken, tableId, plan.recordId, plan.target);
      success += 1;
      writeStdout(`  ✓ ${plan.badcaseId} → ${plan.target}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      failed += 1;
      errors.push(`${plan.badcaseId}: ${message}`);
      writeStdout(`  ✗ ${plan.badcaseId}: ${message}`);
    }
  }
  writeStdout(`\n[writeback-status] 完成 success=${success} failed=${failed}`);
  if (errors.length > 0) {
    writeStdout('错误明细:');
    for (const e of errors) writeStdout(`  - ${e}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  writeStderr(`[writeback-status] 失败: ${message}`);
  process.exit(1);
});
