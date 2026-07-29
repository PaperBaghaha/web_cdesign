import { site } from '@config/site';
import { getCollection } from 'astro:content';

import bibRaw from '../data/papers.bib?raw';
import { getAuthors, getTitle, getVenue, getYear, parseBibtex } from './bibtex';

/**
 * One build-time index of everything on the site, shared by the ⌘K search
 * palette and the assistant. Both used to build their own, which is how
 * publications and people ended up missing from search.
 *
 * `summary`/`meta`/`body` are only consumed by the assistant, which quotes them
 * to answer questions; search just needs title, section, href, and keywords.
 */
export type SearchItem = {
  title: string;
  section: string;
  href: string;
  keywords: string;
  /** Short skim of the item — the assistant speaks this. */
  summary?: string;
  /** One-line factual header: venue/year, role, term. */
  meta?: string;
  /** Fuller text; the assistant quotes the sentences matching the question. */
  body?: string;
};

/** Trim prose down to a couple of sentences so answers stay skimmable. */
export function skim(text: string | undefined, maxChars = 260): string {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const sentences = clean.split(/(?<=[.!?])\s/);
  let out = '';
  for (const s of sentences) {
    if (out && (out + ' ' + s).length > maxChars) break;
    out = out ? `${out} ${s}` : s;
  }
  if (!out) out = clean.slice(0, maxChars);
  return out.length < clean.length ? `${out.replace(/[.,;:\s]+$/, '')}…` : out;
}

/**
 * Markdown body → plain sentences worth quoting. Strips the syntax that would
 * otherwise be read aloud as gibberish (code fences, images, link markup,
 * headings, HTML tags) and caps the length so the payload stays small.
 */
export function plainBody(md: string | undefined, maxChars = 900): string {
  if (!md) return '';
  return md
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → their text
    .replace(/<[^>]+>/g, ' ') // raw HTML
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s{0,3}[-*+]\s+/gm, '') // bullets
    .replace(/[*_>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

export type SiteIndex = {
  publications: SearchItem[];
  people: SearchItem[];
  projects: SearchItem[];
  posts: SearchItem[];
  teaching: SearchItem[];
  /** All of the above, in the order results should be preferred. */
  all: SearchItem[];
};

export async function buildSearchIndex(): Promise<SiteIndex> {
  const base = site.base || '';

  const publications = parseBibtex(bibRaw).map(
    (entry): SearchItem => ({
      title: getTitle(entry),
      section: 'Publication',
      href: `${base}/publications/${entry.key}/`,
      keywords: [
        getAuthors(entry),
        getVenue(entry),
        String(getYear(entry) || ''),
        entry.fields.abbr ?? '',
      ]
        .filter(Boolean)
        .join(' '),
      summary: skim(entry.fields.abstract),
      body: plainBody(entry.fields.abstract),
      meta: [getAuthors(entry), getVenue(entry), String(getYear(entry) || '')]
        .filter(Boolean)
        .join(' · '),
    }),
  );

  // Sorted by `importance` so the PI and senior members lead any roster.
  const peopleEntries = (await getCollection('people'))
    .filter((p) => !p.data.noPage)
    .sort((a, b) => (a.data.importance ?? 999) - (b.data.importance ?? 999));

  const people = peopleEntries.map(
    (p): SearchItem => ({
      title: p.data.name,
      section: 'People',
      href: `${base}/people/${p.id}/`,
      keywords: [p.data.role ?? '', p.data.major ?? '', ...(p.data.interests ?? [])].join(' '),
      summary: skim(p.data.description),
      meta: [p.data.role, p.data.major].filter(Boolean).join(' · '),
      body: plainBody(p.body),
    }),
  );

  const projects = (await getCollection('projects')).map(
    (p): SearchItem => ({
      title: p.data.title,
      section: 'Research',
      href: `${base}/projects/${p.id}/`,
      keywords: p.data.category ?? '',
      summary: skim(p.data.description),
      meta: p.data.category ? `Research area — ${p.data.category}` : 'Research area',
      body: plainBody(p.body),
    }),
  );

  const posts = (await getCollection('posts'))
    .filter((p) => !p.data.hidden && !p.data.draft)
    .map(
      (p): SearchItem => ({
        title: p.data.title,
        section: 'Blog',
        href: `${base}/blog/${p.id}/`,
        keywords: [...(p.data.tags ?? []), ...(p.data.categories ?? [])].join(' '),
        summary: skim(p.data.description),
        meta: p.data.date ? `Blog post, ${p.data.date.getFullYear()}` : 'Blog post',
        body: plainBody(p.body),
      }),
    );

  const teaching = (await getCollection('teaching')).map(
    (t): SearchItem => ({
      title: t.data.title,
      section: 'Courses',
      href: `${base}/teaching/`,
      keywords: [t.data.term ?? '', t.data.code ?? ''].join(' ').trim(),
      summary: skim(t.data.description),
      meta: [t.data.code, t.data.term, t.data.institution].filter(Boolean).join(' · '),
      body: plainBody(t.body),
    }),
  );

  return {
    publications,
    people,
    projects,
    posts,
    teaching,
    all: [...publications, ...people, ...projects, ...posts, ...teaching],
  };
}
