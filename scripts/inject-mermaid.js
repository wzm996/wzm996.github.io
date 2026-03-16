/* global hexo */

// Inject Mermaid runtime into rendered HTML pages.
// Why: our content uses <pre class="mermaid">...</pre> blocks (hexo-filter-mermaid-diagrams),
// but NexT 5.x does not automatically include mermaid.min.js.
// Without this runtime, diagrams will show as plain text.

hexo.extend.filter.register('after_render:html', function (str) {
  if (!str || typeof str !== 'string') return str;

  // Quick skip: no mermaid blocks
  if (str.indexOf('class="mermaid"') === -1 && str.indexOf('class=\"mermaid\"') === -1) return str;

  // Avoid double-injection
  if (str.includes('mermaid.min.js') || str.includes('mermaid.initialize') || str.includes('mermaid.run')) return str;

  const idx = str.lastIndexOf('</body>');
  if (idx === -1) return str;

  const snippet = `\
<script src="https://unpkg.com/mermaid@11/dist/mermaid.min.js"></script>\
<script>\
  (function () {\
    if (!window.mermaid) return;\
    try {\
      window.mermaid.initialize({ startOnLoad: false });\
      // Render both <pre class="mermaid"> and <div class="mermaid"> blocks\
      window.mermaid.run({ querySelector: '.mermaid' });\
    } catch (e) {\
      // swallow\
    }\
  })();\
</script>`;

  return str.slice(0, idx) + '\n\n  ' + snippet + '\n\n' + str.slice(idx);
});
