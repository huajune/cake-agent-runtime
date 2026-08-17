import { toErrorMessage } from '@infra/utils/error.util';
import type { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PDFParse } from 'pdf-parse';
import { z } from 'zod';
import { imageMediaType, ResumeReadError } from './resume-format.util';

export const TALL_IMAGE_SLICE_HEIGHT = 3_000;
export const TALL_IMAGE_SLICE_OVERLAP = 200;
const SCREENSHOT_MAX_PAGES = 2;

const TRANSCRIPTION_SCHEMA = z.object({
  text: z.string().describe('按图片从上到下顺序逐行转写的全部可见文字'),
});

const TRANSCRIPTION_SYSTEM =
  '你是简历逐行转写器。只按从上到下顺序逐字转写可见文字，保留字段标签和换行；看不清写[看不清]；禁止补全、总结、解释或输出置信度。';

async function transcribeImageBuffer(
  buffer: Buffer,
  mediaType: 'image/jpeg' | 'image/png',
  llm: LlmExecutorService,
): Promise<string> {
  const image = `data:${mediaType};base64,${buffer.toString('base64')}`;
  const result = await llm.generateStructured({
    role: ModelRole.Vision,
    schema: TRANSCRIPTION_SCHEMA,
    system: TRANSCRIPTION_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', image },
          { type: 'text', text: '逐行完整转写这份简历，除转写正文外不要输出任何内容。' },
        ],
      },
    ],
    maxOutputTokens: 2_200,
  });
  return result.output.text.trim();
}

function mergeTranscriptions(parts: readonly string[]): string {
  let merged = '';
  for (const part of parts.map((value) => value.trim()).filter(Boolean)) {
    if (!merged) {
      merged = part;
      continue;
    }
    const previous = merged.split('\n');
    const next = part.split('\n');
    let overlap = 0;
    const max = Math.min(8, previous.length, next.length);
    for (let size = max; size >= 1; size -= 1) {
      const suffix = previous
        .slice(-size)
        .map((line) => line.trim())
        .join('\n');
      const prefix = next
        .slice(0, size)
        .map((line) => line.trim())
        .join('\n');
      if (suffix && suffix === prefix) {
        overlap = size;
        break;
      }
    }
    merged = `${merged}\n${next.slice(overlap).join('\n')}`.trim();
  }
  return merged;
}

export async function sliceTallImage(
  buffer: Buffer,
  sliceHeight = TALL_IMAGE_SLICE_HEIGHT,
  overlap = TALL_IMAGE_SLICE_OVERLAP,
): Promise<Buffer[]> {
  if (sliceHeight <= 0 || overlap < 0 || overlap >= sliceHeight) {
    throw new ResumeReadError('vision_failed', 'invalid tall-image slice parameters');
  }
  try {
    const image = await loadImage(buffer);
    if (image.height <= sliceHeight) return [buffer];
    const slices: Buffer[] = [];
    for (let top = 0; top < image.height; top += sliceHeight - overlap) {
      const height = Math.min(sliceHeight, image.height - top);
      const canvas = createCanvas(image.width, height);
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, image.width, height);
      context.drawImage(image, 0, top, image.width, height, 0, 0, image.width, height);
      slices.push(await canvas.encode('png'));
      if (top + height >= image.height) break;
    }
    return slices;
  } catch (error) {
    if (error instanceof ResumeReadError) throw error;
    throw new ResumeReadError('vision_failed', toErrorMessage(error));
  }
}

export async function transcribeResumeImage(
  buffer: Buffer,
  llm: LlmExecutorService,
): Promise<string> {
  const mediaType = imageMediaType(buffer);
  if (!mediaType) throw new ResumeReadError('unsupported_format', 'unsupported resume image');
  try {
    const slices = await sliceTallImage(buffer);
    const parts: string[] = [];
    for (const slice of slices) {
      parts.push(
        await transcribeImageBuffer(slice, slices.length === 1 ? mediaType : 'image/png', llm),
      );
    }
    const text = mergeTranscriptions(parts);
    if (!text) throw new Error('vision returned empty transcription');
    return text;
  } catch (error) {
    if (error instanceof ResumeReadError) throw error;
    throw new ResumeReadError('vision_failed', toErrorMessage(error));
  }
}

export async function transcribeScannedPdf(
  buffer: Buffer,
  llm: LlmExecutorService,
): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const screenshots = await parser.getScreenshot({
      first: SCREENSHOT_MAX_PAGES,
      desiredWidth: 1_200,
      imageBuffer: true,
      imageDataUrl: false,
    });
    const parts: string[] = [];
    for (const page of screenshots.pages) {
      parts.push(await transcribeImageBuffer(Buffer.from(page.data), 'image/png', llm));
    }
    const text = parts.filter(Boolean).join('\n');
    if (!text) throw new Error('vision returned empty scanned-pdf transcription');
    return text;
  } catch (error) {
    throw new ResumeReadError('vision_failed', toErrorMessage(error));
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
