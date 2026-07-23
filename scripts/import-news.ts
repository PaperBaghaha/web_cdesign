/**
 * import-news.ts
 *
 * Imports every post in the "News" category of the legacy WordPress site into
 * the `announcements` content collection, so the new site hosts the full news
 * archive itself — headline, thumbnail, date, excerpt, AND the full article body
 * (with its inline images) on a self-contained /news/<slug>/ page.
 *
 * Source: the WordPress REST API (public, no auth). All images — the featured
 * thumbnail and every image inside the article body — are downloaded into
 * public/assets/img/news/ so nothing loads from the old site at runtime.
 *
 * Usage:
 *   yarn news:import
 *
 * Re-running is safe: the announcements directory and the news image directory
 * are wiped and regenerated from scratch each run.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import sharp from 'sharp';

// ─── Config ───────────────────────────────────────────────────────────────────

const WP_BASE = 'https://engineering.purdue.edu/cdesign/wp';
const NEWS_CATEGORY_ID = 25;
const PER_PAGE = 50;
/** A browser UA — the WordPress WAF blocks large default-agent requests. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** Featured thumbnails are downscaled to this max width (list previews). */
const THUMB_WIDTH = 600;
/** Inline article images are downscaled to this max width (content column). */
const CONTENT_WIDTH = 900;

const root = process.cwd();
const announcementsDir = join(root, 'src/content/announcements');
const imageDir = join(root, 'public/assets/img/news');
const contentImageDir = join(imageDir, 'content');
/** Public URL prefix for downloaded inline images. */
const CONTENT_URL_PREFIX = '/assets/img/news/content';

// ─── Types ────────────────────────────────────────────────────────────────────

interface WpPost {
  date: string;
  slug: string;
  link: string;
  title: { rendered: string };
  excerpt: { rendered: string };
  content: { rendered: string };
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

async function fetchBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Fetch an image, downscale it to a JPEG thumbnail, and write it. */
async function downloadThumbnail(url: string, dest: string): Promise<boolean> {
  const buf = await fetchBuffer(url);
  if (!buf) return false;
  try {
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

// ─── Inline article images ────────────────────────────────────────────────────

/** Cache of remote image URL → public path, so shared images download once. */
const inlineCache = new Map<string, string>();
const usedInlineNames = new Set<string>();
let inlineDownloaded = 0;

function sanitizeBasename(url: string): string {
  const path = url.split(/[?#]/)[0];
  const raw = decodeURIComponent(path.split('/').pop() || 'image');
  const cleaned = raw.replace(/[^a-z0-9._-]/gi, '-').replace(/-+/g, '-');
  return cleaned || 'image';
}

/** Download one inline image (resized), returning its public path, or null. */
async function importInlineImage(url: string): Promise<string | null> {
  if (inlineCache.has(url)) return inlineCache.get(url)!;

  const buf = await fetchBuffer(url);
  if (!buf) return null;

  let name = sanitizeBasename(url);
  const ext = extname(name).toLowerCase();
  while (usedInlineNames.has(name)) name = `x-${name}`;
  usedInlineNames.add(name);

  const dest = join(contentImageDir, name);
  try {
    const img = sharp(buf).rotate().resize({ width: CONTENT_WIDTH, withoutEnlargement: true });
    if (ext === '.png') {
      await img.png({ compressionLevel: 9, palette: true }).toFile(dest);
    } else if (ext === '.jpg' || ext === '.jpeg' || ext === '.webp') {
      await img.jpeg({ quality: 78 }).toFile(dest);
    } else {
      writeFileSync(dest, buf); // gif/svg: keep as-is
    }
  } catch {
    writeFileSync(dest, buf); // fall back to original bytes
  }

  const publicPath = `${CONTENT_URL_PREFIX}/${name}`;
  inlineCache.set(url, publicPath);
  inlineDownloaded++;
  return publicPath;
}

/**
 * Rewrite an article body so every image loads locally:
 * strip responsive srcset/sizes, then download each wp-content/uploads URL and
 * swap it for its local path.
 */
async function localizeContent(html: string): Promise<string> {
  let out = html.replace(/\s+(?:srcset|sizes)="[^"]*"/gi, '');

  // Only localize image files; leave PDFs/audio/video pointing at the source.
  const urls = new Set(
    [
      ...out.matchAll(
        /https?:\/\/[^"'\s)]+\/wp-content\/uploads\/[^"'\s)]+?\.(?:jpe?g|png|gif|webp|svg)/gi,
      ),
    ].map((m) => m[0]),
  );
  for (const url of urls) {
    const local = await importInlineImage(url);
    if (local) out = out.split(url).join(local);
  }
  return out.trim();
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
  mkdirSync(contentImageDir, { recursive: true });

  let thumbsOk = 0;
  const usedNames = new Set<string>();
  const usedSlugs = new Set<string>();

  for (const post of posts) {
    const isoDate = post.date.slice(0, 10); // YYYY-MM-DD
    const title = decodeEntities(post.title.rendered).trim();
    const excerpt = cleanText(post.excerpt.rendered);

    // Route slug (unique) and markdown filename.
    let slug = post.slug.replace(/[^a-z0-9-]/gi, '').replace(/-+/g, '-') || 'news';
    while (usedSlugs.has(slug)) slug += '-x';
    usedSlugs.add(slug);

    let base = `${isoDate}-${slug.slice(0, 50)}`;
    while (usedNames.has(base)) base += '-x';
    usedNames.add(base);

    // Featured image → local thumbnail.
    let imageField = '';
    const mediaUrl = post._embedded?.['wp:featuredmedia']?.[0]?.source_url;
    const alt = post._embedded?.['wp:featuredmedia']?.[0]?.alt_text ?? '';
    if (mediaUrl) {
      const imgName = `${base}.jpg`;
      if (await downloadThumbnail(mediaUrl, join(imageDir, imgName))) {
        imageField = imgName;
        thumbsOk++;
      }
    }

    // Full article body with inline images pulled local.
    const body = await localizeContent(post.content.rendered ?? '');

    // Build frontmatter.
    const fm = [
      `date: ${isoDate}`,
      `title: ${yamlQuote(title)}`,
      `slug: ${yamlQuote(slug)}`,
      `source: ${yamlQuote(post.link)}`,
    ];
    if (imageField) fm.push(`image: ${yamlQuote(imageField)}`);
    if (alt) fm.push(`alt: ${yamlQuote(decodeEntities(alt).trim())}`);
    if (excerpt) fm.push(`excerpt: ${yamlQuote(excerpt)}`);

    writeFileSync(join(announcementsDir, `${base}.md`), `---\n${fm.join('\n')}\n---\n\n${body}\n`);
  }

  console.log(`Wrote ${posts.length} announcement files.`);
  console.log(`Downloaded ${thumbsOk}/${posts.length} thumbnails + ${inlineDownloaded} inline images.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
