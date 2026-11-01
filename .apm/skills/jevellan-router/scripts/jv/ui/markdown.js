// A small, safe Markdown renderer for report summaries and assistant text (jv ui, section 10).
//
// Safety: every piece of the source is HTML-escaped before it reaches the output; the only tags in the output are
// the ones built here, and the only attribute that carries source text is a link's href, which must be http(s), a
// path on this site or an anchor, and is escaped too. Raw HTML in the source is shown as text. Images are rendered
// as links (the viewer loads no outside images).
//
// Supported: paragraphs (single newlines kept as line breaks), # headings (shown two levels smaller), fenced code,
// inline code, **bold**, *italic*, ~~strike~~, [links](https://...), bare https:// links, - and 1. lists (nested by
// indentation), > quotes, --- rules and pipe tables.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function safeHref(url) {
  const u = url.trim();
  if (/^https?:\/\/[^\s]+$/i.test(u)) return u;
  if (/^\/(?!\/)[^\s]*$/.test(u)) return u;
  if (/^#[\w-]*$/.test(u)) return u;
  return undefined;
}

function link(text, url) {
  const href = safeHref(url);
  if (!href) return text;
  const external = /^https?:/i.test(href);
  return `<a href="${escapeHtml(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
}

function emphasis(escaped) {
  return escaped
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_(?=[^\s_])([^_]*?[^\s_])_(?![\w_])/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
}

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|!?\[([^\]\n]+)\]\(([^()\s]+(?:\([^()\s]*\)[^()\s]*)*)(?:\s+"[^"\n]*")?\)|(https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]])/g;

/** One line or paragraph of inline Markdown, as safe HTML. */
export function renderInline(text) {
  const src = String(text ?? '');
  let out = '';
  let last = 0;
  for (const m of src.matchAll(INLINE)) {
    out += emphasis(escapeHtml(src.slice(last, m.index)));
    if (m[1] !== undefined) out += `<code>${escapeHtml(m[2].replace(/^ (.*) $/s, '$1'))}</code>`;
    else if (m[3] !== undefined) out += link(emphasis(escapeHtml(m[3])), m[4]);
    else out += link(escapeHtml(m[5]), m[5]);
    last = m.index + m[0].length;
  }
  return out + emphasis(escapeHtml(src.slice(last)));
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function cells(line) {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
  return l.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function startsBlock(line, next) {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    ITEM.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-'))
  );
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function renderList(lines, start) {
  const first = ITEM.exec(lines[start]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const m = ITEM.exec(line);
    if (m && m[1].length === base && /\d/.test(m[2]) === ordered) {
      items.push([m[3]]);
      i++;
      continue;
    }
    if (line.trim() === '') {
      // A blank line ends the list unless the next line continues it (indented, or another item).
      const next = lines[i + 1];
      const nextItem = next === undefined ? null : ITEM.exec(next);
      const sameList = nextItem !== null && nextItem[1].length === base && /\d/.test(nextItem[2]) === ordered;
      if (next !== undefined && next.trim() !== '' && (indentOf(next) > base || sameList)) {
        items.at(-1).push('');
        i++;
        continue;
      }
      break;
    }
    if (indentOf(line) > base && items.length) {
      items.at(-1).push(line.slice(Math.min(indentOf(line), base + 2)));
      i++;
      continue;
    }
    break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && Number.parseInt(first[2], 10) !== 1 ? ` start="${Number.parseInt(first[2], 10)}"` : '';
  const body = items
    .map((all) => {
      const parts = [...all];
      while (parts.length > 1 && parts.at(-1).trim() === '') parts.pop();
      const nested = parts.slice(1).some((p) => ITEM.test(p) || p.trim() === '' || FENCE.test(p));
      if (parts.length === 1 || !nested) return `<li>${renderInline(parts.join('\n')).replace(/\n/g, '<br>')}</li>`;
      return `<li>${renderBlocks(parts, true)}</li>`;
    })
    .join('');
  return { html: `<${tag}${startAttr}>${body}</${tag}>`, next: i };
}

function renderBlocks(lines, tight) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length + 2);
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])[1]);
      out.push(`<blockquote>${renderBlocks(inner, false)}</blockquote>`);
      continue;
    }
    if (ITEM.test(line)) {
      const list = renderList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }
    const next = lines[i + 1];
    if (line.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-')) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') rows.push(cells(lines[i++]));
      const th = head.map((c) => `<th>${renderInline(c)}</th>`).join('');
      const tb = rows.map((r) => `<tr>${head.map((_, k) => `<td>${renderInline(r[k] ?? '')}</td>`).join('')}</tr>`).join('');
      out.push(`<div class="md-table"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
      continue;
    }
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++]);
    const text = renderInline(para.map((l) => l.trim()).join('\n')).replace(/\n/g, '<br>');
    out.push(tight && out.length === 0 ? text : `<p>${text}</p>`);
  }
  return out.join('');
}

/** Markdown source to safe HTML. */
export function renderMarkdown(source) {
  const text = String(source ?? '').replace(/\0/g, '').replace(/\r\n?/g, '\n');
  return renderBlocks(text.split('\n'), false);
}
