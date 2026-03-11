const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function extractTitle(html) {
  const m = html.match(/<h1 class="post-title"[^>]*>([\s\S]*?)<\/h1>/);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, '').trim();
}

function extractDateTime(html) {
  const m = html.match(/<time[^>]+datetime="([^"]+)"/);
  return m ? m[1] : null;
}

function extractBodyHtml(html) {
  const start = html.indexOf('<div class="post-body"');
  if (start < 0) return null;
  const end = html.indexOf('<footer class="post-footer"', start);
  if (end < 0) return null;
  const innerStart = html.indexOf('>', start) + 1;
  return html.slice(innerStart, end);
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function htmlToMd(html) {
  let out = html;

  // Replace code blocks first (keep content)
  out = out.replace(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g, (_, code) => {
    code = decodeEntities(code);
    // Remove leading/trailing newlines
    code = code.replace(/^\n+|\n+$/g, '');
    return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
  });

  // Headings
  out = out.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/g, (_, t) => `\n# ${t.replace(/<[^>]+>/g, '').trim()}\n`);
  out = out.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/g, (_, t) => `\n## ${t.replace(/<[^>]+>/g, '').trim()}\n`);
  out = out.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/g, (_, t) => `\n### ${t.replace(/<[^>]+>/g, '').trim()}\n`);

  // HR
  out = out.replace(/<hr\s*\/?>(\s*)/g, '\n---\n');

  // Blockquotes (simple)
  out = out.replace(/<blockquote>/g, '\n> ');
  out = out.replace(/<\/blockquote>/g, '\n');

  // Lists
  out = out.replace(/<li>([\s\S]*?)<\/li>/g, (_, t) => `\n- ${t.replace(/<[^>]+>/g, '').trim()}`);

  // Paragraphs
  out = out.replace(/<p>([\s\S]*?)<\/p>/g, (_, t) => `\n${t.replace(/<[^>]+>/g, '').trim()}\n`);

  // Basic formatting
  out = out.replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**');
  out = out.replace(/<em>([\s\S]*?)<\/em>/g, '*$1*');
  out = out.replace(/<a[^>]*>([\s\S]*?)<\/a>/g, (_, t) => t);

  // Strip remaining tags
  out = out.replace(/<[^>]+>/g, '');

  out = decodeEntities(out);

  // Cleanup
  out = out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return out;
}

function slugFromDateTitle(dateStr, title) {
  // minimal slug; keep chinese, alnum, dash
  const safeTitle = title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5\-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, 80);
  return `${dateStr}-${safeTitle || 'post'}`;
}

async function main() {
  const keep = [
    'legacy/2018/10/08/数据结构（一）——算法的时间和空间复杂度/index.html',
    'legacy/2018/10/22/初识代理服务器和常用的代理技术/index.html',
    'legacy/2018/11/06/数据结构（二）——线性表和线性表的顺序存储结构/index.html'
  ];

  const outDir = path.join('source', '_posts');
  await fsp.mkdir(outDir, { recursive: true });

  for (const file of keep) {
    const html = await fsp.readFile(file, 'utf8');
    const title = extractTitle(html);
    const dt = extractDateTime(html);
    const bodyHtml = extractBodyHtml(html);
    if (!title || !dt || !bodyHtml) {
      throw new Error(`Failed to parse ${file}`);
    }

    const date = dt.replace('T', ' ').replace(/\+08:00$/, '');
    const dateStr = dt.slice(0, 10);
    const slug = slugFromDateTitle(dateStr, title);
    const mdPath = path.join(outDir, `${slug}.md`);

    const mdBody = htmlToMd(bodyHtml);

    const fm = [
      '---',
      `title: ${title}`,
      `date: ${date}`,
      'tags:',
      '  - 旧文',
      'categories:',
      '  - Archive',
      '---',
      ''
    ].join('\n');

    await fsp.writeFile(mdPath, fm + mdBody, 'utf8');
    console.log('Imported', mdPath);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
