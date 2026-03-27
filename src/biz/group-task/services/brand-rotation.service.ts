import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@infra/redis/redis.service';

const KEY_PREFIX = 'group-task:brand-history';
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 天

/**
 * 品牌轮转服务
 *
 * 用 Redis 记录每个群最近推过的品牌，保证非重复推荐。
 * Key: group-task:brand-history:{groupId}（JSON 数组，TTL 7天）
 */
@Injectable()
export class BrandRotationService {
  private readonly logger = new Logger(BrandRotationService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * 从可用品牌中选择下一个要推的品牌（避免重复）
   *
   * 逻辑：
   * 1. 读取最近推过的品牌列表
   * 2. 从 availableBrands 中找第一个不在已推列表里的
   * 3. 若全部推过，重置轮转，从头开始
   *
   * @param groupId 群 ID
   * @param availableBrands 当前有数据的品牌列表
   * @returns 选中的品牌名
   */
  async getNextBrand(groupId: string, availableBrands: string[]): Promise<string | null> {
    if (availableBrands.length === 0) return null;

    const history = await this.getHistory(groupId);

    // 找第一个没推过的品牌
    const nextBrand = availableBrands.find((brand) => !history.includes(brand));

    if (nextBrand) {
      return nextBrand;
    }

    // 所有品牌都推过，重置轮转
    this.logger.log(`[品牌轮转] ${groupId} 所有品牌已推完，重置轮转`);
    await this.clearHistory(groupId);
    return availableBrands[0];
  }

  /**
   * 记录已推送的品牌
   */
  async recordPushedBrand(groupId: string, brand: string): Promise<void> {
    const key = `${KEY_PREFIX}:${groupId}`;
    try {
      const history = await this.getHistory(groupId);
      history.push(brand);
      await this.redis.setex(key, TTL_SECONDS, JSON.stringify(history));
      this.logger.debug(`[品牌轮转] ${groupId} 记录品牌: ${brand}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[品牌轮转] 记录失败: ${message}`);
    }
  }

  /**
   * 获取已推送历史
   */
  private async getHistory(groupId: string): Promise<string[]> {
    const key = `${KEY_PREFIX}:${groupId}`;
    try {
      const raw = await this.redis.get(key);
      if (!raw) return [];
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  /**
   * 清除推送历史
   */
  private async clearHistory(groupId: string): Promise<void> {
    const key = `${KEY_PREFIX}:${groupId}`;
    try {
      await this.redis.del(key);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[品牌轮转] 清除历史失败: ${message}`);
    }
  }
}
