const fs = require('node:fs/promises');

async function main() {
  const required = ['_config.yml', 'package.json', 'source/_posts'];
  for (const p of required) {
    try {
      await fs.access(p);
    } catch {
      console.error(`Missing: ${p}`);
      process.exit(1);
    }
  }
  console.log('OK');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
