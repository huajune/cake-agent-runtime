import { describeToolExecution } from '../../web/src/view/message-processing/tool-execution';

describe('message processing tool execution', () => {
  it('separates scanned, filtered, matched and returned jobs for one call', () => {
    const result = {
      queryMeta: {
        scannedCount: 200,
        scannedPages: 10,
        upstreamTotal: 200,
        scanComplete: true,
        scheduleFilter: {
          applied: true,
          candidateConstraint: { availableWindow: { start: '18:00' } },
          excludedCount: 100,
        },
        studentIdentityFilter: { applied: false, excludedCount: 90 },
        matchedCount: 100,
        returnedCount: 20,
        hasMoreMatches: true,
      },
    };
    expect(describeToolExecution('duliday_job_list', result)).toEqual({
      outcome: '返回 20 个岗位',
      judgments: [
        ['扫描范围', '扫描了 200 个岗位（10 页），上游共 200 个'],
        ['筛选条件', '按班次（可上班时段 18:00 起）筛选，排除 100 个岗位'],
        ['匹配结果', '已查范围内匹配 100 个岗位，按排序取前 20 个'],
      ],
    });
    // 同一回合里的下一次调用只有最终数量，不能借用前一次的筛选依据。
    expect(describeToolExecution('duliday_job_list', { resultCount: 2 })).toEqual({
      outcome: '返回 2 个岗位',
      judgments: [],
    });
  });

  it('preserves zeroes and scopes an incomplete scan to the records actually read', () => {
    const view = describeToolExecution('duliday_job_list', {
      success: false,
      errorType: 'job_list.query_incomplete',
      _outcome: '已查询范围内尚未确认可推荐岗位',
      queryMeta: {
        scannedCount: 0,
        upstreamTotal: 21,
        scanComplete: false,
        stopReason: 'page_error',
        laborFormFilter: { applied: true, excludedCount: 0 },
      },
    });
    expect(view.judgments).toEqual([
      ['扫描范围', '扫描了 0 个岗位，上游共 21 个'],
      ['扫描进度', '扫描未完成，读取后续页面失败'],
      ['筛选条件', '按用工形式筛选，排除 0 个岗位'],
    ]);
    expect(view.outcome).toBe('已查询范围内尚未确认可推荐岗位');
  });

  it('keeps inspecting a specified job distinct from filtering recommendations', () => {
    const view = describeToolExecution('duliday_job_list', {
      resultCount: 1,
      queryMeta: {
        purpose: 'inspect',
        scheduleFilter: { applied: false, assessments: [{ status: 'unmatched' }] },
      },
    });
    expect(view.outcome).toBe('核对了 1 个指定岗位');
    expect(view.judgments).toEqual([['岗位核对', '按指定岗位核对详情，班次条件不参与筛除']]);
  });

  it('shows a recorded preference for sorting separately from an applied filter', () => {
    const view = describeToolExecution('duliday_job_list', {
      queryMeta: {
        matchedCount: 5,
        returnedCount: 5,
        scheduleFilter: {
          applied: true,
          candidateConstraint: { onlyWeekends: true, preferFlexibleSchedule: true },
          excludedCount: 1,
        },
        laborFormFilter: {
          applied: true,
          candidateLaborForm: '小时工',
          relaxedToFamily: true,
          excludedCount: 0,
        },
      },
    });
    expect(view.judgments).toEqual([
      ['筛选条件', '按班次（仅周末）筛选，排除 1 个岗位'],
      ['筛选条件', '按用工形式（小时工）筛选，排除 0 个岗位'],
      ['用工形式', '指定用工形式没有匹配，已放宽到同类兼职岗位'],
      ['排序依据', '排序时优先展示灵活排班的岗位'],
      ['匹配结果', '已查范围内匹配 5 个岗位'],
    ]);
  });

  it('shows the rejected field, why it was rejected, what is missing and the actual next action', () => {
    const result = {
      success: true,
      nextAction: 'collect_fields',
      collectionVerdict: 'collecting',
      rejectedAnswers: [
        { labelTitle: '联系电话', reason: 'value_not_in_source_text', action: 'retry_submission' },
      ],
      bookingChecklist: { missingFields: ['联系电话'], knownFieldMap: { 姓名: '示例姓名' } },
    };
    expect(
      describeToolExecution('duliday_interview_precheck', { type: 'json', value: result }),
    ).toEqual({
      outcome: '需补充资料',
      judgments: [
        ['表单核验', '表单核验结果为「收资尚未完成」'],
        ['字段核验', '「联系电话」被退回，候选人原话中找不到提交的值，核对后重新提交'],
        ['待补字段', '仍需补充联系电话'],
      ],
    });
    expect(
      describeToolExecution('duliday_interview_precheck', {
        nextAction: 'already_booked',
        duplicateBookingGuard: { workOrderId: 123, matchedBy: 'brand' },
      }),
    ).toEqual({ outcome: '已有在途预约', judgments: [['预约查重', '查到同品牌在途工单 123']] });
    expect(
      describeToolExecution('duliday_interview_precheck', { nextAction: 'ready_to_book' }),
    ).toEqual({ outcome: '已具备提交预约的条件', judgments: [] });
  });

  it('reports recorded group selection, external rejection and the final invite separately', () => {
    expect(
      describeToolExecution('invite_to_group', {
        success: true,
        city: '上海',
        citySnapshot: { totalGroups: 3 },
        groupName: '餐饮二群',
        selectionReason: 'lowest_member_count',
        inviteDelivery: 'invite_card',
        actionStatus: 'succeeded',
        actionDispatched: false,
      }),
    ).toEqual({
      outcome: '邀请卡已发送',
      judgments: [
        ['候选群', '上海的群快照中有 3 个群'],
        ['选群依据', '优先选择人数较少的候选群，选中「餐饮二群」'],
        ['动作状态', '关联动作的状态为「成功」'],
        ['请求派发', '本次动作没有新发请求'],
      ],
    });
    expect(
      describeToolExecution('invite_to_group', {
        success: false,
        _outcome: '候选群均被接口拒绝',
        totalRejected: 2,
        reason: 'room not found',
      }),
    ).toEqual({
      outcome: '候选群均被接口拒绝',
      judgments: [
        ['拒绝记录', '企微拒绝了 2 个候选群的请求'],
        ['回执说明', '回执说明为「room not found」'],
      ],
    });
    expect(
      describeToolExecution('invite_to_group', {
        accepted: false,
        code: 400400,
        error: 'room not found',
      }),
    ).toEqual({
      outcome: '整次群邀请结果未记录',
      judgments: [
        ['渠道回执', '单次企微请求未受理（400400）'],
        ['回执说明', '回执说明为「room not found」'],
      ],
    });
  });

  it.each([
    [{ success: true, inviteDelivery: 'direct_add' }, '候选人已直接入群'],
    [{ success: true, inviteDelivery: 'invite_card' }, '邀请卡已发送'],
    [{ success: true, alreadyInGroup: true }, '候选人已在群中'],
    [{ success: true, simulated: true, inviteDelivery: 'direct_add' }, '模拟群邀请'],
    [{ success: false, errorType: 'action.result_unresolved' }, '群邀请结果待核实'],
  ] as const)('uses only the recorded invitation outcome %#', (receipt, outcome) => {
    expect(describeToolExecution('invite_to_group', receipt).outcome).toBe(outcome);
  });

  it('keeps booking success independent from an unresolved post-booking invitation', () => {
    const view = describeToolExecution('duliday_interview_booking', {
      _outcome: '预约成功',
      groupInvite: {
        attempted: true,
        success: false,
        failureReason: 'result_unknown',
        actionStatus: 'unknown',
      },
    });
    expect(view.outcome).toBe('预约成功');
    expect(view.judgments).toContainEqual(['群邀请', '报名后的群邀请结果为「群邀请结果待核实」']);
  });

  it('does not fabricate decisions from partial, unrecognized or text-only legacy payloads', () => {
    for (const result of [
      null,
      undefined,
      '原始结果',
      { type: 'text', text: '扫描了十个岗位' },
      { queryMeta: { scannedCount: -3, scheduleFilter: null } },
    ]) {
      expect(describeToolExecution('duliday_job_list', result).judgments).toEqual([]);
    }
    expect(
      describeToolExecution('another_tool', { queryMeta: { scannedCount: 200 }, _outcome: '完成' }),
    ).toEqual({ outcome: '完成', judgments: [] });
    expect(
      describeToolExecution('duliday_job_list', {
        toolExecuted: false,
        errorType: 'shared.turn_call_limit_reached',
      }),
    ).toEqual({ outcome: '工具未执行', judgments: [['执行条件', '已达到本轮调用次数上限']] });
  });
});
