/**
 * kujira: 出站文本渲染与 UTF-8 字节安全分片模块
 *
 * 1. `normalizeQqMarkdown`: 为原生 Markdown (`msg_type=2`) 修补行首无空格 `#标题` -> `# 标题`
 *    （严格跳过围栏代码块内部），并做合法 UTF-16 与控制字符净化，绝不截断；
 * 2. `splitByUtf8Bytes`: 严格按 UTF-8 字节上限切分（换行 -> 空格 -> 码点边界），
 *    绝不从多字节字符或 UTF-16 代理对中间切断、绝不静默丢字；
 * 3. `stripMarkdown`: 当 `markdown_enabled: false` 时降级为整洁纯文本排版。
 */

/** 把孤立代理项替换为 U+FFFD，保证输出是合法 UTF-16 */
function toWellFormedText(text: string): string {
  return text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
    .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, '$1\uFFFD');
}

/** 剔除 NUL 等 C0 控制字符（保留 `\n` `\r` `\t`） */
function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/**
 * 规范化 QQ 官方 Bot 单聊 Markdown (`msg_type=2`)：
 * - 将代码块外的行首无空格标题 `#标题` 补齐为空格写法 `# 标题`（支持 1~6 级 `#`）；
 * - 围栏代码块（``` 或 ~~~）内部原样保留，不误伤 `#define` / `#注释` 等代码行；
 * - 修复孤立 UTF-16 代理项并剔除 C0 控制字符，不做截断。
 */
export function normalizeQqMarkdown(md: string): string {
  if (!md || typeof md !== 'string') {
    return '';
  }

  const sanitized = stripControlChars(toWellFormedText(md));
  const lines = sanitized.match(/[^\n]*\n|[^\n]+$/g) ?? [sanitized];
  const out: string[] = [];

  let fenceChar: '`' | '~' | null = null;
  let fenceLen = 0;

  for (const rawLine of lines) {
    const hasNewline = rawLine.endsWith('\n');
    const withoutNewline = hasNewline ? rawLine.slice(0, -1) : rawLine;
    const hasCr = withoutNewline.endsWith('\r');
    const lineBody = hasCr ? withoutNewline.slice(0, -1) : withoutNewline;
    const lineEnding = (hasCr ? '\r' : '') + (hasNewline ? '\n' : '');

    if (fenceChar === null) {
      const openMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lineBody);
      if (openMatch) {
        const marker = openMatch[1]!;
        const rest = openMatch[2] ?? '';
        const ch = marker[0] as '`' | '~';
        // CommonMark 规则：反引号围栏的 info string 不能包含反引号（避免误判单行 ```code```）
        if (!(ch === '`' && rest.includes('`'))) {
          fenceChar = ch;
          fenceLen = marker.length;
          out.push(rawLine);
          continue;
        }
      }
      const normalized = lineBody.replace(/^(#{1,6})([^\s#\r\n])/, '$1 $2');
      out.push(normalized + lineEnding);
    } else {
      const closeRe = new RegExp(`^ {0,3}${fenceChar}{${fenceLen},}[ \\t]*$`);
      if (closeRe.test(lineBody)) {
        fenceChar = null;
        fenceLen = 0;
      }
      out.push(rawLine);
    }
  }

  return out.join('');
}

/**
 * 严格按 UTF-8 字节上限切分文本：
 * - 优先在换行边界打包整行；
 * - 单行超出上限时，优先在空格/Tab 词边界切分；
 * - 单个连续词元仍超出上限时，按 Unicode 码点边界切分（绝不从多字节字符或 UTF-16 代理对中间切断）；
 * - 若单码点字节数本身超过 maxBytes，仍保证每片至少推进 1 个完整码点；
 * - `parts.join('') === text` 恒成立，绝不静默截断丢字。
 */
export function splitByUtf8Bytes(text: string, maxBytes: number): string[] {
  if (!text) return [];
  const limit = Number.isFinite(maxBytes) && maxBytes >= 1 ? Math.floor(maxBytes) : 1;
  const parts: string[] = [];
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [text];

  let buf = '';
  let bufBytes = 0;

  const flush = (): void => {
    if (buf) {
      parts.push(buf);
      buf = '';
      bufBytes = 0;
    }
  };

  const splitLongLine = (line: string): void => {
    const tokens = line.match(/[^ \t]*[ \t]+|[^ \t]+$/g) ?? [line];
    let cur = buf;
    let curBytes = bufBytes;
    buf = '';
    bufBytes = 0;

    for (const token of tokens) {
      const tokenBytes = Buffer.byteLength(token, 'utf8');
      if (tokenBytes > limit) {
        for (const ch of token) {
          const chBytes = Buffer.byteLength(ch, 'utf8');
          if (curBytes + chBytes > limit && curBytes > 0) {
            parts.push(cur);
            cur = '';
            curBytes = 0;
          }
          cur += ch;
          curBytes += chBytes;
        }
        continue;
      }

      if (curBytes + tokenBytes > limit && curBytes > 0) {
        parts.push(cur);
        cur = '';
        curBytes = 0;
      }
      cur += token;
      curBytes += tokenBytes;
    }

    buf = cur;
    bufBytes = curBytes;
  };

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (lineBytes > limit) {
      splitLongLine(line);
      continue;
    }
    if (bufBytes + lineBytes > limit) {
      flush();
    }
    buf += line;
    bufBytes += lineBytes;
  }

  flush();
  return parts;
}

