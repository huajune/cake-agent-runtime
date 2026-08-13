import type { BrandItem } from '@/sponge/sponge.types';
import type { BrandResolution } from '@resolution/brand/brand-resolution.types';
import { resolveBrands } from '@resolution/brand/brand-matcher';
import { normalizeForBrandMatch } from '@resolution/brand/brand-normalize';
import { isAssistantEchoUtterance, isSystemTextReflow } from '@resolution/brand/llm-intent-guards';
import { stripQuotedBlocks, stripTimeContext } from '@resolution/signal/markers';

export interface BrandAliasHint {
  brandName: string;
  matchedAlias: string;
  sourceText: string;
}

export interface BrandIntentInput {
  brand?: string | null;
  polarity: 'positive' | 'negative' | 'browse_all';
}

export interface RejectedBrandIntent {
  brand: string | null;
  reason: 'empty_positive' | 'system_text_reflow' | 'catalog_miss' | 'assistant_echo';
}

/** hints/规则轨统一入口：协议标记在 producer 内清洗，调用方无法漏做。 */
export function produceBrandAliasHints(
  userMessages: readonly string[],
  brandData: readonly BrandItem[],
): BrandAliasHint[] {
  if (userMessages.length === 0 || brandData.length === 0) return [];
  const hints: BrandAliasHint[] = [];
  const seen = new Set<string>();
  for (const raw of userMessages) {
    const message = stripQuotedBlocks(stripTimeContext(raw));
    if (!message) continue;
    for (const resolution of resolveBrands(message, 'user_text', brandData)) {
      if (resolution.ambiguous || !resolution.canonicalName) continue;
      const matchedAlias =
        resolution.matchType === 'category_expansion'
          ? `${resolution.matchedText}(品类)`
          : (resolution.matchedText ?? resolution.canonicalName);
      const dedupeKey = `${resolution.canonicalName}::${message}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      hints.push({ brandName: resolution.canonicalName, matchedAlias, sourceText: message });
    }
  }
  return hints;
}

/** LLM 品牌意图的目录确权与说话人归因；返回拒绝项供 memory 观测。 */
export function produceValidatedBrandIntents(
  intents: readonly BrandIntentInput[],
  brandData: readonly BrandItem[],
  assistantTexts: readonly string[] = [],
): { accepted: BrandResolution[]; rejected: RejectedBrandIntent[] } {
  const normalizedAssistantTexts = assistantTexts.map(normalizeForBrandMatch).filter(Boolean);
  const accepted: BrandResolution[] = [];
  const rejected: RejectedBrandIntent[] = [];
  for (const intent of intents) {
    const brand = intent.brand?.trim() || null;
    if (!brand) {
      if (intent.polarity === 'negative' || intent.polarity === 'browse_all') {
        accepted.push({
          canonicalName: null,
          brandId: null,
          matchedText: null,
          sourceText: null,
          source: 'user_text',
          matchType: null,
          intentPolarity: intent.polarity,
          confidence: 0.9,
          ambiguous: false,
        });
      } else {
        rejected.push({ brand, reason: 'empty_positive' });
      }
      continue;
    }
    if (isSystemTextReflow(brand)) {
      rejected.push({ brand, reason: 'system_text_reflow' });
      continue;
    }
    const resolutions = resolveBrands(brand, 'user_text', brandData).filter(
      (resolution) => !resolution.ambiguous && resolution.canonicalName !== null,
    );
    if (resolutions.length === 0) {
      rejected.push({ brand, reason: 'catalog_miss' });
      continue;
    }
    if (
      isAssistantEchoUtterance({
        normalizedBrandField: normalizeForBrandMatch(brand),
        normalizedMatchedTexts: resolutions.map((resolution) =>
          normalizeForBrandMatch(resolution.matchedText ?? ''),
        ),
        normalizedAssistantTexts,
      })
    ) {
      rejected.push({ brand, reason: 'assistant_echo' });
      continue;
    }
    accepted.push(
      ...resolutions.map((resolution) => ({
        ...resolution,
        intentPolarity: intent.polarity,
      })),
    );
  }
  return { accepted, rejected };
}
