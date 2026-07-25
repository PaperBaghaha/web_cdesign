/**
 * new-news.ts
 *
 * Creates ONE new news item (announcement) with the correct filename and
 * frontmatter, so you never have to remember the format. The post shows up at
 * /news/ and /news/<slug>/ after you rebuild/redeploy.
 *
 * Usage:
 *   yarn news:new                       # interactive — it asks for the headline
 *   yarn news:new "Prof. Ramani wins award"   # headline passed directly
 *
 * After it runs:
 *   1. Open the file it created (path is printed) and type the article text
 *      under the "---" line.
 *   2. (Optional) Drop a photo into public/assets/img/news/ and put its
 *      filename in the "image:" line.
 *   3. Save, commit, and push — the news item then appears on the site.
 *
 * NOTE: Do NOT run `yarn news:import` after this — that command re-downloads the
 * old WordPress archive and wipes this folder. It's a one-time migration only.
 */

import { createInterface } from 'node:readline/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const announcementsDir = join(process.cwd(), 'src/content/announcements');

/** Escape a value for safe single-quoted YAML. */
function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Turn a headline into a URL-friendly slug. */
function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'news'
  );
}

async function main() {
  // Headline comes from the command line, or we ask for it interactively.
  let title = process.argv.slice(2).join(' ').trim();
  if (!title) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    title = (await rl.question('News headline: ')).trim();
    rl.close();
  }
  if (!title) {
    console.error('No headline given — nothing created.');
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const slug = slugify(title);
  let base = `${today}-${slug}`;
  // Avoid clobbering an existing file with the same headline on the same day.
  let n = 2;
  while (existsSync(join(announcementsDir, `${base}.md`))) {
    base = `${today}-${slug}-${n++}`;
  }
  const filePath = join(announcementsDir, `${base}.md`);

  const contents = `---
date: ${today}
title: ${yamlQuote(title)}
slug: ${yamlQuote(slug)}
# Optional — a photo for this news item.
# Put the image file in  public/assets/img/news/  then write its name here:
# image: 'my-photo.jpg'
# alt: 'Short description of the photo'
# Optional — a one-line summary shown under the headline on the news list:
# excerpt: 'A short summary of what happened.'
# Optional — a link to the original article or press release:
# source: 'https://example.com/the-original-article'
---

Write the news article here. You can use normal text and paragraphs.

Leave a blank line between paragraphs, like this, and it will look right on
the site.
`;

  writeFileSync(filePath, contents);

  console.log('\n✅ Created a new news item:\n');
  console.log(`   ${filePath}\n`);
  console.log('Next steps:');
  console.log('  1. Open that file and type the article text under the "---" line.');
  console.log('  2. (Optional) Add a photo to public/assets/img/news/ and set the "image:" line.');
  console.log('  3. Save, then commit & push — it will appear on the /news/ page.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
