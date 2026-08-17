import { detectJobFactsWithoutLookup } from '@agent/guardrail/output/rules/job-facts-without-lookup.rule';
import type { AgentToolCall } from '@shared-types/agent-telemetry.types';

/**
 * 零查岗轮的量化岗位事实编造（2026-07-30 生产 10 回合/8 会话实证）。
 *
 * 本规则的全部难点是假阳：Agent 高频地在后续轮次复述上一轮已展示的岗位，
 * 那是正常行为。因此判据不是"没查岗就拦"，而是逐个数值做出处核验。
 */
describe('detectJobFactsWithoutLookup', () => {
  const call = (over: Partial<AgentToolCall>): AgentToolCall =>
    ({ toolName: 'duliday_job_list', status: 'ok', ...over }) as AgentToolCall;
  const assistant = (content: string) => ({ role: 'assistant', content });
  const user = (content: string) => ({ role: 'user', content });

  describe('命中：本轮零岗位数据且数值无出处', () => {
    // 生产实证 6a7d92ca 08-13 17:50:14（本轮 tool_calls=[]，零硬规则命中、原样投递）：
    // 「基础13.8元/时」是真值且上一轮工具结果里有出处，会被正确放行；虚构的三个档位
    // 14.3/14.8/15.3 写成**不带单位的裸数字**，锚在 `元/时` 上的「薪资」形态完全看不见。
    // 海绵探针（08-17）实证达美乐 hasStairSalary="无阶梯薪资"、stairSalaries=null。
    it('flags fabricated stair-salary tiers written as bare numerals', () => {
      const hit = detectJobFactsWithoutLookup(
        '这家是阶梯薪资，基础13.8元/时，做满40小时涨到14.3，满80小时14.8，满120小时15.3，累计工时按月重新算',
        [],
        [assistant('达美乐（容桂桂洲大道中）- 4.0km\n薪资：13.8元/时，综合0-110元/天')],
      );
      expect(hit).not.toBeNull();
      expect(hit?.ruleId).toBe('job_facts_without_any_lookup');
      expect(hit?.label).toContain('阶梯薪资档位');
    });

    // 生产实证 6a66fb44 17:57：tool_calls 为空，投递门店名 + 日结 + 三个班次时段。
    it('flags shift times invented with no tool calls at all', () => {
      const hit = detectJobFactsWithoutLookup(
        '必胜客保利大都汇这家是日结当天发薪，班次有 07:00-15:00、11:00-20:00 和 15:00-23:00 三个。',
        [],
      );
      expect(hit).not.toBeNull();
      expect(hit?.ruleId).toBe('job_facts_without_any_lookup');
    });

    // 生产实证 6a6ae281 20:04：n_tools=0，凭空给出距离。
    it('flags an invented distance', () => {
      const hit = detectJobFactsWithoutLookup(
        '奥乐齐银都店离你大概 8.9 公里，在莲花南路那边。',
        [],
      );
      expect(hit?.label).toContain('8.9 公里');
    });

    // 生产实证 6a1e42ce 19:04：凭空给出时薪与年龄段。
    it('flags invented hourly pay', () => {
      expect(
        detectJobFactsWithoutLookup('金光汇店基础 24 元/时，要求 40-50 岁。', []),
      ).not.toBeNull();
    });

    // 生产实证 6a6af728 18:50：本轮只有阶段跃迁工具，没有岗位查询。
    it('flags when the turn only called non-job tools', () => {
      const hit = detectJobFactsWithoutLookup('前厅是 11:00-15:00，后厨夜宵 20:00-次日 01:30。', [
        call({ toolName: 'advance_stage', result: { ok: true } }),
      ]);
      expect(hit).not.toBeNull();
    });

    it('flags when duliday_job_list was called but returned nothing usable', () => {
      const hit = detectJobFactsWithoutLookup('附近这家 22 元/小时。', [
        call({ status: 'error', result: { success: false, errorType: 'job_list.no_results' } }),
      ]);
      expect(hit).not.toBeNull();
    });

    it('does not accept the candidate own message as provenance', () => {
      // 候选人可能在转述别处看到的岗位，他说的数字不构成我方事实出处。
      const hit = detectJobFactsWithoutLookup('对，就是 22 元/时。', [], [user('是 22 元/时吗')]);
      expect(hit).not.toBeNull();
    });

    it('flags an unsupported accepts-newcomers claim after job tools were blocked', () => {
      const hit = detectJobFactsWithoutLookup('这家后厨小时工岗位不强制要求过往经验，接受新手。', [
        call({
          status: 'error',
          result: { success: false, errorType: 'job_list.jobid_no_provenance' },
        }),
      ]);

      expect(hit?.label).toMatch(/不强制要求过往经验|接受新手/u);
      expect(hit?.label).toContain('没有同一岗位的明确正向经验门槛出处');
    });

    it('does not accept the candidate question as evidence for an accepts-newcomers claim', () => {
      expect(
        detectJobFactsWithoutLookup('对，这家接受新手。', [], [user('这家接受新手吗？')]),
      ).not.toBeNull();
    });

    it('does not accept wording inside a failed tool payload as experience evidence', () => {
      expect(
        detectJobFactsWithoutLookup('这家接受新手。', [
          call({
            status: 'error',
            result: {
              success: false,
              replyInstruction: '当前无岗位证据，不得说这家接受新手',
            },
          }),
        ]),
      ).not.toBeNull();
    });

    it('still flags a positive claim followed by an “以门店为准” hedge', () => {
      expect(detectJobFactsWithoutLookup('这家接受新手，具体以门店为准。', [])).not.toBeNull();
    });

    it('does not treat uncertain assistant history as positive experience evidence', () => {
      expect(
        detectJobFactsWithoutLookup(
          '这家接受新手。',
          [],
          [assistant('这家是否接受新手，我还没查到。')],
        ),
      ).not.toBeNull();
    });

    it('does not treat a successful warning payload as positive experience evidence', () => {
      expect(
        detectJobFactsWithoutLookup('这家接受新手。', [
          call({
            toolName: 'duliday_interview_precheck',
            result: { replyInstruction: '未明确是否接受新手，不得承诺' },
          }),
        ]),
      ).not.toBeNull();
    });

    it('requires explicit experience evidence even when job lookup returned other fields', () => {
      expect(
        detectJobFactsWithoutLookup('这家接受新手。', [
          call({
            toolName: 'duliday_job_list',
            result: { markdown: '门店：静安店；班次：18:00-22:00' },
          }),
        ]),
      ).not.toBeNull();
    });

    it('covers common open-experience wording variants', () => {
      expect(detectJobFactsWithoutLookup('这家对经验没要求，零基础可做。', [])).not.toBeNull();
      expect(detectJobFactsWithoutLookup('这个岗位没干过也能做。', [])).not.toBeNull();
    });

    it('does not let an unrelated negation suppress an unsupported experience claim', () => {
      expect(detectJobFactsWithoutLookup('这家不包住但接受新手。', [])).not.toBeNull();
    });

    it('binds positive experience evidence to the explicitly named store', () => {
      const calls = [
        call({
          toolName: 'duliday_job_list',
          result: {
            rawData: [
              { jobId: 1, storeName: 'A店', experience: '经验不限' },
              { jobId: 2, storeName: 'B店', experience: '要求一年经验' },
            ],
          },
        }),
      ];

      expect(detectJobFactsWithoutLookup('B店接受新手。', calls)).not.toBeNull();
      expect(detectJobFactsWithoutLookup('B店，接受新手。', calls)).not.toBeNull();
      expect(detectJobFactsWithoutLookup('A店接受新手。', calls)).toBeNull();
      expect(detectJobFactsWithoutLookup('A店，接受新手。', calls)).toBeNull();
    });

    it('binds generic experience claims to the current focus job id', () => {
      const calls = [
        call({
          toolName: 'duliday_job_list',
          result: {
            rawData: [
              { jobId: 1, storeName: 'A店', experience: '经验不限' },
              { jobId: 2, storeName: 'B店', experience: '要求一年经验' },
            ],
          },
        }),
      ];

      expect(detectJobFactsWithoutLookup('这家接受新手。', calls, [], 2)).not.toBeNull();
      expect(detectJobFactsWithoutLookup('这家接受新手。', calls, [], 1)).toBeNull();
    });

    it('does not let a longer, earlier store name hijack the nearest explicit store assertion', () => {
      const calls = [
        call({
          result: {
            rawData: [
              { jobId: 1, storeName: '上海很长的A店', experience: '经验不限' },
              { jobId: 2, storeName: 'B店', experience: '要求一年经验' },
            ],
          },
        }),
      ];

      expect(
        detectJobFactsWithoutLookup('上海很长的A店经验不限，B店接受新手。', calls),
      ).not.toBeNull();
    });

    it('does not use assistant history from another store for a generic current-focus claim', () => {
      const calls = [
        call({
          result: {
            rawData: [
              { jobId: 1, storeName: 'A店', experience: '经验不限' },
              { jobId: 2, storeName: 'B店', experience: '要求一年经验' },
            ],
          },
        }),
      ];

      expect(
        detectJobFactsWithoutLookup(
          '这家接受新手。',
          calls,
          [assistant('A店经验不限，接受新手。')],
          2,
        ),
      ).not.toBeNull();
      expect(
        detectJobFactsWithoutLookup('这家接受新手。', [], [assistant('A店经验不限。')], 2),
      ).not.toBeNull();
    });

    it('requires an explicit store or current focus for a generic claim across multiple jobs', () => {
      const multiJobCall = call({
        result: {
          rawData: [
            { jobId: 1, storeName: 'A店', experience: '经验不限' },
            { jobId: 2, storeName: 'B店', experience: '要求一年经验' },
          ],
        },
      });

      expect(detectJobFactsWithoutLookup('这家接受新手。', [multiJobCall])).not.toBeNull();
      expect(
        detectJobFactsWithoutLookup('这家接受新手。', [
          call({
            result: { rawData: [{ jobId: 1, storeName: 'A店', experience: '经验不限' }] },
          }),
        ]),
      ).toBeNull();
      expect(
        detectJobFactsWithoutLookup('这两家都接受新手。', [
          call({
            result: {
              rawData: [
                { jobId: 1, storeName: 'A店', experience: '经验不限' },
                { jobId: 2, storeName: 'B店', experience: '接受新手' },
              ],
            },
          }),
        ]),
      ).toBeNull();
    });

    it('ignores filtered-out queryMeta examples when evaluating returned jobs', () => {
      const markdown = `# 在招岗位（共 1 个）

## 1. A岗位

- **门店**: A店
- **经验岗位类型**: 经验不限
- **jobId**: 1`;
      const calls = [
        call({
          result: {
            markdown,
            queryMeta: {
              scheduleFilter: {
                excludedExamples: [
                  { jobId: 2, storeName: 'B店', reason: '排班不匹配', experience: '接受新手' },
                ],
              },
            },
          },
        }),
      ];

      expect(detectJobFactsWithoutLookup('这家接受新手。', calls)).toBeNull();
      expect(detectJobFactsWithoutLookup('B店接受新手。', calls)).not.toBeNull();
    });

    it('keeps store, experience, and jobId bound within each production markdown job block', () => {
      const markdown = `# 在招岗位（共 2 个）

## 1. A岗位

- **门店**: A店
- **经验岗位类型**: 经验不限
- **jobId**: 1

---

## 2. B岗位

- **门店**: B店
- **最低工作经验**: 1 年
- **jobId**: 2`;
      const calls = [call({ result: { markdown } })];

      expect(detectJobFactsWithoutLookup('A店这个岗位接受新手。', calls)).toBeNull();
      expect(detectJobFactsWithoutLookup('B店，接受新手。', calls)).not.toBeNull();
      expect(detectJobFactsWithoutLookup('推荐A店，接受新手。', calls)).toBeNull();
      expect(detectJobFactsWithoutLookup('这家接受新手。', calls, [], 1)).toBeNull();
      expect(detectJobFactsWithoutLookup('这家接受新手。', calls, [], 2)).not.toBeNull();
    });
  });

  describe('放行：有出处或本轮拿到岗位数据', () => {
    // 反向对照，必须放行：chat …ee582952 08-13 18:26 同样零查岗，但阶梯档位带单位、
    // 且上一轮（18:19，n_tools=2）工具结果已给出同样的值。真实数据的跨轮复述不得被拦。
    it('passes stair-salary tiers restated from the previous turn', () => {
      expect(
        detectJobFactsWithoutLookup(
          '成都你六姐是时薪制，基础24元/时，做满40小时26元/时、满80小时28元/时',
          [],
          [
            assistant(
              '成都你六姐（西渡连城店），5.7km，晚班收档21:00-00:00，基础24元/时，满40小时26元/时、满80小时28元/时',
            ),
          ],
        ),
      ).toBeNull();
    });

    it('passes when the turn actually got job data', () => {
      expect(
        detectJobFactsWithoutLookup('这家 24 元/时，离你 2.9 公里。', [
          call({ result: { markdown: '### 岗位\n- 成都你六姐' } }),
        ]),
      ).toBeNull();
    });

    // 最主要的假阳场景：候选人追问已展示岗位的细节，Agent 不会重新查岗。
    it('passes when the value was already shown in a previous assistant turn', () => {
      expect(
        detectJobFactsWithoutLookup(
          '对，那家是 24 元/时，班次 12:00-15:00。',
          [],
          [assistant('成都你六姐（金光汇店）洗碗工，24元/时，班次 12:00-15:00')],
        ),
      ).toBeNull();
    });

    // 排版差异不是编造：工具写「24 元/小时」、回复写「24元/时」是同一事实。
    it('normalizes spacing and 小时/时 before comparing provenance', () => {
      expect(
        detectJobFactsWithoutLookup('是 24元/时。', [], [assistant('薪资：24 元/小时')]),
      ).toBeNull();
      expect(
        detectJobFactsWithoutLookup('离你 3.5公里。', [], [assistant('距离 3.5 km')]),
      ).toBeNull();
    });

    it('accepts provenance from non-job tools in the same turn', () => {
      expect(
        detectJobFactsWithoutLookup('面试时间是 14:00-17:00。', [
          call({ toolName: 'duliday_interview_precheck', result: { windows: '14:00-17:00' } }),
        ]),
      ).toBeNull();
    });

    it('passes replies with no quantitative job facts', () => {
      expect(
        detectJobFactsWithoutLookup('你好呀，方便说下你在哪个区域吗？我帮你看看附近的岗位。', []),
      ).toBeNull();
    });

    it('passes an accepts-newcomers claim grounded in assistant history', () => {
      expect(
        detectJobFactsWithoutLookup(
          '对，这家不需要相关经验，接受新手。',
          [],
          [assistant('岗位要求：经验不限，接受新手')],
        ),
      ).toBeNull();
    });

    it('passes an accepts-newcomers claim grounded in a non-job tool result', () => {
      expect(
        detectJobFactsWithoutLookup('这家经验不限，新手可以做。', [
          call({
            toolName: 'duliday_interview_precheck',
            result: { job: { experienceRequirement: '不限经验' } },
          }),
        ]),
      ).toBeNull();
    });

    it('passes questions, conditions, and explicit uncertainty about experience requirements', () => {
      expect(detectJobFactsWithoutLookup('这家是否接受新手，我目前还没查到。', [])).toBeNull();
      expect(
        detectJobFactsWithoutLookup('如果岗位不要求经验，面试时如实说没做过就行。', []),
      ).toBeNull();
    });

    it('passes the standard no-jobs script', () => {
      expect(
        detectJobFactsWithoutLookup(
          '咱们这边在你附近 10 公里内暂时没找到合适的岗位，我先帮你进餐饮兼职群。',
          [],
          [assistant('附近 10 公里内暂时没找到合适的岗位')],
        ),
      ).toBeNull();
    });

    // 最大的假阳来源：约面回执里的面试时段与班次形态完全一样，
    // 但出处在 booking/precheck，且该类问题由 booking_receipt_mismatch 治理。
    it('passes interview time windows in a booking context', () => {
      expect(
        detectJobFactsWithoutLookup(
          '已帮你约好周四的面试，13:30-16:30 之间到就行，你几点方便到店？',
          [],
        ),
      ).toBeNull();
      expect(
        detectJobFactsWithoutLookup('面试时间是周一至周五 11:00-18:00，你看哪天方便？', []),
      ).toBeNull();
    });

    // 但同一回复里的岗位班次仍要拦：语境豁免是按句生效的，不能整条回复放行。
    it('still flags an invented shift in a non-interview sentence of the same reply', () => {
      expect(
        detectJobFactsWithoutLookup(
          '已帮你约好周四的面试，13:30-16:30 到就行。这个岗位班次是 07:00-15:00。',
          [],
        ),
      ).not.toBeNull();
    });

    it('passes empty reply', () => {
      expect(detectJobFactsWithoutLookup('', [])).toBeNull();
    });
  });
});
