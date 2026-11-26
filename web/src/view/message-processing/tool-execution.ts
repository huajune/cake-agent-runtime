import { asRecord } from '../../utils/object';
import type { ExecutionEvent } from '../../api/types/chat.types';

/** 同一 trace 中按 SDK ID 配对。重试重用 ID、缺标识或名称冲突时，事件仍可独立查看。 */
export function linkToolEvents(
  traceId: string | undefined,
  calls: ReadonlyArray<{ name: string; toolCallId?: string }>,
  events: readonly ExecutionEvent[],
): Map<number, number> {
  const links = new Map<number, number>();
  if (!traceId) return links;
  const indices = new Map<string, number | null>();
  calls.forEach(({ toolCallId }, index) => {
    if (toolCallId) indices.set(toolCallId, indices.has(toolCallId) ? null : index);
  });
  const finished = new Set<string>();
  const scoped = events.filter(
    (event) => event.traceId === traceId && typeof event.payload?.toolCallId === 'string',
  );
  for (const event of scoped) {
    if (event.type !== 'tool_call' && event.type !== 'tool_error') continue;
    const id = event.payload.toolCallId as string;
    const index = indices.get(id);
    if (finished.has(id) || (index != null && calls[index].name !== event.payload.toolName))
      indices.set(id, null);
    finished.add(id);
  }
  for (const event of scoped) {
    const index = indices.get(event.payload.toolCallId as string);
    if (index != null) links.set(event.id, index);
  }
  return links;
}

type Receipt = Record<string, unknown>;

type ReceiptJudgment = readonly [label: string, detail: string];

