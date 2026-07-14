/**
 * BrandResolution DI 门面（§6.5）：取目录 → 调纯函数 → 返回，无业务逻辑。
 *
 * 品牌目录经 SpongeService.fetchBrandList() 获取（自带 30 分钟缓存），调用方不必各自拉目录。
 * 核心解析逻辑在 brand-matcher.ts 的纯函数 resolveBrands，单测直接注入目录即可。
 * 第一版保持无会话状态：目录索引按数组引用做轻量缓存，但不持有任何会话数据。
 */

import { Injectable, Logger } from '@nestjs/common';
import { SpongeService } from '@sponge/sponge.service';
import type { BrandResolution, BrandResolutionSource } from './brand-resolution.types';
import {
  resolveBrandAliasInputs,
  resolveBrands,
  type AliasResolutionOutcome,
} from './brand-matcher';

@Injectable()
export class BrandResolutionService {
  private readonly logger = new Logger(BrandResolutionService.name);

  constructor(private readonly spongeService: SpongeService) {}

  /** 解析一段文本中的品牌信号。目录拉取失败按"无品牌结果"降级，不阻断调用方主流程。 */
  async resolve(text: string, source: BrandResolutionSource): Promise<BrandResolution[]> {
    const catalog = await this.fetchCatalog();
    return resolveBrands(text, source, catalog);
  }

  /** 工具入口的品牌别名标准化（§8.2）：解析成唯一标准品牌，冲突/未命中进 rejected。 */
  async resolveAliases(inputs: string[]): Promise<AliasResolutionOutcome> {
    const catalog = await this.fetchCatalog();
    return resolveBrandAliasInputs(inputs, catalog);
  }

  private async fetchCatalog(): Promise<Awaited<ReturnType<SpongeService['fetchBrandList']>>> {
    try {
      return await this.spongeService.fetchBrandList();
    } catch (error) {
      this.logger.warn(
        `品牌目录拉取失败，按无品牌结果降级: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}
