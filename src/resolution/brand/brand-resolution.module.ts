import { Module } from '@nestjs/common';
import { SpongeModule } from '@sponge/sponge.module';
import { BrandResolutionService } from './brand-resolution.service';

/**
 * 品牌解析域模块（§5）。
 *
 * 依赖方向：Sponge 品牌目录 → resolution/brand → memory / agent preparation / tools / guardrail。
 * resolution/ 只依赖 sponge/，不反向依赖 SessionService、具体工具、Prompt、Redis 或 Guardrail。
 */
@Module({
  imports: [SpongeModule],
  providers: [BrandResolutionService],
  exports: [BrandResolutionService],
})
export class BrandResolutionModule {}
