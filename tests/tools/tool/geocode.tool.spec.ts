import { Logger } from '@nestjs/common';
import { buildGeocodeTool } from '@tools/geocode.tool';
import { GeocodingService } from '@infra/geocoding/geocoding.service';
import type { GeocodeCandidate } from '@infra/geocoding/geocoding.types';
import { TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import type { ToolBuildContext } from '@shared-types/tool.types';
import { createToolContext, mergeToolContext } from '../../helpers/tool-context.fixture';

type ExecuteFn = (args: { address: string; city?: string | null }) => Promise<unknown>;

function makeCandidate(overrides: Partial<GeocodeCandidate> = {}): GeocodeCandidate {
  return {
    formattedAddress: '上海市嘉定区马陆镇',
    province: '上海市',
    city: '上海市',
    district: '嘉定区',
    township: '马陆镇',
    longitude: 121.27,
    latitude: 31.32,
    poiName: '马陆镇',
    typecode: '',
    source: 'poi',
    precision: 'poi',
    confidence: 'high',
    ...overrides,
  };
}

describe('geocode tool', () => {
  const mockGeocodingService = {
    searchCandidates: jest.fn(),
  } as unknown as jest.Mocked<GeocodingService>;

  const toolBuilder = buildGeocodeTool(mockGeocodingService);
  const toolInstance = toolBuilder(
    createToolContext({
      session: { userId: 'test-user', corpId: 'test-corp', sessionId: 'test-session' },
      turnInput: {
        messages: [
          { role: 'user', content: '[图片消息]' },
          {
            role: 'user',
            content:
              '[引用 招聘经理：主要在哪个城市]\n我在上海，也可以去南京\n[消息发送时间：2026-08-13 10:24:32]',
          },
        ],
      },
    }),
  );
  const execute = (toolInstance as unknown as { execute: ExecuteFn }).execute;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('resolution=unique（单城唯一命中）', () => {
    it('city 已传 + 单城返回 → 直接采纳首个候选并展开成 result', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ poiName: '九亭镇', district: '松江区', township: '九亭镇' }),
      ]);

      const result = (await execute({ address: '九亭', city: '上海' })) as Record<string, unknown>;

      expect(result.resolution).toBe('unique');
      expect(result.result).toMatchObject({
        city: '上海市',
        district: '松江区',
        township: '九亭镇',
      });
      expect(mockGeocodingService.searchCandidates).toHaveBeenCalledWith('九亭', '上海');
    });

    it('city 留空 + 单城返回 → 直接采纳（让 geocode 替 LLM 做判定）', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ poiName: '马陆地铁站' }),
        makeCandidate({ poiName: '马陆镇政府', township: '马陆镇' }),
      ]);

      const result = (await execute({ address: '马陆' })) as Record<string, unknown>;

      expect(result.resolution).toBe('unique');
      expect((result.result as Record<string, unknown>).city).toBe('上海市');
      expect(mockGeocodingService.searchCandidates).toHaveBeenCalledWith('马陆', null);
    });
  });

  describe('同城道路名 vs 地铁站（锚点择优）', () => {
    // 线上 case：候选人说"七莘路"（实指 12 号线七莘路站），高德 POI 把「道路」排第一，
    // 其代表点落在路北端华漕，距真实站点 ~10km；收敛逻辑应改取同名地铁站。
    it('首条是道路名 + 同城存在地铁站 → 采纳地铁站坐标，而非道路代表点', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({
          poiName: '七莘路',
          typecode: '190301', // 交通地名;道路名
          district: '闵行区',
          longitude: 121.327282,
          latitude: 31.192294, // 道路北端（华漕）
        }),
        makeCandidate({
          poiName: '七莘路(地铁站)',
          typecode: '150500', // 地铁站
          district: '闵行区',
          longitude: 121.355,
          latitude: 31.108, // 12 号线七莘路站（莘庄）
        }),
      ]);

      const result = (await execute({ address: '七莘路', city: '上海' })) as Record<
        string,
        unknown
      >;

      expect(result.resolution).toBe('unique');
      expect(result.result).toMatchObject({
        longitude: 121.355,
        latitude: 31.108,
      });
    });

    it('首条已是地铁站 → 直接采纳，不受道路降级影响', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({
          poiName: '马陆地铁站',
          typecode: '150500',
          longitude: 121.28,
          latitude: 31.33,
        }),
        makeCandidate({
          poiName: '马陆路',
          typecode: '190301',
          longitude: 121.27,
          latitude: 31.32,
        }),
      ]);

      const result = (await execute({ address: '马陆', city: '上海' })) as Record<string, unknown>;

      expect(result.result).toMatchObject({ longitude: 121.28, latitude: 31.33 });
    });

    it('首条是道路名但无地铁站 → 退而取更具体的非道路 POI', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ poiName: '解放路', typecode: '190301', longitude: 121.4, latitude: 31.2 }),
        makeCandidate({
          poiName: '解放路商业广场',
          typecode: '060101',
          longitude: 121.41,
          latitude: 31.21,
        }),
      ]);

      const result = (await execute({ address: '解放路', city: '上海' })) as Record<
        string,
        unknown
      >;

      expect(result.result).toMatchObject({ longitude: 121.41, latitude: 31.21 });
    });

    it('旧缓存候选缺 typecode 字段 → 按名称兜底而不抛错（线上 case：上海九亭）', async () => {
      // typecode 是 bb04aff4 新增字段，发版前写入 Redis 的候选反序列化后没有该字段；
      // 必须走 poiName 兜底正常收敛，不得 TypeError 落入 geocode.failed
      const legacy = makeCandidate({
        poiName: '九亭镇',
        district: '松江区',
        township: '九亭镇',
        longitude: 121.32,
        latitude: 31.11,
      });
      delete (legacy as Partial<GeocodeCandidate>).typecode;
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([legacy]);

      const result = (await execute({ address: '九亭', city: '上海' })) as Record<string, unknown>;

      expect(result.resolution).toBe('unique');
      expect(result.result).toMatchObject({ longitude: 121.32, latitude: 31.11 });
    });

    it('全部都是道路名（无更优候选）→ 兜底沿用首条', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ poiName: '某条路', typecode: '190301', longitude: 121.5, latitude: 31.3 }),
        makeCandidate({
          poiName: '某条路辅路',
          typecode: '190301',
          longitude: 121.6,
          latitude: 31.4,
        }),
      ]);

      const result = (await execute({ address: '某条路', city: '上海' })) as Record<
        string,
        unknown
      >;

      expect(result.result).toMatchObject({ longitude: 121.5, latitude: 31.3 });
    });
  });

  describe('resolution=ambiguous（多城同名）', () => {
    it('多城返回 → 列出去重后的城市清单 + 引导反问', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({
          city: '上海市',
          district: '黄浦区',
          formattedAddress: '上海市黄浦区解放路',
          poiName: '解放路',
        }),
        makeCandidate({
          city: '南京市',
          district: '秦淮区',
          formattedAddress: '江苏省南京市秦淮区解放路',
          poiName: '解放路',
          province: '江苏省',
        }),
        makeCandidate({
          city: '杭州市',
          district: '上城区',
          formattedAddress: '浙江省杭州市上城区解放路',
          poiName: '解放路',
          province: '浙江省',
        }),
      ]);

      const result = (await execute({ address: '解放路' })) as Record<string, unknown>;

      expect(result.resolution).toBe('ambiguous');
      const candidates = result.candidates as Array<{ city: string }>;
      expect(candidates).toHaveLength(3);
      expect(candidates.map((c) => c.city)).toEqual(['上海市', '南京市', '杭州市']);
      expect(result._replyInstruction).toContain('多个城市');
      expect(result._replyInstruction).toContain('禁止默认');
    });

    it('多城候选超过 3 个时只展示前 3 个不同城市', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ city: '北京市' }),
        makeCandidate({ city: '上海市' }),
        makeCandidate({ city: '广州市' }),
        makeCandidate({ city: '深圳市' }),
        makeCandidate({ city: '北京市' }), // 重复 city 应被去重
      ]);

      const result = (await execute({ address: '人民路' })) as Record<string, unknown>;

      const candidates = result.candidates as Array<{ city: string }>;
      expect(candidates).toHaveLength(3);
      expect(new Set(candidates.map((c) => c.city)).size).toBe(3);
    });
  });

  describe('非地名词碎片（badcase 6k394ya0："有我附近" 被当成地名 "有我"）', () => {
    it.each(['有我', '我这边', '家里', '附近', '我住的地方'])(
      'address=%s 不打高德直接报错',
      async (address) => {
        const result = (await execute({ address })) as Record<string, unknown>;

        expect(result.errorType).toBe(TOOL_ERROR_TYPES.GEOCODE_UNRESOLVED_ADDRESS);
        expect(String(result._replyInstruction)).toContain('不是地名');
        expect(mockGeocodingService.searchCandidates).not.toHaveBeenCalled();
      },
    );
  });

  describe('GEOCODE_AMBIGUOUS_SUFFIX（命中通用后缀黑名单）', () => {
    it('未传 city + 万达广场 → 直接报黑名单错误，不打高德', async () => {
      const result = (await execute({ address: '万达广场' })) as Record<string, unknown>;

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.GEOCODE_AMBIGUOUS_SUFFIX);
      expect(result._replyInstruction).toContain('跨城同名');
      expect(result._replyInstruction).not.toMatch(/上海|北京|杭州|成都|武汉/);
      expect(mockGeocodingService.searchCandidates).not.toHaveBeenCalled();
    });

    it('已传 city + 万达广场 → 不触发黑名单，正常走 searchCandidates', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({
          city: '上海市',
          district: '浦东新区',
          formattedAddress: '上海市浦东新区万达广场',
          poiName: '上海浦东万达广场',
        }),
      ]);

      const result = (await execute({ address: '万达广场', city: '上海' })) as Record<
        string,
        unknown
      >;

      expect(result.resolution).toBe('unique');
      expect(mockGeocodingService.searchCandidates).toHaveBeenCalledWith('万达广场', '上海');
    });

    it('未传 city + 火车站 → 命中黑名单', async () => {
      const result = (await execute({ address: '火车站' })) as Record<string, unknown>;
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.GEOCODE_AMBIGUOUS_SUFFIX);
    });

    // badcase 回归：候选人答"漕宝路地铁"，旧逻辑因"地铁站"后缀短路报黑名单，
    // 强制反问"在哪个城市"——专名前缀车站应放行给高德全国搜索。
    it('未传 city + 漕宝路地铁站（专名前缀）→ 不触发黑名单，走 searchCandidates', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({
          city: '上海市',
          district: '徐汇区',
          formattedAddress: '上海市徐汇区漕宝路地铁站',
          poiName: '漕宝路(地铁站)',
          typecode: '150500',
        }),
      ]);

      const result = (await execute({ address: '漕宝路地铁站' })) as Record<string, unknown>;

      expect(result.resolution).toBe('unique');
      expect(mockGeocodingService.searchCandidates).toHaveBeenCalledWith('漕宝路地铁站', null);
    });
  });

  describe('GEOCODE_DISTRICT_CITY_MISMATCH（跨城同名区被错配到异城）', () => {
    // 线上 case：候选人答"雨花区板桥"（南京雨花台区板桥），未带 city 时高德把整串模糊匹配到
    // 「长沙县盼盼路13号板桥小区」并以单城 unique 返回，Agent 误判长沙无岗后静默收口。
    it('未传 city + "雨花区板桥" + 高德返回长沙县 POI → 报区/城不一致，引导中性反问城市', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({
          city: '长沙市',
          province: '湖南省',
          district: '长沙县',
          formattedAddress: '湖南省长沙市长沙县盼盼路13号板桥小区',
          poiName: '板桥小区',
          longitude: 113.083632,
          latitude: 28.219622,
        }),
      ]);

      const result = (await execute({ address: '雨花区板桥' })) as Record<string, unknown>;

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.GEOCODE_DISTRICT_CITY_MISMATCH);
      expect(result.resolution).toBeUndefined();
      // 反问必须中性，不得把错城/任何具体城市名抖给候选人
      expect(result._replyInstruction).not.toMatch(/长沙|南京/);
      expect(mockGeocodingService.searchCandidates).toHaveBeenCalledWith('雨花区板桥', null);
    });

    it('未传 city + "雨花区板桥" + 高德返回南京雨花台区 POI → 区名一致(口语vs官方前缀包含)，正常 unique', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({
          city: '南京市',
          province: '江苏省',
          district: '雨花台区',
          formattedAddress: '江苏省南京市雨花台区板桥(地铁站)',
          poiName: '板桥(地铁站)',
          longitude: 118.640707,
          latitude: 31.907893,
        }),
      ]);

      const result = (await execute({ address: '雨花区板桥' })) as Record<string, unknown>;

      expect(result.resolution).toBe('unique');
      expect((result.result as Record<string, unknown>).city).toBe('南京市');
    });

    it('已传 city + "雨花区板桥" → citylimit 已生效，跳过一致性校验直接采纳', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({
          city: '南京市',
          province: '江苏省',
          district: '雨花台区',
          formattedAddress: '江苏省南京市雨花台区板桥(地铁站)',
          poiName: '板桥(地铁站)',
          longitude: 118.640707,
          latitude: 31.907893,
        }),
      ]);

      const result = (await execute({ address: '雨花区板桥', city: '南京' })) as Record<
        string,
        unknown
      >;

      expect(result.resolution).toBe('unique');
      expect(mockGeocodingService.searchCandidates).toHaveBeenCalledWith('雨花区板桥', '南京');
    });

    it('address 无"区/县"token（裸地标）→ 不触发一致性校验，保持原 unique 行为', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({
          city: '长沙市',
          province: '湖南省',
          district: '长沙县',
          poiName: '板桥小区',
        }),
      ]);

      const result = (await execute({ address: '板桥' })) as Record<string, unknown>;

      expect(result.resolution).toBe('unique');
    });
  });

  describe('可信位置锚点纠偏', () => {
    const buildContextualExecute = (
      anchor: NonNullable<ToolBuildContext['turnInput']['geocodeLocationAnchor']>,
    ): ExecuteFn => {
      const contextualTool = buildGeocodeTool(mockGeocodingService)(
        createToolContext({
          session: { userId: 'test-user', corpId: 'test-corp', sessionId: 'test-session' },
          turnInput: { geocodeLocationAnchor: anchor },
        }),
      );
      return (contextualTool as unknown as { execute: ExecuteFn }).execute;
    };

    const manualAnchor: NonNullable<ToolBuildContext['turnInput']['geocodeLocationAnchor']> = {
      city: '上海',
      districts: ['嘉定'],
      source: 'human_agent',
      referenceText: '上海嘉定同济园是吧，我看下',
      evidence: '人工招募经理消息：上海嘉定同济园是吧，我看下',
    };

    it('首查错到杨浦时带完整锚点重查，并只返回嘉定坐标（batch_6a4f77b6）', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock)
        .mockResolvedValueOnce([
          makeCandidate({
            formattedAddress: '上海市杨浦区本溪路300号同济绿园',
            district: '杨浦区',
            poiName: '同济绿园',
            longitude: 121.511576,
            latitude: 31.274761,
          }),
        ])
        .mockResolvedValueOnce([
          makeCandidate({
            formattedAddress: '上海市嘉定区曹安公路4800号同济大学嘉定校区',
            district: '嘉定区',
            poiName: '同济大学(嘉定校区)',
            longitude: 121.21416,
            latitude: 31.286012,
          }),
        ]);

      const contextualExecute = buildContextualExecute(manualAnchor);
      const result = (await contextualExecute({ address: '同济园', city: '上海' })) as Record<
        string,
        unknown
      >;

      expect(mockGeocodingService.searchCandidates).toHaveBeenNthCalledWith(1, '同济园', '上海');
      expect(mockGeocodingService.searchCandidates).toHaveBeenNthCalledWith(
        2,
        '上海嘉定同济园',
        '上海',
      );
      expect(result.resolution).toBe('unique');
      expect(result.result).toMatchObject({
        district: '嘉定区',
        longitude: 121.21416,
        latitude: 31.286012,
      });
      expect(result.contextCorrection).toMatchObject({
        applied: true,
        originalAddress: '同济园',
        resolvedAddress: '上海嘉定同济园',
      });
    });

    it('首批候选同时含杨浦和嘉定时先按锚点过滤，不被同城 unique 误导', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ district: '杨浦区', poiName: '同济绿园', longitude: 121.51 }),
        makeCandidate({ district: '嘉定区', poiName: '同济大学嘉定校区', longitude: 121.21 }),
      ]);

      const result = (await buildContextualExecute(manualAnchor)({
        address: '同济园',
        city: '上海',
      })) as Record<string, unknown>;

      expect(mockGeocodingService.searchCandidates).toHaveBeenCalledTimes(1);
      expect(result.result).toMatchObject({ district: '嘉定区', longitude: 121.21 });
    });

    it('重查仍错区时 fail closed，不暴露首次错误坐标', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({
          formattedAddress: '上海市杨浦区本溪路300号同济绿园',
          district: '杨浦区',
          poiName: '同济绿园',
          longitude: 121.511576,
          latitude: 31.274761,
        }),
      ]);

      const result = (await buildContextualExecute(manualAnchor)({
        address: '同济园',
        city: '上海',
      })) as Record<string, unknown>;

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.GEOCODE_ANCHOR_MISMATCH);
      expect(result.resolution).toBeUndefined();
      expect(result.result).toBeUndefined();
      expect(result.longitude).toBeUndefined();
      expect(result._replyInstruction).toContain('禁止采用本次坐标');
    });

    it('首次已命中锚点区县时不重复查询', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ district: '嘉定区', poiName: '同济大学嘉定校区' }),
      ]);

      const result = (await buildContextualExecute(manualAnchor)({
        address: '同济园',
        city: '上海',
      })) as Record<string, unknown>;

      expect(result.resolution).toBe('unique');
      expect(mockGeocodingService.searchCandidates).toHaveBeenCalledTimes(1);
    });

    it('与人工锚点无关的新地点不套用旧区县', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ district: '杨浦区', poiName: '五角场' }),
      ]);

      const result = (await buildContextualExecute(manualAnchor)({
        address: '五角场',
        city: '上海',
      })) as Record<string, unknown>;

      expect(result.resolution).toBe('unique');
      expect(result.result).toMatchObject({ district: '杨浦区' });
      expect(mockGeocodingService.searchCandidates).toHaveBeenCalledTimes(1);
    });

    it('人工锚点 referenceText 为空时仍可按锚点区县匹配查询', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ district: '嘉定区', poiName: '同济大学嘉定校区' }),
      ]);

      const result = (await buildContextualExecute({
        ...manualAnchor,
        referenceText: '',
      })({ address: '嘉定同济园', city: '上海' })) as Record<string, unknown>;

      expect(result.resolution).toBe('unique');
      expect(result.result).toMatchObject({ district: '嘉定区' });
    });

    it('镇级锚点可由候选 township 命中，不与父级 district 假冲突', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ district: '浦东新区', township: '川沙新镇', poiName: '川沙地铁站' }),
      ]);

      const result = (await buildContextualExecute({
        city: '上海',
        districts: ['川沙'],
        source: 'current_user',
        referenceText: '我在川沙',
        evidence: '候选人原话：我在川沙',
      })({ address: '川沙', city: '上海' })) as Record<string, unknown>;

      expect(result.resolution).toBe('unique');
      expect(result.result).toMatchObject({ district: '浦东新区', township: '川沙新镇' });
    });
  });

  describe('city 参数出处门与低置信确认流', () => {
    it('无会话出处的 city 入参降级为 null，由 geocode 自行三态裁决', async () => {
      const instance = buildGeocodeTool(mockGeocodingService)(
        createToolContext({
          turnInput: {
            messages: [
              { role: 'user', content: '[图片消息]' },
              {
                role: 'user',
                content: '[引用 招聘经理：在哪]\n静安寺附近\n[消息发送时间：2026-08-13 10:24:32]',
              },
            ],
          },
        }),
      );
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ poiName: '静安寺' }),
      ]);

      await (instance as unknown as { execute: ExecuteFn }).execute({
        address: '静安寺',
        city: '上海',
      });

      expect(mockGeocodingService.searchCandidates).toHaveBeenCalledWith('静安寺', null);
    });

    describe('跨城纠偏闸（周度 case 10/8：佛山南海「上海村」被纠偏到上海「海上海」）', () => {
      const shanghaiCurrentUserAnchor: NonNullable<
        ToolBuildContext['turnInput']['geocodeLocationAnchor']
      > = {
        city: '上海',
        districts: [],
        source: 'current_user',
        referenceText: '当前候选人消息：南海桂城上海村',
        evidence: '当前候选人消息：南海桂城上海村',
      };
      const foshanVillage = makeCandidate({
        city: '佛山市',
        province: '广东省',
        district: '南海区',
        township: '桂城街道',
        poiName: '上海村',
        formattedAddress: '广东省佛山市南海区桂城街道上海村',
        longitude: 113.15,
        latitude: 23.03,
      });
      const haiShanghai = makeCandidate({
        city: '上海市',
        district: '杨浦区',
        township: '',
        poiName: '海上海',
        formattedAddress: '上海市杨浦区飞虹路600弄海上海',
        longitude: 121.508209,
        latitude: 31.266653,
        confidence: 'high',
      });
      const buildAnchoredTool = () => {
        const ctx = createToolContext({
          session: { userId: 'test-user', corpId: 'test-corp', sessionId: 'test-session' },
          turnInput: { geocodeLocationAnchor: shanghaiCurrentUserAnchor },
        });
        const instance = buildGeocodeTool(mockGeocodingService)(ctx);
        return { ctx, execute: (instance as unknown as { execute: ExecuteFn }).execute };
      };

      it('地址写明另一城市的区/街镇时按地址采纳，不纠偏到锚点城市', async () => {
        (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValueOnce([foshanVillage]);
        const { ctx, execute: anchoredExecute } = buildAnchoredTool();

        const result = (await anchoredExecute({
          address: '南海桂城上海村',
        })) as Record<string, unknown>;

        expect(mockGeocodingService.searchCandidates).toHaveBeenCalledTimes(1);
        expect(result.resolution).toBe('unique');
        expect(result.result).toMatchObject({ city: '佛山市', district: '南海区' });
        expect(result.contextCorrection).toMatchObject({
          applied: false,
          reason: 'address_administrative_echo',
          anchorCity: '上海',
        });
        expect(ctx.ledger.geo.anchors.map((anchor) => anchor.city)).toEqual(['佛山市']);
      });

      it('跨城纠偏结果不回显原地址时先请候选人确认，不宣告已确认城市、不写锚点', async () => {
        (mockGeocodingService.searchCandidates as jest.Mock)
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([haiShanghai]);
        const { ctx, execute: anchoredExecute } = buildAnchoredTool();

        const result = (await anchoredExecute({ address: '上海村' })) as Record<string, unknown>;

        expect(result.resolution).toBe('needs_confirmation');
        expect(result._cityConfirmed).toBeUndefined();
        expect(ctx.ledger.geo.anchors).toHaveLength(0);
      });

      it('首查只有异城候选且无行政回显时，纠偏结果回显原地址仍可采纳', async () => {
        (mockGeocodingService.searchCandidates as jest.Mock)
          .mockResolvedValueOnce([
            makeCandidate({
              city: '北京市',
              district: '西城区',
              township: '',
              poiName: '中山公园',
              formattedAddress: '北京市西城区中山公园',
            }),
          ])
          .mockResolvedValueOnce([
            makeCandidate({
              city: '上海市',
              district: '长宁区',
              township: '',
              poiName: '中山公园',
              formattedAddress: '上海市长宁区中山公园',
            }),
          ]);
        const { execute: anchoredExecute } = buildAnchoredTool();

        const result = (await anchoredExecute({ address: '中山公园' })) as Record<string, unknown>;

        expect(result.resolution).toBe('unique');
        expect(result.result).toMatchObject({ city: '上海市', district: '长宁区' });
        expect(result.contextCorrection).toMatchObject({ applied: true });
      });
    });

    it('地址出处判定只进原始输出留档，不进模型可见结果（shadow 观测）', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValueOnce([
        makeCandidate({
          poiName: '漕宝路(地铁站)',
          district: '徐汇区',
          township: '',
          formattedAddress: '上海市徐汇区漕宝路(地铁站)',
        }),
      ]);
      const assistantReply = '你好呀～龙虾过敏我记下了哈。你还是在漕宝路这边找工作吗？';
      const instance = buildGeocodeTool(mockGeocodingService)(
        createToolContext({
          turnInput: {
            messages: [
              { role: 'user', content: '我是龙虾过敏\n你好你好，我在上海' },
              { role: 'assistant', content: assistantReply },
              { role: 'user', content: '好好好\n我想找服务员' },
            ],
          },
        }),
      );
      const typed = instance as unknown as {
        execute: ExecuteFn;
        toModelOutput: (options: { output: unknown }) => { type: string; value: unknown };
      };

      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const output = (await typed.execute({ address: '漕宝路', city: '上海' })) as Record<
        string,
        unknown
      >;
      const provenanceWarn = warnSpy.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes('只出现在 Agent 自己的消息里'));
      warnSpy.mockRestore();

      expect(output.resolution).toBe('unique');
      expect(output._addressProvenance).toMatchObject({
        verdict: 'unattested',
        assistantOnly: true,
      });
      // 日志只留元数据，不打印候选人地址原文。
      expect(provenanceWarn).toContain('matchedBy=none');
      expect(provenanceWarn).toContain('sessionId=');
      expect(provenanceWarn).not.toContain('漕宝路');
      const modelView = typed.toModelOutput({ output });
      expect(modelView.type).toBe('json');
      expect(modelView.value).not.toHaveProperty('_addressProvenance');
      expect(modelView.value).toHaveProperty('resolution', 'unique');
    });

    it('低置信纠错结果未回显原查询词时进入 needs_confirmation，不写坐标锚点', async () => {
      const ctx = createToolContext({
        turnInput: {
          messages: [
            {
              role: 'user',
              content: '[图片消息]\n沈北吾月\n[消息发送时间：2026-08-13 10:24:32]',
            },
          ],
        },
      });
      const instance = buildGeocodeTool(mockGeocodingService)(ctx);
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({
          city: '沈阳市',
          district: '沈北新区',
          township: '',
          poiName: '沈北新区吾悦广场',
          formattedAddress: '辽宁省沈阳市沈北新区吾悦广场',
          confidence: 'medium',
        }),
      ]);

      const result = (await (instance as unknown as { execute: ExecuteFn }).execute({
        address: '沈北吾月',
      })) as Record<string, unknown>;

      expect(result.resolution).toBe('needs_confirmation');
      expect(result.result).toBeUndefined();
      expect(ctx.ledger.geo.anchors).toHaveLength(0);
    });
  });

  describe('城市出处回执与全国搜交叉核对（BadCase 复核 [17]：佛山候选人说王府井被推北京）', () => {
    const wangfujingBeijing = () =>
      makeCandidate({
        formattedAddress: '北京市东城区王府井',
        province: '北京市',
        city: '北京市',
        district: '东城区',
        township: '东华门街道',
        poiName: '王府井',
        longitude: 116.41,
        latitude: 39.91,
      });
    const wangfujingFoshan = () =>
      makeCandidate({
        formattedAddress: '广东省佛山市南海区王府井',
        province: '广东省',
        city: '佛山市',
        district: '南海区',
        township: '桂城街道',
        poiName: '王府井',
        longitude: 113.14,
        latitude: 23.03,
      });
    const foshanGroupContext = (over: Parameters<typeof createToolContext>[0] = {}) =>
      createToolContext({
        session: { userId: 'u', corpId: 'c', sessionId: 's' },
        archive: { realtimeGroupCities: ['佛山'], ...(over.archive ?? {}) },
        turnInput: {
          messages: [
            { role: 'user', content: '王府井附近有兼职吗\n[消息发送时间：2026-10-12 14:19:00]' },
          ],
          ...(over.turnInput ?? {}),
        },
      });
    const run = (ctx: ToolBuildContext, args: { address: string; city?: string | null }) =>
      (buildGeocodeTool(mockGeocodingService)(ctx) as unknown as { execute: ExecuteFn }).execute(
        args,
      ) as Promise<Record<string, unknown>>;

    it('city 无出处被忽略 + 全国搜落在别城 → needs_confirmation、回执 _cityIgnored、不宣称已确认、不写锚点', async () => {
      // 生产复现：模型传 city=佛山（候选人没打过「佛山」、无 pref.city），出处门丢弃后全国搜「王府井」
      // 唯一命中北京，旧实现回 `_cityConfirmed 北京` 并在轮末写 pref.city=北京 system/high。
      const ctx = createToolContext({
        session: { userId: 'u', corpId: 'c', sessionId: 's' },
        turnInput: { messages: [{ role: 'user', content: '王府井附近有兼职吗' }] },
      });
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([wangfujingBeijing()]);

      const result = await run(ctx, { address: '王府井', city: '佛山' });

      expect(mockGeocodingService.searchCandidates).toHaveBeenCalledWith('王府井', null);
      expect(result.resolution).toBe('needs_confirmation');
      expect(result._cityConfirmed).toBeUndefined();
      expect(String(result._cityIgnored)).toContain('city=「佛山」没有出处');
      expect(String(result._cityIgnored)).toContain('按全国搜索');
      expect(result._cityIgnoredReason).toBe('city_unverified');
      expect(result).toMatchObject({ ignoredCity: '佛山', resolvedCity: '北京市' });
      const instruction = String(result._replyInstruction);
      expect(instruction).toContain('禁止向候选人宣称已确认城市');
      expect(instruction).toContain('禁止按「北京市」查岗');
      expect(instruction).toContain('你是在佛山这边对吧');
      expect(ctx.ledger.geo.anchors).toHaveLength(0);
      expect(ctx.ledger.geo.cityAttestation).toBeUndefined();
    });

    it('city 无出处被忽略但全国搜落在同一城市 → 仍需确认，不让搜索结果为模型猜测作证', async () => {
      const ctx = createToolContext({
        session: { userId: 'u', corpId: 'c', sessionId: 's' },
        turnInput: { messages: [{ role: 'user', content: '王府井附近有兼职吗' }] },
      });
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([wangfujingFoshan()]);

      const result = await run(ctx, { address: '王府井', city: '佛山' });

      expect(result.resolution).toBe('needs_confirmation');
      expect(result._cityConfirmed).toBeUndefined();
      expect(result._cityIgnoredReason).toBe('city_unverified');
      expect(result.resolvedCity).toBe('佛山市');
      expect(ctx.ledger.geo.anchors).toHaveLength(0);
      expect(ctx.ledger.geo.cityAttestation).toBeUndefined();
    });

    it('已在佛山群 → city=佛山 有出处（realtime_group），按佛山限定搜索、不回执 _cityIgnored', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([wangfujingFoshan()]);

      const result = await run(foshanGroupContext(), { address: '王府井', city: '佛山' });

      expect(mockGeocodingService.searchCandidates).toHaveBeenCalledWith('王府井', '佛山');
      expect(result.resolution).toBe('unique');
      expect(result._cityIgnored).toBeUndefined();
      expect(ctx_city(result)).toBe('佛山市');
    });

    it('会话记忆被污染为北京、候选人在佛山群 → city=佛山 仍放行（群城市档优先于 city_conflict）', async () => {
      // [17] 第二轮：pref.city=北京(system/high) 已写入，模型再传佛山也会被 city_conflict 丢弃。
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([wangfujingFoshan()]);
      const ctx = foshanGroupContext({
        archive: {
          realtimeGroupCities: ['佛山'],
          sessionFacts: {
            preferences: { city: { value: '北京', confidence: 'high', source: 'system' } },
          } as unknown as ToolBuildContext['archive']['sessionFacts'],
        },
      });

      const result = await run(ctx, { address: '王府井', city: '佛山' });

      expect(mockGeocodingService.searchCandidates).toHaveBeenCalledWith('王府井', '佛山');
      expect(result.resolution).toBe('unique');
      // 会话记忆冲突披露照常附带，由模型向候选人确认，不静默沿用也不静默覆盖。
      expect(String(result._cityConflictNotice)).toContain('北京');
    });

    it('city 留空全国搜 unique 与候选人所在群城市不一致、且该城市无出处 → needs_confirmation', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([wangfujingBeijing()]);
      const ctx = foshanGroupContext();

      const result = await run(ctx, { address: '王府井' });

      expect(result.resolution).toBe('needs_confirmation');
      expect(result).toMatchObject({ resolvedCity: '北京市', contextCities: ['佛山'] });
      const instruction = String(result._replyInstruction);
      expect(instruction).toContain('候选人当前所在兼职群/在途预约门店显示在「佛山」');
      expect(instruction).toContain('确认是在「佛山」还是「北京市」');
      expect(ctx.ledger.geo.cityAttestation).toBeUndefined();
    });

    it.each([
      { ownedByCandidate: true, resolution: 'needs_confirmation' },
      { ownedByCandidate: undefined, resolution: 'needs_confirmation' },
      { ownedByCandidate: false, resolution: 'unique' },
    ])(
      '全国搜仅与本人预约城市交叉核对：$ownedByCandidate',
      async ({ ownedByCandidate, resolution }) => {
        (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
          wangfujingBeijing(),
        ]);
        const ctx = createToolContext({
          session: { userId: 'u', corpId: 'c', sessionId: 's' },
          archive: {
            bookingWorkOrders: [
              {
                workOrderId: 1,
                jobId: 2,
                source: 'active_booking',
                storeCity: '佛山市',
                ownedByCandidate,
              },
            ],
          },
          turnInput: { messages: [{ role: 'user', content: '王府井附近有兼职吗' }] },
        });

        const result = await run(ctx, { address: '王府井' });

        expect(result.resolution).toBe(resolution);
        if (ownedByCandidate === false) {
          expect(result.contextCities).toBeUndefined();
        } else {
          expect(result.contextCities).toEqual(['佛山']);
        }
      },
    );

    it('非本人预约不能授权 city 限定搜索或写入城市锚点', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([wangfujingFoshan()]);
      const ctx = createToolContext({
        session: { userId: 'u', corpId: 'c', sessionId: 's' },
        archive: {
          bookingWorkOrders: [
            {
              workOrderId: 1,
              jobId: 2,
              source: 'out_of_band',
              storeCity: '佛山市',
              ownedByCandidate: false,
            },
          ],
        },
        turnInput: { messages: [{ role: 'user', content: '王府井附近有兼职吗' }] },
      });

      const result = await run(ctx, { address: '王府井', city: '佛山' });

      expect(mockGeocodingService.searchCandidates).toHaveBeenCalledWith('王府井', null);
      expect(result.resolution).toBe('needs_confirmation');
      expect(result._cityIgnoredReason).toBe('city_unverified');
      expect(ctx.ledger.geo.anchors).toHaveLength(0);
      expect(ctx.ledger.geo.cityAttestation).toBeUndefined();
    });

    it('旧会话记忆不能绕过全国搜索与实时群城市的冲突确认', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([wangfujingBeijing()]);
      const ctx = foshanGroupContext({
        archive: {
          realtimeGroupCities: ['佛山'],
          sessionFacts: {
            preferences: { city: { value: '北京', confidence: 'high', source: 'system' } },
          } as unknown as ToolBuildContext['archive']['sessionFacts'],
        },
      });

      const result = await run(ctx, { address: '王府井' });

      expect(result.resolution).toBe('needs_confirmation');
      expect(result._cityConfirmed).toBeUndefined();
      expect(ctx.ledger.geo.cityAttestation).toBeUndefined();
    });

    it('全国搜城市与群城市不一致，但候选人本会话亲口提过该城市 → 照常 unique（换城市不被旧群线索拦）', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([wangfujingBeijing()]);
      const ctx = foshanGroupContext({
        turnInput: {
          messages: [{ role: 'user', content: '我搬到北京了，王府井附近有兼职吗' }],
        },
      });

      const result = await run(ctx, { address: '王府井' });

      expect(result.resolution).toBe('unique');
      expect(ctx_city(result)).toBe('北京市');
    });

    it('群城市与全国搜城市一致 → 照常 unique', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([wangfujingFoshan()]);

      const result = await run(foshanGroupContext(), { address: '王府井' });

      expect(result.resolution).toBe('unique');
    });

    it('city=null 全国搜得到的 unique 城市确权标记 nationwideSearch=true；带出处 city 限定搜索则为 false', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([wangfujingBeijing()]);
      const nationwide = createToolContext({
        session: { userId: 'u', corpId: 'c', sessionId: 's' },
        turnInput: { messages: [{ role: 'user', content: '王府井附近有兼职吗' }] },
      });
      await run(nationwide, { address: '王府井' });
      expect(nationwide.ledger.geo.cityAttestation).toMatchObject({
        city: '北京市',
        source: 'geocode_unique',
        nationwideSearch: true,
      });

      const limited = createToolContext({
        session: { userId: 'u', corpId: 'c', sessionId: 's' },
        turnInput: { messages: [{ role: 'user', content: '我在北京，王府井附近有兼职吗' }] },
      });
      await run(limited, { address: '王府井', city: '北京' });
      expect(limited.ledger.geo.cityAttestation).toMatchObject({
        city: '北京市',
        nationwideSearch: false,
      });
    });

    it('description 声明 city 只认有出处的城市、needs_confirmation 与 _cityIgnored 口径', () => {
      const description = String((toolInstance as unknown as { description: string }).description);
      expect(description).toContain('_cityIgnored');
      expect(description).toContain('resolution=needs_confirmation');
      expect(description).toContain('候选人已在的兼职群城市');
      expect(description).toContain('在途预约门店城市');
    });

    function ctx_city(result: Record<string, unknown>): unknown {
      return (result.result as Record<string, unknown> | undefined)?.city;
    }
  });

  describe('GEOCODE_UNRESOLVED_ADDRESS', () => {
    it('candidates 为空数组 → 返回未解析错误', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([]);

      const result = (await execute({ address: '不存在', city: '上海' })) as Record<
        string,
        unknown
      >;

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.GEOCODE_UNRESOLVED_ADDRESS);
      expect(result.address).toBe('不存在');
      expect(result.city).toBe('上海');
    });

    it('address 为空字符串 → 直接报未解析，不打高德', async () => {
      const result = (await execute({ address: '   ', city: '上海' })) as Record<string, unknown>;

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.GEOCODE_UNRESOLVED_ADDRESS);
      expect(mockGeocodingService.searchCandidates).not.toHaveBeenCalled();
    });
  });

  describe('GEOCODE_FAILED', () => {
    it('searchCandidates 抛错 → 不向候选人泄露异常原文', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockRejectedValue(new Error('API down'));

      const result = (await execute({ address: '九亭', city: '上海' })) as Record<string, unknown>;

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.GEOCODE_FAILED);
      expect(result.reason).toBe('API down');
      expect(result._replyInstruction).toContain('稍等');
      expect(result._replyInstruction).not.toContain('API down');
    });
  });

  describe('areaLevelQuery（区/市级粗粒度查询标记）', () => {
    it('marks areaLevelQuery=true when address is just the district name (badcase recvjyv0SKiqe3)', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ poiName: '松江区', district: '松江区', township: '' }),
      ]);

      const result = (await execute({ address: '松江', city: '上海' })) as Record<string, unknown>;

      expect(result.resolution).toBe('unique');
      expect((result.result as Record<string, unknown>).areaLevelQuery).toBe(true);
    });

    it('marks areaLevelQuery=true when address matches the city name', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ city: '常州市', district: '新北区', township: '' }),
      ]);

      const instance = toolBuilder(
        createToolContext({ turnInput: { messages: [{ role: 'user', content: '我在常州' }] } }),
      );
      const result = (await (instance as unknown as { execute: ExecuteFn }).execute({
        address: '常州',
        city: '常州',
      })) as Record<string, unknown>;

      expect((result.result as Record<string, unknown>).areaLevelQuery).toBe(true);
    });

    it('marks areaLevelQuery=false for POI / township level queries', async () => {
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ poiName: '九亭镇', district: '松江区', township: '九亭镇' }),
      ]);

      const result = (await execute({ address: '九亭', city: '上海' })) as Record<string, unknown>;

      expect((result.result as Record<string, unknown>).areaLevelQuery).toBe(false);
    });
  });

  describe('城市结论前置披露（方案 11.4 B-2）', () => {
    function makeContext(sessionCity?: string): ToolBuildContext {
      return createToolContext({
        session: { userId: 'u', corpId: 'c', sessionId: 's' },
        turnInput: { messages: [{ role: 'user', content: '我现在在上海' }] },
        archive: sessionCity
          ? {
              sessionFacts: {
                preferences: {
                  city: { value: sessionCity, confidence: 'high', evidence: 'explicit_city' },
                },
              } as unknown as ToolBuildContext['archive']['sessionFacts'],
            }
          : {},
      });
    }

    it('POI 级 unique 解析 → _cityConfirmed 前置为首字段，含城市与定位点', async () => {
      const ctx = makeContext();
      const instance = buildGeocodeTool(mockGeocodingService)(ctx);
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ poiName: '九亭镇', district: '松江区', township: '九亭镇' }),
      ]);

      const result = (await (instance as unknown as { execute: ExecuteFn }).execute({
        address: '九亭',
        city: '上海',
      })) as Record<string, unknown>;

      expect(Object.keys(result)[0]).toBe('_cityConfirmed');
      expect(result._cityConfirmed).toBe('已确认城市：上海市；已定位到 九亭镇（精确坐标）');
      expect(result._cityConflictNotice).toBeUndefined();
      expect(result.resolution).toBe('unique');
    });

    it('区级 unique 解析 → _cityConfirmed 标注行政区代表点而非精确坐标', async () => {
      const ctx = makeContext();
      const instance = buildGeocodeTool(mockGeocodingService)(ctx);
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ poiName: '嘉定区', district: '嘉定区', township: '' }),
      ]);

      const result = (await (instance as unknown as { execute: ExecuteFn }).execute({
        address: '嘉定',
        city: '上海',
      })) as Record<string, unknown>;

      expect(result._cityConfirmed).toBe('已确认城市：上海市（已定位到行政区代表点：嘉定区）');
      expect(result._cityConfirmed).not.toContain('精确坐标');
    });

    it('解析城市与会话记忆城市冲突 → 附 _cityConflictNotice，不静默覆盖', async () => {
      const ctx = makeContext('成都');
      const instance = buildGeocodeTool(mockGeocodingService)(ctx);
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ poiName: '静安寺', district: '静安区', township: '' }),
      ]);

      const result = (await (instance as unknown as { execute: ExecuteFn }).execute({
        address: '静安寺',
        city: '上海',
      })) as Record<string, unknown>;

      expect(result._cityConflictNotice).toContain('上海市');
      expect(result._cityConflictNotice).toContain('成都');
      expect(result._cityConflictNotice).toContain('禁止静默');
      // 冲突只做知情披露，解析结果本身不被改写
      expect((result.result as Record<string, unknown>).city).toBe('上海市');
    });

    it('会话记忆城市与解析城市一致（市后缀差异归一）→ 不附冲突披露', async () => {
      const ctx = makeContext('上海');
      const instance = buildGeocodeTool(mockGeocodingService)(ctx);
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ poiName: '静安寺', district: '静安区', township: '' }),
      ]);

      const result = (await (instance as unknown as { execute: ExecuteFn }).execute({
        address: '静安寺',
        city: '上海',
      })) as Record<string, unknown>;

      expect(result._cityConflictNotice).toBeUndefined();
    });

    // 2026-08-06 生产观测：当期 14 条冲突提示里 11 条的"会话意向城市"根本不是城市，
    // 冲突是假的、推给候选人的多余反问是真的。
    it.each(['hello', 'null', '只晚班', '我是应聘的', '平坊'])(
      '会话记忆城市是抽取污染残留「%s」→ 不附冲突披露（不推多余反问给候选人）',
      async (dirtyCity) => {
        const ctx = makeContext(dirtyCity);
        const instance = buildGeocodeTool(mockGeocodingService)(ctx);
        (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
          makeCandidate({ poiName: '静安寺', district: '静安区', township: '' }),
        ]);

        const result = (await (instance as unknown as { execute: ExecuteFn }).execute({
          address: '静安寺',
          city: '上海',
        })) as Record<string, unknown>;

        expect(result._cityConflictNotice).toBeUndefined();
        // 城市结论本身照常披露，不受影响
        expect(result._cityConfirmed).toContain('上海市');
      },
    );

    it('会话记忆城市是真实城市（海南东方市）→ 冲突披露照常', async () => {
      const ctx = makeContext('东方');
      const instance = buildGeocodeTool(mockGeocodingService)(ctx);
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ poiName: '静安寺', district: '静安区', township: '' }),
      ]);

      const result = (await (instance as unknown as { execute: ExecuteFn }).execute({
        address: '静安寺',
        city: '上海',
      })) as Record<string, unknown>;

      expect(result._cityConflictNotice).toContain('东方');
    });

    it('description 声明解析成功后禁止再反问城市', () => {
      expect(toolInstance.description).toContain('_cityConfirmed');
      expect(toolInstance.description).toContain('禁止再向候选人询问已确认的城市');
      expect(toolInstance.description).toContain('不得静默按新城市推进');
    });
  });

  describe('回合上下文锚点记录（方案 11.3 B-1：areaLevelQuery 确定性传递）', () => {
    function makeContext(city = '上海'): ToolBuildContext {
      return createToolContext({
        session: { userId: 'u', corpId: 'c', sessionId: 's' },
        turnInput: { messages: [{ role: 'user', content: `我在${city}` }] },
      });
    }

    it('区级 unique 解析 → 记录 areaLevelQuery=true + 行政区名到 context.geocodeAnchors', async () => {
      const ctx = makeContext();
      const instance = buildGeocodeTool(mockGeocodingService)(ctx);
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ poiName: '嘉定区', district: '嘉定区', township: '' }),
      ]);

      await (instance as unknown as { execute: ExecuteFn }).execute({
        address: '嘉定',
        city: '上海',
      });

      expect(ctx.ledger.geo.anchors).toHaveLength(1);
      expect(ctx.ledger.geo.anchors[0]).toMatchObject({
        longitude: 121.27,
        latitude: 31.32,
        areaLevelQuery: true,
        areaName: '嘉定区',
        city: '上海市',
      });
    });

    it('unique 解析 → 触发 recordCityAttestation 城市确权回调（证据化 A1）', async () => {
      const recordCityAttestation = jest.fn();
      const ctx = mergeToolContext(makeContext('沈阳'), { ledger: { recordCityAttestation } });
      const instance = buildGeocodeTool(mockGeocodingService)(ctx);
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({
          formattedAddress: '辽宁省沈阳市浑南区奥体中心(公交站)',
          province: '辽宁省',
          city: '沈阳市',
          district: '浑南区',
          township: '',
          poiName: '奥体中心',
        }),
      ]);

      await (instance as unknown as { execute: ExecuteFn }).execute({
        address: '奥体中心地铁口',
        city: '沈阳',
      });

      expect(recordCityAttestation).toHaveBeenCalledTimes(1);
      expect(recordCityAttestation.mock.calls[0][0]).toMatchObject({
        city: '沈阳市',
        district: '浑南区',
        source: 'geocode_unique',
      });
      expect(recordCityAttestation.mock.calls[0][0].evidence).toContain('geocode 唯一解析');
    });

    it('POI 级 unique 解析 → 记录 areaLevelQuery=false', async () => {
      const ctx = makeContext();
      const instance = buildGeocodeTool(mockGeocodingService)(ctx);
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ poiName: '九亭镇', district: '松江区', township: '九亭镇' }),
      ]);

      await (instance as unknown as { execute: ExecuteFn }).execute({
        address: '九亭',
        city: '上海',
      });

      expect(ctx.ledger.geo.anchors).toHaveLength(1);
      expect(ctx.ledger.geo.anchors[0]).toMatchObject({
        areaLevelQuery: false,
        areaName: null,
      });
    });

    it('ambiguous 多城歧义 → 不记录锚点', async () => {
      const ctx = makeContext();
      const instance = buildGeocodeTool(mockGeocodingService)(ctx);
      (mockGeocodingService.searchCandidates as jest.Mock).mockResolvedValue([
        makeCandidate({ city: '南京市', district: '鼓楼区', formattedAddress: '南京市鼓楼区' }),
        makeCandidate({ city: '福州市', district: '鼓楼区', formattedAddress: '福州市鼓楼区' }),
      ]);

      const result = (await (instance as unknown as { execute: ExecuteFn }).execute({
        address: '鼓楼',
      })) as Record<string, unknown>;

      expect(result.resolution).toBe('ambiguous');
      expect(ctx.ledger.geo.anchors).toHaveLength(0);
    });
  });
});
