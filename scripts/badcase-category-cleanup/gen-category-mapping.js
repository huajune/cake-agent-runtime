#!/usr/bin/env node
// 只读：拉取「分类」全量取值分布，按规则生成 → 新 13+2 口径的映射提案。
// 输出: category-mapping.json（机器可执行映射） + category-mapping.md（人审表）
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.dirname(__filename);
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(ROOT, '.env.production'), 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    }),
);

const APP_TOKEN = env.FEISHU_BITABLE_BADCASE_APP_TOKEN;
const TABLE_ID = env.FEISHU_BITABLE_BADCASE_TABLE_ID;

const NEW = {
  1: '1-地区、城市与位置识别',
  2: '2-品牌与门店识别',
  3: '3-就近岗位推荐',
  4: '4-岗位条件与班次匹配',
  5: '5-岗位详情、薪资与福利',
  6: '6-报名与收资',
  7: '7-预约、取消与改期',
  8: '8-线上面试与到店引导',
  9: '9-无岗承接与拉群',
  10: '10-重复回复与收口节奏',
  11: '11-图片与上下文理解',
  12: '12-内部术语与异常输出',
  13: '13-敏感条件与合规表达',
  14: '14-人工/非Agent归因',
  15: '15-其他',
};

// 复聊专属分类：保留原值不迁移
const REENGAGEMENT_LABELS = new Set([
  '1-不该触达（工单/条件误判）',
  '2-触达时机错误（过早/过晚）',
  '3-重复打扰（"已提醒过"误判）',
  '4-场景挂错',
  '5-话术事实错误（岗位/时间/状态不符）',
  '6-语气/话术不当',
  '7-取消/改期后仍按旧状态触达',
  '8-其他',
]);

// 旧主聊 13 类 → 新口径
const OLD_MAIN = {
  '1-品牌/门店识别': NEW[2],
  '2-地区/位置/距离': NEW[1],
  '3-岗位推荐-范围/门店/距离': NEW[3],
  '4-岗位推荐-条件/班次不匹配': NEW[4],
  '5-岗位详情/薪资/福利口径': NEW[5],
  '6-预约/收资流程': NEW[7],
  '7-已约面/改期/入职跟进': NEW[7],
  '8-多消息/引用/上下文承接': NEW[11],
  '9-拉群/无岗维护': NEW[9],
  '10-图片/证件识别': NEW[11],
  '11-情绪/话术': NEW[15],
  '12-人工/非Agent归因': NEW[14],
  '13-其他': NEW[15],
  环境配置验证: NEW[15],
  PR619回归测试: NEW[15],
};

// 守卫规则 ID → 新口径
const RULE_MAP = {
  district_level_distance_claim: NEW[1],
  geocode_uncertain_location_claim: NEW[1],
  requested_brand_mismatch: NEW[2],
  brand_name_violation: NEW[2],
  ungrounded_job_recommendation: NEW[3],
  schedule_filtered_job_recommended: NEW[4],
  job_shift_polarity_mismatch: NEW[4],
  unsupported_schedule_window_claim: NEW[4],
  summer_worker_alternative_upsell: NEW[4],
  job_detail_lookup_required: NEW[5],
  salary_fabrication: NEW[5],
  hourly_salary_value_mismatch: NEW[5],
  settlement_cycle_mismatch: NEW[5],
  work_content_generalization: NEW[5],
  quota_promise: NEW[5],
  booking_form_field_mismatch: NEW[6],
  identity_misregistration_coaching: NEW[6],
  precheck_blocked_booking_claim: NEW[7],
  confirmed_booking_time_missing: NEW[7],
  wait_notice_time_fabrication: NEW[7],
  wait_notice_time_collection: NEW[7],
  tool_failure_success_claim: NEW[7],
  confirmed_booking_onsite_script_missing: NEW[8],
  group_promise_without_invite: NEW[9],
  group_invite_without_reason: NEW[9],
  repeated_greeting: NEW[10],
  repeated_reply: NEW[10],
  image_description_not_saved: NEW[11],
  internal_output_leak: NEW[12],
  human_service_phrase_leak: NEW[12],
  system_status_fabrication: NEW[12],
  proactive_insurance_policy_mention: NEW[13],
  discriminatory_screening_leak: NEW[13],
  age_requirement_disclosure: NEW[13],
  gender_direct_reject: NEW[13],
};

