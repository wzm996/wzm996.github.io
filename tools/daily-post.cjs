const fs = require('node:fs/promises');
const path = require('node:path');

function pad2(n) { return String(n).padStart(2, '0'); }

function formatDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDateTime(d) {
  // Hexo front-matter date; keep local time
  return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function slugify(s) {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5\-]/g, '')
    .replace(/-+/g, '-');
}

async function main() {
  const now = new Date();
  const dateStr = formatDate(now);
  const title = `每日一文：${dateStr}`;
  const slug = slugify(dateStr + '-daily');

  const rel = path.join('source', '_posts', `${dateStr}-${slug}.md`);
  const filePath = path.resolve(process.cwd(), rel);

  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // Avoid overwriting if already generated today
  try {
    await fs.access(filePath);
    console.error(`Post already exists: ${rel}`);
    process.exit(2);
  } catch {}

  const content = `---\n` +
    `title: ${title}\n` +
    `date: ${formatDateTime(now)}\n` +
    `tags:\n  - 日更\n` +
    `categories:\n  - Daily\n` +
    `---\n\n` +
    `这里是 ${dateStr} 的日更博文正文。\n\n` +
    `- 你可以在这里写：今天做了什么、学到了什么、链接收藏、思考总结等\n` +
    `- 后续我会按你指定的主题/风格自动生成更像“可发布”的内容\n`;

  await fs.writeFile(filePath, content, 'utf8');
  console.log(`Created ${rel}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
