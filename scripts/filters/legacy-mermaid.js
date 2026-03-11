'use strict';

// Convert legacy exported HTML mermaid blocks into NexT v8 compatible structure at build time.
// Legacy posts contain Mermaid diagrams as highlighted plaintext blocks:
//   <figure class="highlight plain"> ... <td class="code"><pre>graph LR ...</pre>
// NexT v8 expects:
//   <pre><code class="mermaid">...</code></pre>

const DIAGRAM_RE = /^\s*(sequenceDiagram|graph\s+LR|graph\s+TD|graph\s+TB|graph\s+BT|gantt|classDiagram|stateDiagram|erDiagram|journey|pie)\b/m;

function decodeHtml(s) {
  return (s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripLineNumbersAndTags(preHtml) {
  // Convert <span class="line">...</span><br> into plain text with newlines
  let s = preHtml || '';
  s = s.replace(/<span class="line">/g, '');
  s = s.replace(/<\/span>/g, '');
  // Convert HTML line breaks (br, br/, br /) to newlines
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = decodeHtml(s);
  // Remove line numbers that appear as standalone lines (1..n)
  s = s.replace(/^\s*\d+\s*$/gm, '');
  // Also remove leading number + space at start of line
  s = s.replace(/^\s*\d+\s+/gm, '');
  return s.trim();
}

hexo.extend.filter.register('after_render:html', function(str) {
  if (!str || typeof str !== 'string') return str;

  // Fast path
  if (str.indexOf('figure class="highlight plain"') === -1) return str;

  // Match entire <figure class="highlight plain">...</figure>
  const FIG_RE = /<figure class="highlight plain">[\s\S]*?<td class="code"><pre>([\s\S]*?)<\/pre>[\s\S]*?<\/figure>/g;

  return str.replace(FIG_RE, (raw, preInner) => {
    const txt = stripLineNumbersAndTags(preInner);
    if (!txt || !DIAGRAM_RE.test(txt)) return raw;

    // Escape back into HTML
    const escaped = txt
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    return `<pre><code class="mermaid">${escaped}</code></pre>`;
  });
}, 20);
