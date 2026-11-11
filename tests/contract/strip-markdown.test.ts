import { describe, it, expect } from 'vitest';
import {
  normalizeQqMarkdown,
  splitByUtf8Bytes,
  stripMarkdown,
} from '../../src/outbound/render.js';

describe('契约测试: stripMarkdown 误伤防护（数学/标识符/字面链接等普通文本不被误剥）', () => {
  it('防误伤: 数字间的乘号 `3 * 4 * 5 = 60` 原样保留', () => {
    expect(stripMarkdown('3 * 4 * 5 = 60')).toBe('3 * 4 * 5 = 60');
  });

  it('防误伤: 无空格乘法 `2 * 3` / `3*4*5` / `2 ** 3` 原样保留', () => {
    expect(stripMarkdown('2 * 3')).toBe('2 * 3');
    expect(stripMarkdown('3*4*5')).toBe('3*4*5');
    expect(stripMarkdown('2 ** 3')).toBe('2 ** 3');
  });

  it('防误伤: 单词/标识符内下划线 `a_b_c`、`read_memory`、`foo_bar_baz` 原样保留', () => {
    expect(stripMarkdown('a_b_c')).toBe('a_b_c');
    expect(stripMarkdown('read_memory')).toBe('read_memory');
    expect(stripMarkdown('foo_bar_baz')).toBe('foo_bar_baz');
  });

  it('防误伤: 数字分隔符 `100_000` 原样保留', () => {
    expect(stripMarkdown('100_000')).toBe('100_000');
  });

  it('防误伤: 无闭合孤立符号 `*单独行`、列表符号 `* 列表项`、`- 列表项` 原样保留', () => {
    expect(stripMarkdown('*单独行')).toBe('*单独行');
    expect(stripMarkdown('* 列表项')).toBe('* 列表项');
    expect(stripMarkdown('- 列表项')).toBe('- 列表项');
  });

  it('防误伤: 字面 `[标题](url)` 文本不被当链接改写（url 非确凿 URL 时保留）', () => {
    expect(stripMarkdown('[标题](url)')).toBe('[标题](url)');
  });

  it('防误伤: 非行首 `#`（`C# 语言`）与行首 `#tag`（无空格）原样保留', () => {
    expect(stripMarkdown('C# 语言')).toBe('C# 语言');
    expect(stripMarkdown('#tag')).toBe('#tag');
  });

  it('防误伤: 行首比较式 `foo > bar` 不被当引用块剥掉', () => {
    expect(stripMarkdown('foo > bar')).toBe('foo > bar');
  });

  it('防误伤: 字母乘法 `a*b*c` 保守保留', () => {
    expect(stripMarkdown('a*b*c')).toBe('a*b*c');
  });

  it('防误伤: 表格行之间换行不被吞掉（行不粘连）', () => {
    const out = stripMarkdown('| 服务 | 状态 |\n|---|---|\n| Gateway | 在线 |');
    expect(out).toBe('服务 | 状态\n\nGateway | 在线');
  });
});

describe('契约测试: stripMarkdown 剥离功能保留（确凿 markdown 正常剥离）', () => {
  it('正常剥离: 粗体 `**加粗**` -> 加粗', () => {
    expect(stripMarkdown('**加粗**')).toBe('加粗');
  });

  it('正常剥离: 行首 `# 标题` -> 【标题】', () => {
    expect(stripMarkdown('# 标题')).toBe('【标题】');
  });

  it('正常剥离: 斜体 `*斜体*`、`_强调_`、`foo *bar*`', () => {
    expect(stripMarkdown('*斜体*')).toBe('斜体');
    expect(stripMarkdown('_强调_')).toBe('强调');
    expect(stripMarkdown('foo *bar*')).toBe('foo bar');
  });

  it('正常剥离: 下划线数字开头 `_20%_` -> 20%（与既有契约一致）', () => {
    expect(stripMarkdown('_20%_')).toBe('20%');
  });

  it('正常剥离: 删除线 `~~删除线~~` -> 删除线', () => {
    expect(stripMarkdown('~~删除线~~')).toBe('删除线');
  });

  it('正常剥离: 确凿链接 `[官方文档](https://deepseek.com)` -> 官方文档 (https://deepseek.com)', () => {
    expect(stripMarkdown('[官方文档](https://deepseek.com)')).toBe(
      '官方文档 (https://deepseek.com)'
    );
  });

  it('正常剥离: 域名式链接 `[文档](deepseek.com/docs)` 也展开', () => {
    expect(stripMarkdown('[文档](deepseek.com/docs)')).toBe('文档 (deepseek.com/docs)');
  });

  it('正常剥离: 行内代码 `npm test`、引用块 `> 引用内容`', () => {
    expect(stripMarkdown('`npm test` 命令')).toBe('npm test 命令');
    expect(stripMarkdown('> 引用内容')).toBe('引用内容');
  });
});

describe('契约测试: stripMarkdown 综合回归与技术标签保护', () => {
  it('标题/粗斜体/代码/链接/表格/引用分割线 综合样例剥离正常', () => {
    const md = `### 系统运行报告
**状态**: 正常运行
*详情*: 当前 CPU 负载 _20%_
这是一个 \`npm test\` 命令。
[官方文档](https://deepseek.com)

\`\`\`bash
pnpm run build
pnpm test
\`\`\`

| 服务 | 状态 |
|---|---|
| Gateway | 在线 |
| Agent | 就绪 |
`;

    const plain = stripMarkdown(md);

    expect(plain).toContain('【系统运行报告】');
    expect(plain).toContain('状态: 正常运行');
    expect(plain).toContain('详情: 当前 CPU 负载 20%');
    expect(plain).not.toContain('**');
    expect(plain).not.toContain('`npm test`');
    expect(plain).toContain('npm test');
    expect(plain).not.toContain('```');
    expect(plain).toContain('pnpm run build');
    expect(plain).toContain('官方文档 (https://deepseek.com)');
    expect(plain).not.toContain('|---|---|');
    expect(plain).toContain('服务 | 状态');
    expect(plain).toContain('Gateway | 在线');
  });

  it('代码块中的 <think>...</think> 示例完整保留，不被误伤清空', () => {
    const input = '这是一个示例：\n```xml\n<think>\n示例内部推理\n</think>\n```';
    const plain = stripMarkdown(input);
    expect(plain).toContain('<think>');
    expect(plain).toContain('示例内部推理');
    expect(plain).toContain('</think>');
  });

  it('行内提及未闭合的 <think> 标签时，后续正文不被吞噬', () => {
    const input = 'Prompt 中你可以使用 `<think>` 标签作为思考标记，后续输出正式答复。';
    const plain = stripMarkdown(input);
    expect(plain).toContain('<think>');
    expect(plain).toContain('后续输出正式答复。');
  });
});

describe('契约测试: normalizeQqMarkdown 标题修补与代码块隔离', () => {
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

  it('清洗孤立代理项与 C0 控制字符，保留合法换行/制表符且不截断超长正文', () => {
    const longLine = '正文'.repeat(12000);
    const input = `#标题\u0000\t内容\uD800\n${longLine}`;
    const out = normalizeQqMarkdown(input);
    expect(out.startsWith('# 标题\t内容\uFFFD\n')).toBe(true);
    expect(out.endsWith(longLine)).toBe(true);
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
