import { describe, it, expect } from 'vitest';
import * as renderModule from '../../src/outbound/render.js';
import { normalizeQqMarkdown, splitByUtf8Bytes } from '../../src/outbound/render.js';

describe('契约测试: 出站渲染模块已移除 stripMarkdown，仅保留原生 Markdown 规范化与字节切分', () => {
  it('已彻底移除 stripMarkdown 导出', () => {
    expect((renderModule as any).stripMarkdown).toBeUndefined();
  });
});

describe('契约测试: normalizeQqMarkdown 标题修补、代码块隔离与编码净化', () => {
  it('修补代码块外的行首无空格 #标题 -> # 标题（支持 1~6 级）', () => {
    const md = '#一级标题\n##二级标题\n######六级标题\n# 已有空格\n#######七个井号不改\n普通行 #非行首';
    expect(normalizeQqMarkdown(md)).toBe(
      '# 一级标题\n## 二级标题\n###### 六级标题\n# 已有空格\n#######七个井号不改\n普通行 #非行首'
    );
  });

  it('围栏代码块（``` 与 ~~~）内部保持原样，绝不改写 #注释 或 #define', () => {
    const md = [
      '#外层标题',
      '```python',
      '#这是Python注释',
      '##双井号注释',
      '```',
      '~~~c',
      '#define MAX 100',
      '~~~',
      '##外层副标题',
    ].join('\n');

    expect(normalizeQqMarkdown(md)).toBe(
      [
        '# 外层标题',
        '```python',
        '#这是Python注释',
        '##双井号注释',
        '```',
        '~~~c',
        '#define MAX 100',
        '~~~',
        '## 外层副标题',
      ].join('\n')
    );
  });

  it('保留正常 Markdown 富文本（数学乘法、下划线标识符、行内反引号与 CRLF 换行）不被误破坏', () => {
    const md = '#总览\r\n3 * 4 * 5 = 60\r\n调用 `read_memory` 与 `foo_bar_baz`\r\n```js\r\n#keep\r\n```';
    expect(normalizeQqMarkdown(md)).toBe(
      '# 总览\r\n3 * 4 * 5 = 60\r\n调用 `read_memory` 与 `foo_bar_baz`\r\n```js\r\n#keep\r\n```'
    );
  });

  it('清洗孤立代理项与 C0 控制字符，保留合法换行/制表符且不截断超长正文', () => {
    const longLine = '正文'.repeat(12000);
    const input = `#标题\u0000\t内容\uD800\n${longLine}`;
    const out = normalizeQqMarkdown(input);
    expect(out.startsWith('# 标题\t内容\uFFFD\n')).toBe(true);
    expect(out.endsWith(longLine)).toBe(true);
  });

  it('空字符串或非字符串输入安全返回空串', () => {
    expect(normalizeQqMarkdown('')).toBe('');
    expect(normalizeQqMarkdown(null as any)).toBe('');
    expect(normalizeQqMarkdown(undefined as any)).toBe('');
  });
});

describe('契约测试: splitByUtf8Bytes 字节上限切分与码点/代理对保护', () => {
  it('严格按 UTF-8 字节上限切分，绝不静默丢字', () => {
    const text = '第一行\n第二行很长很长需要切分\n第三行 hello world foo bar\n😀🚀✨';
    const parts = splitByUtf8Bytes(text, 12);
    expect(parts.join('')).toBe(text);
    for (const part of parts) {
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(12);
    }
  });

  it('优先在换行与空格边界切分，不从多字节汉字或 UTF-16 代理对中间切断', () => {
    const lineBreakSample = 'aaaa\nbbbb\ncccc';
    expect(splitByUtf8Bytes(lineBreakSample, 10)).toEqual(['aaaa\nbbbb\n', 'cccc']);

    const spaceSample = 'alpha beta gamma';
    expect(splitByUtf8Bytes(spaceSample, 11)).toEqual(['alpha beta ', 'gamma']);

    const emojiSample = 'a😀b🚀c';
    const emojiParts = splitByUtf8Bytes(emojiSample, 5);
    expect(emojiParts).toEqual(['a😀', 'b🚀', 'c']);
    expect(emojiParts.join('')).toBe(emojiSample);
    for (const part of emojiParts) {
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(part)).toBe(false);
    }
  });

  it('maxBytes 小于单个 4 字节 emoji 时仍推进完整码点不死循环', () => {
    const parts = splitByUtf8Bytes('😀中a', 2);
    expect(parts).toEqual(['😀', '中', 'a']);
    expect(parts.join('')).toBe('😀中a');
  });

  it('空串返回空数组', () => {
    expect(splitByUtf8Bytes('', 100)).toEqual([]);
  });
});
