/**
 * update-publications.ts
 *
 * Keeps src/data/papers.bib in sync with the lab's real publication metadata.
 *
 * ─── Why not scrape Google Scholar directly? ─────────────────────────────────
 *
 * Google Scholar has no public API, rate-limits aggressively, and serves a
 * CAPTCHA after a handful of automated requests. Any scraper built against it
 * breaks within days and violates Scholar's Terms of Service. So this script
 * takes the two paths that actually work and stay working:
 *
 *   1. IMPORT  — Google Scholar profiles have a built-in BibTeX export.
 *                Open the profile, tick "select all", then Export ▸ BibTeX,
 *                and save the file. That output is authored by Scholar itself,
 *                so it is genuinely "BibTeX straight from Google Scholar" —
 *                just obtained through the supported door instead of a scraper.
 *
 *   2. ENRICH  — Everything Scholar leaves thin (DOIs, abstracts, page ranges,
 *                publisher, canonical venue names) is backfilled from OpenAlex
 *                and Crossref. Both are free, keyless, and permit automation.
 *
 * ─── Merge safety ────────────────────────────────────────────────────────────
 *
 * Merging is strictly additive by default. Curated, hand-authored fields
 * (selected, preview, video, abbr, award, …) are never touched, and existing
 * values win over remote ones unless --overwrite is passed. A timestamped
 * backup of papers.bib is written before anything changes.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 *   yarn pubs:import  path/to/citations.bib   # merge a Scholar BibTeX export
 *   yarn pubs:enrich                          # backfill via OpenAlex + Crossref
 *   yarn pubs:enrich --limit=25               # only process the first 25 gaps
 *   yarn pubs:enrich --dry-run                # report changes, write nothing
 *   yarn pubs:enrich --overwrite              # let remote data replace existing
 */

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type BibEntry, parseBibtex } from '../src/utils/bibtex.ts';

// ─── Config ───────────────────────────────────────────────────────────────────

/** Delay between API calls. OpenAlex/Crossref both allow far more than this. */
const REQUEST_DELAY_MS = 350;

/** Contact address for the OpenAlex + Crossref "polite pools" (higher limits). */
const POLITE_POOL_EMAIL = 'cdesign-lab@purdue.edu';

/**
 * Fields that are authored by hand in this repo and describe how a paper is
 * *presented* on the site. Remote sources must never overwrite these, even
 * when --overwrite is passed.
 */
const CURATED_FIELDS = new Set([
  'abbr',
  'additional_info',
  'annotation',
  'award',
  'award_name',
  'blog',
  'code',
  'google_scholar_id',
  'html',
  'pdf',
  'poster',
  'preview',
  'preview_alt',
  'selected',
  'slides',
  'supp',
  'video',
  'website',
]);

/** Order fields are emitted in, so regenerated files stay readable and diffable. */
const FIELD_ORDER = [
  'title',
  'author',
  'booktitle',
  'journal',
  'publisher',
  'organization',
  'series',
  'volume',
  'number',
  'pages',
  'year',
  'month',
  'doi',
  'url',
  'arxiv',
  'isbn',
  'issn',
  'abstract',
  'abbr',
  'preview',
  'preview_alt',
  'video',
  'pdf',
  'html',
  'code',
  'slides',
  'poster',
  'supp',
  'website',
  'blog',
  'award',
  'award_name',
  'annotation',
  'additional_info',
  'google_scholar_id',
  'selected',
];

// ─── Paths ────────────────────────────────────────────────────────────────────

const root = process.cwd();
const bibPath = join(root, 'src/data/papers.bib');

// ─── CLI parsing ──────────────────────────────────────────────────────────────

interface Options {
  mode: 'import' | 'enrich';
  importFile?: string;
  dryRun: boolean;
  overwrite: boolean;
  limit: number;
}

function parseArgs(argv: string[]): Options {
  const args = argv.slice(2);
  const flag = (name: string) => args.includes(`--${name}`);
  const value = (name: string): string | undefined => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };

  const positional = args.filter((a) => !a.startsWith('--'));
  const mode = flag('import') || positional.length > 0 ? 'import' : 'enrich';

  const limitRaw = value('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(limit)) {
    throw new Error(`--limit must be a number, got "${limitRaw}"`);
  }

  return {
    mode,
    importFile: positional[0] ?? value('import'),
    dryRun: flag('dry-run'),
    overwrite: flag('overwrite'),
    limit,
  };
}

// ─── Normalisation helpers ────────────────────────────────────────────────────