export interface ToolExecutionSummary {
  outcome?: string;
  judgments: ReceiptJudgment[];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function label(value: unknown, labels: Record<string, string>): string | undefined {
  const key = text(value);
  return key && Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : key;
}

const SCAN_STOP_REASONS = {
  page_limit: '达到分页上限',
  time_budget: '达到查询时间上限',
  empty_page: '上游返回空页',
  duplicate_page: '后续页面没有新岗位',
  page_error: '读取后续页面失败',
  total_changed: '上游岗位总数发生变化',
  not_scanned: '仅查询了首批结果',
};

function scheduleWindow(value: unknown): string | undefined {
  const window = asRecord(value);
  const start = text(window?.start);
  const end = text(window?.end);
  if (start && end) return `${start} 至${window?.endDayOffset === 1 ? '次日' : ''} ${end}`;
  if (start) return `${start} 起`;
  if (end) return `${end} 前`;
}

function describeJobs(result: Receipt): ToolExecutionSummary {
  const meta = asRecord(result.queryMeta);
  const judgments: ReceiptJudgment[] = [];
  const scanned = count(meta?.scannedCount);
  const total = count(meta?.upstreamTotal);
  const pages = count(meta?.scannedPages);
  if (scanned !== undefined) {
    const scope = total === undefined ? '' : `，上游共 ${total} 个`;
    const pageCount = pages === undefined ? '' : `（${pages} 页）`;
    judgments.push(['扫描范围', `扫描了 ${scanned} 个岗位${pageCount}${scope}`]);
  }
  if (meta?.scanComplete === false) {
    const reason = meta.stopReason !== 'complete' && label(meta.stopReason, SCAN_STOP_REASONS);
    judgments.push(['扫描进度', reason ? `扫描未完成，${reason}` : '仅覆盖已扫描的范围']);
  }
  if (meta?.storeMatchStrategy === 'local_fuzzy_match') {
    judgments.push(['门店匹配', '门店精确查询无结果，改用本地模糊匹配']);
  }
  const invalid = count(meta?.skippedInvalidWorkTime);
  if (invalid) judgments.push(['班次数据', `有 ${invalid} 个岗位因班次数据异常被跳过`]);
  const schedule = asRecord(meta?.scheduleFilter);
  if (meta?.purpose === 'inspect' && schedule?.applied === false) {
    judgments.push(['岗位核对', '按指定岗位核对详情，班次条件不参与筛除']);
  }
  const constraint = asRecord(schedule?.candidateConstraint);
  const window = scheduleWindow(constraint?.availableWindow);
  const scheduleLabel =
    text(result.candidateConstraintLabel) ??
    [window && `可上班时段 ${window}`, constraint?.onlyWeekends === true && '仅周末']
      .filter(Boolean)
      .join('、');
  const labor = asRecord(meta?.laborFormFilter);
  const laborForm = text(labor?.candidateLaborForm);
  const filters = [
    [scheduleLabel ? `班次（${scheduleLabel}）` : '班次', schedule],
    ['住宿', asRecord(meta?.accommodationFilter)],
    [laborForm ? `用工形式（${laborForm}）` : '用工形式', labor],
    ['学生身份', asRecord(meta?.studentIdentityFilter)],
  ] as const;
  for (const [name, filter] of filters) {
    if (filter?.applied !== true) continue;
    const excluded = count(filter.excludedCount);
    judgments.push([
      '筛选条件',
      `按${name}筛选${excluded === undefined ? '' : `，排除 ${excluded} 个岗位`}`,
    ]);
  }
  const matched = count(meta?.matchedCount);
  const returned = count(meta?.returnedCount) ?? count(result.resultCount);
  if (labor?.applied === true && labor.relaxedToFamily === true) {
    judgments.push(['用工形式', '指定用工形式没有匹配，已放宽到同类兼职岗位']);
  }
  if (
    schedule?.applied === true &&
    constraint?.preferFlexibleSchedule === true &&
    matched !== undefined
  ) {
    judgments.push(['排序依据', '排序时优先展示灵活排班的岗位']);
  }
  if (matched !== undefined) {
    const limited = meta?.hasMoreMatches === true && returned !== undefined && returned < matched;
    judgments.push([
      '匹配结果',
      `已查范围内匹配 ${matched} 个岗位${limited ? `，按排序取前 ${returned} 个` : ''}`,
    ]);
  }
  const outcome =
    text(result._outcome) ??
    (returned === undefined
      ? undefined
      : meta?.purpose === 'inspect'
        ? `核对了 ${returned} 个指定岗位`
        : `返回 ${returned} 个岗位`);
  return { outcome, judgments };
}

const PRECHECK_ACTIONS = {
  collect_fields: '需补充资料',
  confirm_collection: '待候选人确认资料',
  select_interview_time: '需选择面试时间',
  screening_rejected: '未通过初筛',
  handoff: '需转人工处理',
  age_boundary_handoff: '年龄处于弹性范围，需人工确认',
  interview_time_manual_handoff: '面试时间需人工协调',
  ready_to_book: '已具备提交预约的条件',
  already_submitted: '资料已提交',
  already_booked: '已有在途预约',
};

const REJECTION_REASONS = {
  slot_disqualified: '该字段已被判定为不合格，本次改口未入账',
  value_not_in_source_text: '候选人原话中找不到提交的值',
  source_text_not_found: '找不到所引用的候选人原话',
  bare_affirmation_without_question: '只有简短肯定答复，缺少它所回应的问题',
  identity_gate_rejected: '缺少能够确认身份信息来自候选人本人的依据',
  confirmation_evidence_rejected: '用于确认的问句与候选人答复未能对应',
  invalid_value_shape: '值的格式不符合字段要求',
  value_not_in_contract_vocabulary: '提交值不在该字段的选项内',
  unknown_option_code: '提交的选项编号无效',
  missing_attribution_corpus: '缺少可以核验归属的对话',
  deterministic_conflict: '提交值与原话解析结果冲突',
};

function describePrecheck(result: Receipt): ToolExecutionSummary {
  const judgments: ReceiptJudgment[] = [];
  const verdict = label(result.collectionVerdict, {
    collecting: '收资尚未完成',
    ready: '收资表单已就绪',
    disqualified: '资料未通过初筛',
    escalated: '收资需要人工复核',
    submitted: '收资表单已提交',
  });
  if (verdict) judgments.push(['表单核验', `表单核验结果为「${verdict}」`]);
  if (Array.isArray(result.rejectedAnswers)) {
    for (const answer of result.rejectedAnswers) {
      const rejected = asRecord(answer);
      const field = text(rejected?.labelTitle);
      const reason = label(rejected?.reason, REJECTION_REASONS);
      const action = label(rejected?.action, {
        retry_submission: '核对后重新提交',
        ask_candidate: '需向候选人补问',
        drop: '本岗位停止采集该项',
      });
      if (field)
        judgments.push([
          '字段核验',
          [`「${field}」被退回`, reason, action].filter(Boolean).join('，'),
        ]);
    }
  }
  const missing = asRecord(result.bookingChecklist)?.missingFields;
  if (Array.isArray(missing)) {
    const names = missing.map(text).filter(Boolean);
    if (names.length) judgments.push(['待补字段', `仍需补充${names.join('、')}`]);
    else if (!missing.length) judgments.push(['待补字段', '预检清单中没有待补字段']);
  }
  const duplicate = asRecord(result.duplicateBookingGuard);
  const order = count(duplicate?.workOrderId);
  if (order !== undefined) {
    const match = label(duplicate?.matchedBy, { job: '同岗位', brand: '同品牌' });
    judgments.push(['预约查重', `查到${match ?? ''}在途工单 ${order}`]);
  }
  const requestedDate = asRecord(asRecord(result.interview)?.requestedDate);
  const dateReason = text(requestedDate?.reason);
  if (dateReason) judgments.push(['面试日期', `面试日期核验记录为「${dateReason}」`]);
  const errorReason = text(result.reason);
  if (errorReason) judgments.push(['回执说明', `预检回执说明为「${errorReason}」`]);
  return {
    outcome: text(result._outcome) ?? label(result.nextAction, PRECHECK_ACTIONS),
    judgments,
  };
}

const ACTION_STATES = {
  registered: '已登记',
  executing: '执行中',
  succeeded: '成功',
  failed: '失败',
  unknown: '结果待核实',
  cancelled: '已取消',
  blocked: '已阻止',
};

function inviteOutcome(result: Receipt): string | undefined {
  if (result.simulated === true) return '模拟群邀请';
  if (
    result.actionStatus === 'unknown' ||
    result.errorType === 'action.result_unresolved' ||
    result.failureReason === 'result_unknown'
  )
    return '群邀请结果待核实';
  const recorded = text(result._outcome);
  if (recorded) return recorded;
  if (result.attempted === false) return '已跳过群邀请';
  if (result.alreadyInGroup === true) return '候选人已在群中';
  if (result.success === false) return '群邀请未成功';
  if (result.success === true) {
    const delivery = result.inviteDelivery ?? result.delivery;
    if (delivery === 'direct_add') return '候选人已直接入群';
    if (delivery === 'invite_card') return '邀请卡已发送';
    return '群邀请操作成功';
  }
  if (typeof result.accepted === 'boolean' || text(result.actionStatus))
    return '整次群邀请结果未记录';
}

function describeInvite(result: Receipt): ToolExecutionSummary {
  const judgments: ReceiptJudgment[] = [];
  const city = text(result.city);
  const expectedCity = text(result.expectedCity);
  if (city && expectedCity)
    judgments.push(['城市核验', `请求城市为${city}，核验得到的城市为${expectedCity}`]);
  const totalGroups = count(asRecord(result.citySnapshot)?.totalGroups);
  if (totalGroups !== undefined)
    judgments.push(['候选群', `${city ?? '该城市'}的群快照中有 ${totalGroups} 个群`]);
  if (result.fallbackUsed === true)
    judgments.push(['行业匹配', '没有匹配行业的群，改在同城范围选群']);
  else if (
    result.fallbackUsed === false &&
    text(result.industry) &&
    result.matchedIndustry === result.industry
  )
    judgments.push(['行业匹配', `选中的群符合请求的行业「${result.industry}」`]);
  const selection = label(result.selectionReason, {
    only_option: '只有一个候选群',
    lowest_member_count: '优先选择人数较少的候选群',
  });
  const group = text(result.groupName);
  if (selection) judgments.push(['选群依据', group ? `${selection}，选中「${group}」` : selection]);
  if (result.alreadyInGroup === true)
    judgments.push([
      '成员核验',
      group ? `成员核验确认候选人已在「${group}」` : '成员核验确认候选人已在群中',
    ]);
  if (result.errorType === 'invite.already_invited')
    judgments.push(['重复邀请', '会话已有该城市的邀请记录，本次跳过重复邀请']);
  const actionState = label(result.actionStatus, ACTION_STATES);
  if (actionState) judgments.push(['动作状态', `关联动作的状态为「${actionState}」`]);
  if (typeof result.actionDispatched === 'boolean') {
    judgments.push([
      '请求派发',
      result.actionDispatched ? '本次动作发起了请求' : '本次动作没有新发请求',
    ]);
  }
  if (typeof result.accepted === 'boolean') {
    const code =
      typeof result.code === 'number' || typeof result.code === 'string'
        ? `（${result.code}）`
        : '';
    judgments.push(['渠道回执', `单次企微请求${result.accepted ? '已受理' : '未受理'}${code}`]);
  }
  const rejected = count(result.totalRejected);
  if (rejected !== undefined) judgments.push(['拒绝记录', `企微拒绝了 ${rejected} 个候选群的请求`]);
  const rejection = text(result.reason) ?? text(result.error) ?? text(result.actionReason);
  if (rejection) judgments.push(['回执说明', `回执说明为「${rejection}」`]);
  const outcome = inviteOutcome(result);
  const reason = label(result.skippedReason ?? result.failureReason, {
    service_unavailable: '拉群服务不可用',
    group_chat: '当前是群聊',
    additional_candidate: '为同行人报名',
    not_first_booking: '已有其他在途报名',
    city_unknown: '候选人城市未知',
    already_invited: '此前已邀请',
    no_group_in_city: '该城市没有匹配群',
    no_group_available: '没有可供选择的群',
    city_conflict: '请求城市与会话记录的城市不一致',
    city_unverified: '请求城市缺少候选人原话或会话记录支持',
    candidate_not_friend: '候选人不是机器人的外部联系人',
    enterprise_token_missing: '缺少企业拉群凭据',
    missing_bot_identity: '缺少机器人身份信息',
    group_full: '候选群已满',
    api_rejected: '企微接口拒绝',
    api_failed: '企微接口异常',
    result_unknown: '群邀请结果待核实',
  });
  if (reason && reason !== outcome) judgments.push(['回执原因', `回执记录的原因为「${reason}」`]);
  return { outcome, judgments };
}

/** 只解释这一条调用自己的回执；同名调用、整轮事件和模型入参不能证明某个分支已执行。 */
export function describeToolExecution(name: string, output: unknown): ToolExecutionSummary {
  const envelope = asRecord(output);
  const result =
    envelope?.type === 'json' || envelope?.type === 'error-json'
      ? asRecord(envelope.value)
      : envelope;
  if (!result) return { judgments: [] };
  if (result.toolExecuted === false) {
    return {
      outcome: text(result._outcome) ?? '工具未执行',
      judgments: [
        [
          '执行条件',
          result.errorType === 'shared.turn_call_limit_reached'
            ? '已达到本轮调用次数上限'
            : '回执确认已跳过执行',
        ],
      ],
    };
  }
  if (name === 'duliday_job_list') return describeJobs(result);
  if (name === 'duliday_interview_precheck') return describePrecheck(result);
  if (name === 'invite_to_group') return describeInvite(result);
  const outcome = text(result._outcome);
  const groupInvite = name === 'duliday_interview_booking' && asRecord(result.groupInvite);
  if (groupInvite) {
    const invite = describeInvite(groupInvite);
    return {
      outcome,
      judgments: [
        ...(invite.outcome
          ? [['群邀请', `报名后的群邀请结果为「${invite.outcome}」`] as const]
          : []),
        ...invite.judgments.map(
          ([label, detail]): ReceiptJudgment => [label, `报名后拉群 · ${detail}`],
        ),
      ],
    };
  }
  return { outcome, judgments: [] };
}
