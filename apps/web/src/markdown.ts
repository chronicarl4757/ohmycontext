// Minimal hand-rolled markdown renderer. Escape FIRST, then transform:
// no raw HTML can ever pass through.

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(text: string): string {
  let out = text;
  // inline code first so nothing inside it is re-processed
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => `<code class="md-inline">${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // safe links only: http(s)
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  return out;
}

export function renderMarkdown(src: string): string {
  const escaped = esc(src);
  const fenceRe = /```(\w*)\n([\s\S]*?)(?:\n?```|$)/g;
  const chunks: { code: boolean; text: string }[] = [];
  let last = 0;
  for (let m = fenceRe.exec(escaped); m; m = fenceRe.exec(escaped)) {
    if (m.index > last) chunks.push({ code: false, text: escaped.slice(last, m.index) });
    chunks.push({ code: true, text: m[2] ?? '' });
    last = m.index + m[0].length;
  }
  if (last < escaped.length) chunks.push({ code: false, text: escaped.slice(last) });

  const html = chunks
    .map((chunk) => {
      if (chunk.code) return `<pre class="md-code"><code>${chunk.text.replace(/\n$/, '')}</code></pre>`;
      return renderBlocks(chunk.text);
    })
    .join('');
  return html;
}

function renderBlocks(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;
  let quote: string[] | null = null;

  const flushList = () => {
    if (!list) return;
    out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote) return;
    out.push(`<blockquote class="md-quote">${quote.map(inline).join('<br />')}</blockquote>`);
    quote = null;
  };

  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      flushQuote();
      out.push(`<div class="md-h">${inline(heading[2] ?? '')}</div>`);
      continue;
    }
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line) && line.trim().length > 0) {
      flushList();
      flushQuote();
      out.push('<hr class="md-hr" />');
      continue;
    }
    const quoteLine = /^>\s?(.*)$/.exec(line);
    if (quoteLine) {
      flushList();
      quote = quote ?? [];
      quote.push(quoteLine[1] ?? '');
      continue;
    }
    flushQuote();
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const type = ul ? 'ul' : 'ol';
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((ul ?? ol)![1] ?? '');
      continue;
    }
    flushList();
    if (line.trim().length > 0) {
      out.push(`<p class="md-p">${inline(line)}</p>`);
    }
  }
  flushList();
  flushQuote();
  return out.join('');
}
