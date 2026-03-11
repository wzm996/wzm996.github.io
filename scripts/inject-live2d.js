/* global hexo */

// Inject 2018/2019 Live2D "little cat" widget (tororo) into all rendered HTML.
// This avoids relying on NexT theme template hooks.

const SNIPPET = `\
<script src="/live2dw/lib/L2Dwidget.min.js"></script>\
<script>\
  if (typeof L2Dwidget !== 'undefined') {\
    L2Dwidget.init({\
      model: { jsonPath: '/live2dw/assets/tororo.model.json' },\
      display: { position: 'right', width: 150, height: 300 },\
      mobile: { show: true },\
      log: false,\
      pluginJsPath: 'lib/',\
      pluginModelPath: 'assets/',\
      pluginRootPath: 'live2dw/',\
      tagMode: false\
    });\
  }\
</script>`;

hexo.extend.filter.register('after_render:html', function (str, data) {
  // Skip non-HTML or already-injected pages
  if (!str || typeof str !== 'string') return str;
  if (str.includes('L2Dwidget.min.js') || str.includes('L2Dwidget.init')) return str;

  // Only inject into full HTML documents
  const idx = str.lastIndexOf('</body>');
  if (idx === -1) return str;

  return str.slice(0, idx) + '\n\n  ' + SNIPPET + '\n\n' + str.slice(idx);
});
