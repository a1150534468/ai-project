import { describe, it, expect } from 'vitest';
import { parseDocument, EmptyTextError } from './parse.js';

describe('parseDocument', () => {
  it('txt 直接 utf8', async () => {
    const out = await parseDocument(Buffer.from('hello world'), 'text/plain', 'a.txt');
    expect(out).toContain('hello');
    expect(out).toContain('world');
  });

  it('md 直接 utf8', async () => {
    const out = await parseDocument(
      Buffer.from('# 标题\n正文'),
      'text/markdown',
      'a.md',
    );
    expect(out).toContain('标题');
    expect(out).toContain('正文');
  });

  it('空文本抛 EmptyTextError', async () => {
    await expect(
      parseDocument(Buffer.from('   '), 'text/plain', 'a.txt'),
    ).rejects.toBeInstanceOf(EmptyTextError);

    await expect(
      parseDocument(Buffer.from(''), 'text/plain', 'a.txt'),
    ).rejects.toBeInstanceOf(EmptyTextError);
  });

  it('不支持的类型抛 Error', async () => {
    await expect(
      parseDocument(Buffer.from('data'), 'application/octet-stream', 'a.bin'),
    ).rejects.toThrow();
  });

  it('json 按 utf8 解析', async () => {
    const out = await parseDocument(
      Buffer.from('{"key": "value"}'),
      'application/json',
      'a.json',
    );
    expect(out).toContain('key');
    expect(out).toContain('value');
  });

  it('xml 按 utf8 解析', async () => {
    const out = await parseDocument(
      Buffer.from('<root><item>text</item></root>'),
      'application/xml',
      'a.xml',
    );
    expect(out).toContain('root');
    expect(out).toContain('text');
  });

  it('xlsx 提取工作表文本', async () => {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['客户', '金额'],
      ['星野科技', 128],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, '订单');

    const out = await parseDocument(
      Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'orders.xlsx',
    );

    expect(out).toContain('订单');
    expect(out).toContain('客户');
    expect(out).toContain('星野科技');
    expect(out).toContain('128');
  });

  it('pptx 提取幻灯片文本', async () => {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file(
      'ppt/slides/slide1.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld>
          <p:spTree>
            <p:sp>
              <p:txBody>
                <a:p><a:r><a:t>季度复盘</a:t></a:r></a:p>
                <a:p><a:r><a:t>增长 23%</a:t></a:r></a:p>
              </p:txBody>
            </p:sp>
          </p:spTree>
        </p:cSld>
      </p:sld>`,
    );

    const out = await parseDocument(
      await zip.generateAsync({ type: 'nodebuffer' }),
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'report.pptx',
    );

    expect(out).toContain('Slide 1');
    expect(out).toContain('季度复盘');
    expect(out).toContain('增长 23%');
  });
});