/** Strip accents, punctuation and case so two titles can be compared for identity. */
function normaliseTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[{}]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Escape the handful of characters that would corrupt a BibTeX braced value. */
function escapeBibValue(value: string): string {
  return value
    .replace(/[{}]/g, '')
    .replace(/\\/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── BibTeX serialisation ─────────────────────────────────────────────────────

/** Render one entry, ordering known fields and appending any unknown ones. */
function serialiseEntry(entry: BibEntry): string {
  const known = FIELD_ORDER.filter((f) => entry.fields[f] !== undefined);
  const extra = Object.keys(entry.fields)
    .filter((f) => !FIELD_ORDER.includes(f))
    .sort();
  const ordered = [...known, ...extra];

  const width = Math.max(...ordered.map((f) => f.length));
  const lines = ordered.map((f) => `  ${f.padEnd(width)} = {${entry.fields[f]}},`);

  return `@${entry.type}{${entry.key},\n${lines.join('\n')}\n}`;
}

/** Render the whole file, newest publications first. */
function serialiseBib(entries: BibEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    const ya = Number.parseInt(a.fields.year ?? '0', 10);
    const yb = Number.parseInt(b.fields.year ?? '0', 10);
    if (ya !== yb) return yb - ya;
    return a.key.localeCompare(b.key);
  });

  const header = [
    '% Convergence Design Lab — publication list',
    '%',
    '% Managed by scripts/update-publications.ts. Two ways to update:',
    '%',
    '%   yarn pubs:import <scholar-export.bib>   merge a Google Scholar BibTeX export',
    '%   yarn pubs:enrich                        backfill metadata via OpenAlex + Crossref',
    '%',
    '% Curated fields (selected, preview, video, abbr, award, …) are preserved',
    '% by both commands and are safe to edit by hand.',
    '%',
    `% Last updated: ${new Date().toISOString().split('T')[0]}`,
    '',
    '',
  ].join('\n');

  return header + sorted.map(serialiseEntry).join('\n\n') + '\n';
}

// ─── Merge ────────────────────────────────────────────────────────────────────

interface MergeStats {
  added: number;
  updated: number;
  fieldsFilled: number;
}

/**
 * Fold `incoming` fields into `target`. Curated fields are always protected;
 * other existing values are kept unless `overwrite` is set.
 * Returns the number of fields actually written.
 */
function mergeFields(
  target: BibEntry,
  incoming: Record<string, string | null | undefined>,
  overwrite: boolean,
): number {
  let filled = 0;

  for (const [field, raw] of Object.entries(incoming)) {
    // Remote APIs return JSON null for absent fields, so check both.
    if (raw === undefined || raw === null || raw === '') continue;
    if (CURATED_FIELDS.has(field)) continue;

    const value = escapeBibValue(raw);
    if (!value) continue;

    const existing = target.fields[field];
    if (existing && !overwrite) continue;
    if (existing === value) continue;

    target.fields[field] = value;
    filled++;
  }

  return filled;
}

// ─── Mode 1: import a Google Scholar BibTeX export ────────────────────────────

async function runImport(opts: Options, entries: BibEntry[]): Promise<MergeStats> {
  if (!opts.importFile) {
    throw new Error(
      'No import file given.\n\n' +
        'Export your Scholar profile first:\n' +
        '  1. Open https://scholar.google.com/citations?user=<YOUR_ID>\n' +
        '  2. Tick the checkbox in the table header to select all publications\n' +
        '  3. Export ▸ BibTeX, then save the page as citations.bib\n' +
        '  4. yarn pubs:import path/to/citations.bib',
    );
  }

  const raw = readFileSync(opts.importFile, 'utf8');
  const incoming = parseBibtex(raw);

  if (incoming.length === 0) {
    throw new Error(`No BibTeX entries found in ${opts.importFile}`);
  }

  console.log(`\nImporting ${incoming.length} entr${incoming.length === 1 ? 'y' : 'ies'} from ${opts.importFile}\n`);

  // Index existing entries by normalised title so we match on content, not key.
  const byTitle = new Map<string, BibEntry>();
  for (const entry of entries) {
    byTitle.set(normaliseTitle(entry.fields.title ?? ''), entry);
  }

  const stats: MergeStats = { added: 0, updated: 0, fieldsFilled: 0 };

  for (const incomingEntry of incoming) {
    const title = incomingEntry.fields.title ?? '';
    const match = byTitle.get(normaliseTitle(title));
    const short = title.length > 62 ? `${title.slice(0, 62)}…` : title;

    if (match) {
      // Scholar knows the real entry type (@inproceedings vs @article) — trust it.
      if (incomingEntry.type !== 'misc' && match.type !== incomingEntry.type) {
        match.type = incomingEntry.type;
      }
      const filled = mergeFields(match, incomingEntry.fields, opts.overwrite);
      if (filled > 0) {
        stats.updated++;
        stats.fieldsFilled += filled;
        console.log(`  ~ ${short}\n      +${filled} field(s)`);
      }
    } else {
      entries.push(incomingEntry);
      byTitle.set(normaliseTitle(title), incomingEntry);
      stats.added++;
      console.log(`  + ${short}`);
    }
  }

  return stats;
}

