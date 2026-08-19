import { PDFParse } from 'pdf-parse';
import { extractPdfText, THIN_TEXT_CHARS_PER_PAGE } from '@tools/resume/pdf-text.util';

jest.mock('pdf-parse', () => ({ PDFParse: jest.fn() }));

const MockPDFParse = PDFParse as unknown as jest.Mock;

describe('pdf-text.util', () => {
  const destroy = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('marks a mixed/scanned PDF thin by average parsed-page characters', async () => {
    const getText = jest.fn().mockResolvedValue({
      text: '封面文字',
      total: 2,
      pages: [
        { num: 1, text: '封面文字' },
        { num: 2, text: '' },
      ],
    });
    MockPDFParse.mockImplementation(() => ({ getText, destroy }));

    const result = await extractPdfText(Buffer.from('%PDF-fake'), 2);
    expect(result).toMatchObject({ totalPages: 2, pagesParsed: 2, thin: true });
    expect(result.charsPerPage).toBeLessThan(THIN_TEXT_CHARS_PER_PAGE);
    expect(destroy).toHaveBeenCalled();
  });

  it('keeps a sufficiently dense text layer on the PDF track', async () => {
    MockPDFParse.mockImplementation(() => ({
      getText: jest.fn().mockResolvedValue({
        text: '简历正文'.repeat(40),
        total: 1,
        pages: [{ num: 1, text: '简历正文'.repeat(40) }],
      }),
      destroy,
    }));
    await expect(extractPdfText(Buffer.from('%PDF-fake'))).resolves.toMatchObject({
      thin: false,
      totalPages: 1,
      pagesParsed: 1,
    });
  });

  it('maps parser failures and still destroys the parser', async () => {
    MockPDFParse.mockImplementation(() => ({
      getText: jest.fn().mockRejectedValue(new Error('broken pdf')),
      destroy,
    }));
    await expect(extractPdfText(Buffer.from('%PDF-broken'))).rejects.toMatchObject({
      kind: 'parse_failed',
    });
    expect(destroy).toHaveBeenCalled();
  });
});
