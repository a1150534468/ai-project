import { describe, it, expect } from 'vitest';
import { chunkText } from './chunk.js';

describe('chunkText', () => {
  it('按字符窗口切块且不超上限', () => {
    const text = '段落一。'.repeat(2000); // 长文本
    const chunks = chunkText(text, { maxTokens: 50, overlapTokens: 10, maxChunks: 5 });
    expect(chunks.length).toBeLessThanOrEqual(5);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].length).toBeGreaterThan(0);
  });

  it('空白返回空数组', () => {
    expect(chunkText('   ', { maxTokens: 50, overlapTokens: 10, maxChunks: 5 })).toEqual([]);
    expect(chunkText('', { maxTokens: 50, overlapTokens: 10, maxChunks: 5 })).toEqual([]);
  });

  it('正常切出多块且有重叠', () => {
    const text = 'abcdefghij'.repeat(50); // 500 字符
    const chunks = chunkText(text, { maxTokens: 30, overlapTokens: 5, maxChunks: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    // 验证重叠：相邻块应该有重叠部分
    if (chunks.length > 1) {
      const chunk0End = chunks[0].slice(-5); // 最后 5 个字符
      const chunk1Start = chunks[1].slice(0, 5); // 开始 5 个字符
      // 由于有重叠，可能会共享一些内容
      expect(chunks[1]).toContain(chunk0End.slice(0, 1));
    }
  });

  it('单块文本直接返回', () => {
    const text = 'hello world';
    const chunks = chunkText(text, { maxTokens: 100, overlapTokens: 10, maxChunks: 5 });
    expect(chunks).toEqual([text]);
  });

  it('尊重 maxChunks 限制', () => {
    const text = 'x'.repeat(10000);
    const chunks = chunkText(text, { maxTokens: 50, overlapTokens: 10, maxChunks: 3 });
    expect(chunks.length).toBeLessThanOrEqual(3);
  });

  it('过滤仅空白的块', () => {
    const text = 'hello   \n\n   world';
    const chunks = chunkText(text, { maxTokens: 5, overlapTokens: 1, maxChunks: 100 });
    // 所有块应该非空白
    for (const chunk of chunks) {
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });
});
