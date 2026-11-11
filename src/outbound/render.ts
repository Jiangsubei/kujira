/**
 * kujira: 出站文本渲染与 UTF-8 字节安全分片模块
 *
 * 1. `normalizeQqMarkdown`: 为原生 Markdown (`msg_type=2`) 修补行首无空格 `#标题` -> `# 标题`
 *    （严格跳过围栏代码块内部），并做合法 UTF-16 与控制字符净化，绝不截断；
 * 2. `splitByUtf8Bytes`: 严格按 UTF-8 字节上限切分（换行 -> 空格 -> 码点边界），
 *    绝不从多字节字符或 UTF-16 代理对中间切断、绝不静默丢字。
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