// 语义审查 finding → 新口径
const FINDING_MAP = {
  job_recommendation_not_best_supported: NEW[3],
  brand_or_geo_ambiguity_ignored: NEW[2],
  active_booking_state_conflict: NEW[7],
};

function mapValue(value) {
  if (REENGAGEMENT_LABELS.has(value)) return { target: value, rule: '复聊分类，保留' };
  if (value === '未分类') return { target: value, rule: '保留' };
  if (Object.values(NEW).includes(value)) return { target: value, rule: '已是新口径' };
  if (OLD_MAIN[value]) return { target: OLD_MAIN[value], rule: '旧主聊分类' };

  if (value.startsWith('semantic_review:')) {
    const body = value.slice('semantic_review:'.length).trim();
    if (body === '(no findings)') return { target: NEW[15], rule: '语义审查无发现' };
    const counts = {};
    for (const raw of body.split(',')) {
      const key = raw.trim();
      if (FINDING_MAP[key]) counts[key] = (counts[key] || 0) + 1;
    }
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return { target: NEW[15], rule: '语义审查未识别 finding' };
    return { target: FINDING_MAP[entries[0][0]], rule: `语义审查多数 finding=${entries[0][0]}` };
  }

  // 规则 ID（可能逗号组合，取第一个可识别的）
  for (const raw of value.split(',')) {
    const key = raw.trim();
    if (RULE_MAP[key]) return { target: RULE_MAP[key], rule: `守卫规则 ${key}` };
  }
  return { target: NEW[15], rule: '未识别，兜底其他' };
}

async function main() {
  const tokenRes = await fetch(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
    },
  );
  const tokenJson = await tokenRes.json();
  if (tokenJson.code !== 0) throw new Error(`token: ${tokenJson.code} ${tokenJson.msg}`);
  const token = tokenJson.tenant_access_token;

  const counts = new Map();
  let pageToken = '';
  let total = 0;
  do {
    const url = new URL(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records`,
    );
    url.searchParams.set('page_size', '500');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    if (json.code !== 0) throw new Error(`records: ${json.code} ${json.msg}`);
    for (const record of json.data.items || []) {
      total += 1;
      const value = record.fields?.['分类'];
      if (typeof value === 'string' && value) counts.set(value, (counts.get(value) || 0) + 1);
    }
    pageToken = json.data.has_more ? json.data.page_token : '';
  } while (pageToken);

  const mapping = {};
  const rows = [];
  for (const [value, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const { target, rule } = mapValue(value);
    if (target !== value) mapping[value] = target;
    rows.push({ value, count, target, rule, changed: target !== value });
  }

  fs.writeFileSync(path.join(OUT_DIR, 'category-mapping.json'), JSON.stringify(mapping, null, 2));

  const summary = new Map();
  for (const row of rows) {
    summary.set(row.target, (summary.get(row.target) || 0) + row.count);
  }
  const lines = [];
  lines.push('# BadCase「分类」清洗映射提案');
  lines.push('');
  lines.push(`总记录 ${total}，有分类值的取值种类 ${counts.size}。`);
  lines.push('');
  lines.push('## 迁移后分布');
  lines.push('');
  lines.push('| 新分类 | 记录数 |');
  lines.push('| --- | ---: |');
  for (const [target, count] of [...summary.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${target} | ${count} |`);
  }
  lines.push('');
  lines.push('## 逐值映射（按记录数降序）');
  lines.push('');
  lines.push('| 原值 | 记录数 | → 新值 | 依据 |');
  lines.push('| --- | ---: | --- | --- |');
  for (const row of rows) {
    const label = row.value.length > 80 ? `${row.value.slice(0, 80)}…` : row.value;
    lines.push(
      `| ${label.replace(/\|/g, '\\|')} | ${row.count} | ${row.changed ? row.target : '（不变）'} | ${row.rule} |`,
    );
  }
  fs.writeFileSync(path.join(OUT_DIR, 'category-mapping.md'), lines.join('\n'));

  console.log(`取值种类 ${counts.size}，需改写 ${rows.filter((r) => r.changed).length} 种。`);
  console.log('迁移后分布:');
  for (const [target, count] of [...summary.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${target}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
