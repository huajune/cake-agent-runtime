import { zipSync, strToU8 } from 'fflate';
import { extractDocxText, extractWordXmlText } from '@tools/resume/docx-text.util';

const xml = (body: string) =>
  `<?xml version="1.0"?><w:document xmlns:w="urn:test"><w:body>${body}</w:body></w:document>`;
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

describe('docx-text.util', () => {
  it('extracts paragraphs, tabs, breaks and XML entities', () => {
    expect(
      extractWordXmlText(
        xml(
          '<w:p><w:r><w:t>姓名：兮兮</w:t></w:r><w:tab/><w:r><w:t>A&amp;B</w:t></w:r><w:br/></w:p>',
        ),
      ),
    ).toBe('姓名：兮兮 A&B');
  });

  it('reads headers before body and footers after body', () => {
    const archive = zipSync({
      'word/document.xml': strToU8(xml(paragraph('工作经历：测试咖啡店'))),
      'word/header1.xml': strToU8(xml(paragraph('姓名：兮兮'))),
      'word/footer1.xml': strToU8(xml(paragraph('电话：18271421690'))),
      '[Content_Types].xml': strToU8('<Types/>'),
    });
    expect(extractDocxText(Buffer.from(archive))).toBe(
      '姓名：兮兮\n工作经历：测试咖啡店\n电话：18271421690',
    );
  });

  it('rejects invalid zip and docx without document.xml', () => {
    expect(() => extractDocxText(Buffer.from('not a zip'))).toThrow(
      expect.objectContaining({ kind: 'parse_failed' }),
    );
    const archive = zipSync({ 'word/header1.xml': strToU8(xml(paragraph('姓名：兮兮'))) });
    expect(() => extractDocxText(Buffer.from(archive))).toThrow(
      expect.objectContaining({ kind: 'parse_failed' }),
    );
  });
});