/**
 * 判断字符串是否"确凿地"像一个 URL（用于链接剥离前甄别，避免误伤字面文本）。
 * 识别：scheme://、scheme: 协议、www. 前缀、以及带顶级域的域名（可含端口/路径）。
 */
function looksLikeUrl(value: string): boolean {
  return (
    /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s)]*$/i.test(value) ||
    /^[a-z][a-z0-9+.-]*:[^\s)]*$/i.test(value) ||
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s)]*)?$/i.test(
      value
    )
  );
}

/**
 * 剥离 Markdown 格式符号，转换为适合 QQ 客户端阅读的整洁纯文本排版（用于 `markdown_enabled: false` 降级）。
 *
 * 误伤防护（宁可少剥不可误伤）：
 * - 斜体/粗体的 `*`/`_` 强调符号两侧须紧贴非空白、非数字文字（`3 * 4`、`2 * 3` 不受影响）；
 * - `*`/`_` 不在单词/标识符内部开强调（`a_b_c`、`read_memory`、`foo_bar_baz` 不受影响）；
 * - `#` 仅当行首且后跟空白才算标题（`C#` 不受影响）；
 * - `[text](url)` 仅当 url 确凿为 URL 才展开（字面 `[标题](url)` 文本不受影响）；
 * - 无闭合的孤立符号（如列表项 `* foo`、`*单独行`）原样保留。
 */
export function stripMarkdown(markdown: string): string {
  if (!markdown || typeof markdown !== 'string') {
    return '';
  }

  let text = markdown;

  // 1. 处理多行代码块 ```lang ... ```
  text = text.replace(/```[^\n]*\r?\n([\s\S]*?)```/g, (_match, code) => {
    return code;
  });
  // 清理任何残留的反引号围栏
  text = text.replace(/```[^\n]*/g, '');

  // 2. 处理行内代码 `code`
  text = text.replace(/`([^`\r\n]+)`/g, '$1');
  text = text.replace(/`/g, '');

  // 3. 处理标题 #+ Title -> 【Title】；仅行首且 # 后紧跟空白，避免误伤 C#/#tag
  text = text.replace(/^(\s*)#{1,6}[ \t]+(.+?)(?:\s+#+)?$/gm, '$1【$2】');

  // 4. 处理图片链接 ![alt](url) -> [图片: url]
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '[图片: $2]');

  // 5. 处理超链接 [text](url) -> text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, label, url) => {
    return looksLikeUrl(url) ? `${label} (${url})` : whole;
  });

  // 6. 处理粗体与斜体（两侧约束：非空白、非数字、不跨单词字符，宁可少剥不可误伤）
  text = text.replace(/(?<!\w)\*\*\*(?![\s\d])([^*\n]+?)(?<![\s\d])\*\*\*(?!\w)/g, '$1');
  text = text.replace(/(?<!\w)___(?!\s)([^_\n]+?)(?<!\s)___(?!\w)/g, '$1');
  text = text.replace(/(?<!\w)\*\*(?![\s\d])([^*\n]+?)(?<![\s\d])\*\*(?!\w)/g, '$1');
  text = text.replace(/(?<!\w)__(?!\s)([^_\n]+?)(?<!\s)__(?!\w)/g, '$1');
  text = text.replace(/(?<!\w)\*(?![\s\d])([^*\n]+?)(?<![\s\d])\*(?!\w)/g, '$1');
  text = text.replace(/(?<!\w)_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, '$1');

  // 7. 处理删除线 ~~text~~ -> text
  text = text.replace(/(?<!\s)~~(?!\s)([^~\n]+?)(?<!\s)~~(?!\s)/g, '$1');

  // 8. 处理表格（仅用 [ \t]，避免 \s 吞换行造成表格行粘连）
  text = text.replace(/^[ \t]*\|?([ \t]*:?-+:?[ \t]*\|)+[ \t]*(:?-+:?[ \t]*)?\|?[ \t]*$/gm, '');
  text = text.replace(/^[ \t]*\|[ \t]*(.*?)[ \t]*\|[ \t]*$/gm, (_match, rowContent) => {
    const cells = rowContent
      .split('|')
      .map((c: string) => c.trim())
      .filter((c: string) => c.length > 0);
    return cells.join(' | ');
  });

  // 9. 处理引用块 > text -> text
  text = text.replace(/^(\s*)>[ \t]/gm, '$1');

  // 10. 去除行尾多余空白，收缩多余空行
  text = text.replace(/[ \t]+$/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}