// ─── Mode 2: enrich from OpenAlex + Crossref ──────────────────────────────────

/** Remote fields are all optional and may arrive as JSON null. */
type Maybe = string | null | undefined;

interface RemoteMeta {
  type?: Maybe;
  doi?: Maybe;
  venue?: Maybe;
  venueField?: 'journal' | 'booktitle';
  publisher?: Maybe;
  volume?: Maybe;
  issue?: Maybe;
  pages?: Maybe;
  abstract?: Maybe;
  url?: Maybe;
}

interface OpenAlexAuthorship {
  author?: { display_name?: string };
}

interface OpenAlexLocation {
  source?: { display_name?: string; type?: string; host_organization_name?: string };
  landing_page_url?: string;
}

interface OpenAlexWork {
  id?: string;
  display_name?: string;
  doi?: string;
  type?: string;
  publication_year?: number;
  biblio?: { volume?: string; issue?: string; first_page?: string; last_page?: string };
  primary_location?: OpenAlexLocation;
  authorships?: OpenAlexAuthorship[];
  abstract_inverted_index?: Record<string, number[]>;
}

/** OpenAlex ships abstracts as an inverted index; rebuild the plain text. */
function reconstructAbstract(index: Record<string, number[]> | undefined): string | undefined {
  if (!index) return undefined;

  const slots: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const pos of positions) slots[pos] = word;
  }

  const text = slots.filter(Boolean).join(' ').trim();
  // Very short reconstructions are usually truncated junk, not real abstracts.
  return text.length > 80 ? text : undefined;
}

/** Map an OpenAlex work type onto the closest BibTeX entry type. */
function bibTypeFor(openAlexType: string | undefined): string | undefined {
  switch (openAlexType) {
    case 'article':
      return 'article';
    case 'book':
      return 'book';
    case 'book-chapter':
      return 'incollection';
    case 'dissertation':
      return 'phdthesis';
    case 'preprint':
      return 'misc';
    default:
      return undefined;
  }
}

