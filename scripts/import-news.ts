/**
 * import-news.ts
 *
 * Imports every post in the "News" category of the legacy WordPress site into
 * the `announcements` content collection, so the new site's News page shows the
 * same headlines, thumbnails, dates, and excerpts — with each headline linking
 * to the full article.
 *
 * Source: the WordPress REST API (public, no auth). For each post we pull the
 * title, permalink, publish date, excerpt, and featured image. Images are
 * downloaded into public/assets/img/news/ so the site stays self-contained.
 *
 * Usage:
 *   yarn news:import
 *
 * Re-running is safe: the announcements directory and the news image directory
 * are wiped and regenerated from scratch each run.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';

// ─── Config ───────────────────────────────────────────────────────────────────

const WP_BASE = 'https://engineering.purdue.edu/cdesign/wp';
const NEWS_CATEGORY_ID = 25;
const PER_PAGE = 50;
/** A browser UA — the WordPress WAF blocks large default-agent requests. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** Thumbnails are downscaled to this max width — the list only needs small previews. */
const THUMB_WIDTH = 600;

const root = process.cwd();
const announcementsDir = join(root, 'src/content/announcements');
const imageDir = join(root, 'public/assets/img/news');

// ─── Types ────────────────────────────────────────────────────────────────────

interface WpPost {
  date: string;
  slug: string;
  link: string;
  title: { rendered: string };
  excerpt: { rendered: string };
  _embedded?: {
    'wp:featuredmedia'?: Array<{ source_url?: string; alt_text?: string }>;
  };
}

// ─── HTML helpers ───────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  ndash: '–',
  mdash: '—',
};

function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/** Strip tags, decode entities, drop trailing "[…]"/"Read More", collapse whitespace. */
function cleanText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\[[…\.]+\]\s*$/u, '')
    .replace(/\bContinue reading.*$/i, '')
    .replace(/\bRead More.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Escape a value for safe single-quoted YAML. */
function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchAllPosts(): Promise<WpPost[]> {
  const posts: WpPost[] = [];
  for (let page = 1; ; page++) {
    const url = `${WP_BASE}/wp-json/wp/v2/posts?categories=${NEWS_CATEGORY_ID}&per_page=${PER_PAGE}&page=${page}&_embed=1`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.status === 400) break; // WP returns 400 once you page past the end
    if (!res.ok) throw new Error(`Fetch failed (page ${page}): HTTP ${res.status}`);
    const batch = (await res.json()) as WpPost[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    posts.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return posts;
}

/** Fetch an image, downscale it to a thumbnail, and write it as JPEG. */
async function downloadThumbnail(url: string, dest: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    await sharp(buf)
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toFile(dest);
    return true;
  } catch {
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching News posts from WordPress…');
  const posts = await fetchAllPosts();
  console.log(`Fetched ${posts.length} posts.`);

  // Wipe and recreate output dirs so re-runs don't leave stale files.
  for (const dir of [announcementsDir, imageDir]) {
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
    } else {
      mkdirSync(dir, { recursive: true });
    }
  }

  let imagesOk = 0;
  const usedNames = new Set<string>();

  for (const post of posts) {
    const isoDate = post.date.slice(0, 10); // YYYY-MM-DD
    const title = decodeEntities(post.title.rendered).trim();
    const excerpt = cleanText(post.excerpt.rendered);

    // Filename: date + trimmed slug, de-duplicated.
    const shortSlug = post.slug.replace(/[^a-z0-9-]/gi, '').slice(0, 50);
    let base = `${isoDate}-${shortSlug}`;
    while (usedNames.has(base)) base += '-x';
    usedNames.add(base);

    // Featured image → local file.
    let imageField = '';
    const mediaUrl = post._embedded?.['wp:featuredmedia']?.[0]?.source_url;
    const alt = post._embedded?.['wp:featuredmedia']?.[0]?.alt_text ?? '';
    if (mediaUrl) {
      const imgName = `${base}.jpg`;
      if (await downloadThumbnail(mediaUrl, join(imageDir, imgName))) {
        imageField = imgName;
        imagesOk++;
      }
    }

    // Build frontmatter.
    const fm = [`date: ${isoDate}`, `title: ${yamlQuote(title)}`, `link: ${yamlQuote(post.link)}`];
    if (imageField) fm.push(`image: ${yamlQuote(imageField)}`);
    if (alt) fm.push(`alt: ${yamlQuote(decodeEntities(alt).trim())}`);
    if (excerpt) fm.push(`excerpt: ${yamlQuote(excerpt)}`);

    writeFileSync(join(announcementsDir, `${base}.md`), `---\n${fm.join('\n')}\n---\n`);
  }

  console.log(`Wrote ${posts.length} announcement files.`);
  console.log(`Downloaded ${imagesOk}/${posts.length} images to public/assets/img/news/.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
