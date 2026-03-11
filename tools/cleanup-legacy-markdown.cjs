const fs = require('node:fs');
const fsp = require('node:fs/promises');

function fixMermaidAndFlow(text) {
  // Convert "12345graph LR..." style into fenced mermaid block
  text = text.replace(/\n\s*\d+\s*(graph\s+LR[\s\S]*?)(?=\n\n|\n#|\n##|\n```|$)/g, (m, body) => {
    body = body.trim();
    return `\n\n\`\`\`mermaid\n${body}\n\`\`\`\n`;
  });
  text = text.replace(/\n\s*\d+\s*(sequenceDiagram[\s\S]*?)(?=\n\n|\n#|\n##|\n```|$)/g, (m, body) => {
    body = body.trim();
    // ensure newlines between statements
    body = body.replace(/\s{2,}/g, ' ');
    body = body.replace(/(sequenceDiagram)\s+/,'$1\n');
    body = body.replace(/\s*(->>|-->>|->|-->|=>)\s*/g, (s)=>s.trim());
    body = body.replace(/\s{2,}/g,' ');
    // attempt to add newlines before arrows patterns if missing
    body = body.replace(/(\S)(\w+->>)/g,'$1\n$2');
    return `\n\n\`\`\`mermaid\n${body}\n\`\`\`\n`;
  });

  // Convert long inline code-like C blocks starting with many digits into fenced code
  text = text.replace(/\n\s*\d{6,}\s*([\s\S]*?)(?=\n\n|\n#|\n##|$)/g, (m, body) => {
    body = body.trim();
    // If it already contains many semicolons/braces, treat as code
    if (/[;{}]/.test(body)) {
      // add some newlines heuristically after ';' and '{' and '}'
      const pretty = body
        .replace(/\{/g, '{\n')
        .replace(/\}/g, '\n}\n')
        .replace(/;/g, ';\n')
        .replace(/\n{3,}/g,'\n\n')
        .trim();
      return `\n\n\`\`\`c\n${pretty}\n\`\`\`\n`;
    }
    return `\n\n${body}\n`;
  });

  // Fix lists that got blank lines between bullets
  text = text.replace(/\n- ([^\n]+)\n\n- /g, '\n- $1\n- ');

  // Convert simple table-like blocks into markdown tables (very conservative)
  // Example in data-structure post: '术语\n阶\n举例\n\n常数阶\nO(1)\n...'
  // Skip for now; better to preserve as list.

  // Remove trailing extra spaces
  text = text.replace(/[ \t]+\n/g, '\n');
  return text;
}

async function main() {
  const files = fs.readdirSync('source/_posts').filter(f => f.endsWith('.md') && f.startsWith('2018-'));
  for (const f of files) {
    const p = `source/_posts/${f}`;
    let t = await fsp.readFile(p, 'utf8');
    const before = t;

    // Ensure a blank line after front-matter
    t = t.replace(/---\n([\s\S]*?)\n---\n(?!\n)/, (m, fm) => `---\n${fm}\n---\n\n`);

    t = fixMermaidAndFlow(t);

    // Ensure headings separated
    t = t.replace(/\n(#|##|###)/g, '\n\n$1');
    t = t.replace(/\n{3,}/g,'\n\n');

    if (t !== before) {
      await fsp.writeFile(p, t, 'utf8');
      console.log('fixed', p);
    }
  }
}

main().catch(e=>{console.error(e);process.exit(1);});
