import { createCanvas } from '@napi-rs/canvas';
import { PDFParse } from 'pdf-parse';
import type { LlmExecutorService } from '@/llm/llm-executor.service';
import {
  sliceTallImage,
  transcribeResumeImage,
  transcribeScannedPdf,
} from '@tools/resume/resume-transcribe.util';

jest.mock('pdf-parse', () => ({ PDFParse: jest.fn() }));

const MockPDFParse = PDFParse as unknown as jest.Mock;

async function png(width: number, height: number): Promise<Buffer> {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#111111';
  context.fillRect(0, Math.floor(height / 2), width, 4);
  return canvas.encode('png');
}

function llmWithTexts(texts: string[]): LlmExecutorService {
  return {
    generateStructured: jest
      .fn()
      .mockImplementation(async () => ({ output: { text: texts.shift() ?? '' } })),
  } as unknown as LlmExecutorService;
}

describe('resume-transcribe.util', () => {
  it('keeps ordinary images whole and slices >3000px images with 200px overlap', async () => {
    await expect(sliceTallImage(await png(100, 1200))).resolves.toHaveLength(1);
    const slices = await sliceTallImage(await png(100, 6500));
    expect(slices).toHaveLength(3);
  });

  it('transcribes an image and merges exact overlap lines across slices', async () => {
    const llm = llmWithTexts([
      '姓名：兮兮\n电话：18271421690',
      '电话：18271421690\n学历：本科',
      '学历：本科\n工作经历：测试咖啡店',
    ]);
    await expect(transcribeResumeImage(await png(100, 6500), llm)).resolves.toBe(
      '姓名：兮兮\n电话：18271421690\n学历：本科\n工作经历：测试咖啡店',
    );
    expect(llm.generateStructured).toHaveBeenCalledTimes(3);
  });

  it('renders at most two scanned PDF pages and transcribes each screenshot', async () => {
    const page = await png(100, 140);
    const destroy = jest.fn().mockResolvedValue(undefined);
    const getScreenshot = jest.fn().mockResolvedValue({
      total: 3,
      pages: [
        { pageNumber: 1, data: page },
        { pageNumber: 2, data: page },
      ],
    });
    MockPDFParse.mockImplementation(() => ({ getScreenshot, destroy }));
    const llm = llmWithTexts(['姓名：兮兮', '电话：18271421690']);

    await expect(transcribeScannedPdf(Buffer.from('%PDF-fake'), llm)).resolves.toBe(
      '姓名：兮兮\n电话：18271421690',
    );
    expect(getScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ first: 2, desiredWidth: 1200, imageBuffer: true }),
    );
    expect(destroy).toHaveBeenCalled();
  });
});