/** Look a paper up on OpenAlex by exact title, verifying the match before use. */
async function fetchOpenAlex(title: string, year: number): Promise<RemoteMeta | null> {
  const params = new URLSearchParams({
    filter: `title.search:${title.replace(/[^\w\s]/g, ' ').trim()}`,
    per_page: '5',
    select:
      'id,display_name,doi,type,publication_year,biblio,primary_location,authorships,abstract_inverted_index',
    mailto: POLITE_POOL_EMAIL,
  });

  try {
    const res = await fetch(`https://api.openalex.org/works?${params}`, {
      headers: { 'User-Agent': `cdl-site/1.0 (mailto:${POLITE_POOL_EMAIL})` },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { results?: OpenAlexWork[] };
    const wanted = normaliseTitle(title);

    // Require an exact normalised title match — fuzzy hits attach wrong DOIs.
    const work = (data.results ?? []).find((w) => normaliseTitle(w.display_name ?? '') === wanted);
    if (!work) return null;

    // Guard against same-title-different-paper collisions across years.
    if (year > 0 && work.publication_year && Math.abs(work.publication_year - year) > 1) {
      return null;
    }

    const source = work.primary_location?.source;
    const isJournal = source?.type === 'journal';
    const biblio = work.biblio;
    const pages =
      biblio?.first_page && biblio?.last_page
        ? `${biblio.first_page}--${biblio.last_page}`
        : biblio?.first_page;

    return {
      type: bibTypeFor(work.type),
      doi: work.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//, ''),
      venue: source?.display_name,
      venueField: isJournal ? 'journal' : 'booktitle',
      publisher: source?.host_organization_name,
      volume: biblio?.volume,
      issue: biblio?.issue,
      pages,
      abstract: reconstructAbstract(work.abstract_inverted_index),
      url: work.primary_location?.landing_page_url,
    };
  } catch {
    return null;
  }
}

interface CrossrefItem {
  title?: string[];
  DOI?: string;
  type?: string;
  publisher?: string;
  'container-title'?: string[];
  volume?: string;
  issue?: string;
  page?: string;
  abstract?: string;
}

/** Crossref fallback — better than OpenAlex for ACM/IEEE conference proceedings. */
async function fetchCrossref(title: string, year: number): Promise<RemoteMeta | null> {
  const params = new URLSearchParams({
    'query.bibliographic': title,
    rows: '5',
    select: 'title,DOI,type,publisher,container-title,volume,issue,page,abstract',
    mailto: POLITE_POOL_EMAIL,
  });

  try {
    const res = await fetch(`https://api.crossref.org/works?${params}`, {
      headers: { 'User-Agent': `cdl-site/1.0 (mailto:${POLITE_POOL_EMAIL})` },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { message?: { items?: CrossrefItem[] } };
    const wanted = normaliseTitle(title);

    const item = (data.message?.items ?? []).find(
      (i) => normaliseTitle(i.title?.[0] ?? '') === wanted,
    );
    if (!item) return null;

    const isProceedings = item.type === 'proceedings-article';

    return {
      type: isProceedings ? 'inproceedings' : item.type === 'journal-article' ? 'article' : undefined,
      doi: item.DOI,
      venue: item['container-title']?.[0],
      venueField: isProceedings ? 'booktitle' : 'journal',
      publisher: item.publisher,
      volume: item.volume,
      issue: item.issue,
      pages: item.page?.replace(/-/g, '--'),
      // Crossref abstracts arrive as JATS XML — strip the tags.
      abstract: item.abstract?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || undefined,
      url: item.DOI ? `https://doi.org/${item.DOI}` : undefined,
    };
  } catch {
    void year;
    return null;
  }
}

/** True when an entry still lacks the metadata that makes a citation useful. */
function needsEnrichment(entry: BibEntry): boolean {
  const hasVenue = Boolean(entry.fields.journal ?? entry.fields.booktitle);
  return !hasVenue || !entry.fields.doi || !entry.fields.abstract;
}

async function runEnrich(opts: Options, entries: BibEntry[]): Promise<MergeStats> {
  const targets = entries.filter(needsEnrichment).slice(0, opts.limit);

  if (targets.length === 0) {
    console.log('\nEvery entry already has a venue, DOI and abstract — nothing to enrich.\n');
    return { added: 0, updated: 0, fieldsFilled: 0 };
  }

  console.log(
    `\nEnriching ${targets.length} of ${entries.length} entries via OpenAlex → Crossref\n`,
  );

  const stats: MergeStats = { added: 0, updated: 0, fieldsFilled: 0 };
  let index = 0;

  for (const entry of targets) {
    index++;
    const title = (entry.fields.title ?? '').replace(/[{}]/g, '');
    const year = Number.parseInt(entry.fields.year ?? '0', 10);
    const short = title.length > 54 ? `${title.slice(0, 54)}…` : title;

    process.stdout.write(`  [${String(index).padStart(3)}/${targets.length}] ${short} … `);

    let meta = await fetchOpenAlex(title, year);
    let source = 'OpenAlex';

    if (!meta?.doi) {
      await sleep(REQUEST_DELAY_MS);
      const crossref = await fetchCrossref(title, year);
      if (crossref) {
        meta = { ...meta, ...crossref };
        source = meta.venue && crossref.venue ? 'OpenAlex+Crossref' : 'Crossref';
      }
    }

    if (!meta) {
      console.log('no match');
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    // Venue goes into journal or booktitle depending on what kind of venue it is.
    const incoming: Record<string, Maybe> = {
      doi: meta.doi,
      publisher: meta.publisher,
      volume: meta.volume,
      number: meta.issue,
      pages: meta.pages,
      abstract: meta.abstract,
      url: meta.url,
    };
    if (meta.venue && meta.venueField) {
      incoming[meta.venueField] = meta.venue;
    }

    if (meta.type && entry.type === 'article' && meta.type !== 'article') {
      entry.type = meta.type;
    }

    const filled = mergeFields(entry, incoming, opts.overwrite);
    if (filled > 0) {
      stats.updated++;
      stats.fieldsFilled += filled;
      console.log(`+${filled} field(s) via ${source}`);
    } else {
      console.log('nothing new');
    }

    await sleep(REQUEST_DELAY_MS);
  }

  return stats;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  const bibRaw = readFileSync(bibPath, 'utf8');
  const entries = parseBibtex(bibRaw);
  console.log(`Loaded ${entries.length} entries from src/data/papers.bib`);

  const stats =
    opts.mode === 'import' ? await runImport(opts, entries) : await runEnrich(opts, entries);

  const touched = stats.added + stats.updated;

  console.log('\n─────────────────────────────────────');
  console.log(`  added        ${stats.added}`);
  console.log(`  updated      ${stats.updated}`);
  console.log(`  fields filled ${stats.fieldsFilled}`);
  console.log(`  total entries ${entries.length}`);
  console.log('─────────────────────────────────────');

  if (touched === 0) {
    console.log('\nNo changes — papers.bib left untouched.\n');
    return;
  }

  if (opts.dryRun) {
    console.log('\n--dry-run: papers.bib was NOT written.\n');
    return;
  }

  // Back up before overwriting, so a bad run is always recoverable.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
  const backupPath = `${bibPath}.${stamp}.bak`;
  copyFileSync(bibPath, backupPath);

  writeFileSync(bibPath, serialiseBib(entries), 'utf8');

  console.log(`\n✓ Wrote src/data/papers.bib`);
  console.log(`  backup: ${backupPath}\n`);
}

main().catch((err: unknown) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
