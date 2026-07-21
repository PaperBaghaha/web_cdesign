/**
 * Matching lab members to the publications they authored.
 *
 * Author strings in papers.bib come from Google Scholar and BibTeX exports, so
 * the same person can appear as "Jingyu Shi", "J. Shi" or "Shi, Jingyu". These
 * helpers reconcile those spellings against the `people` content collection.
 */

import { type BibEntry, getAuthors, getYear } from './bibtex';

/** A person's name broken into the parts we match on. */
interface NameParts {
  /** Full name, accent- and punctuation-stripped, lowercased. */
  full: string;
  /** Surname, normalised. */
  last: string;
  /** First initial, normalised. Empty when the name is a single word. */
  initial: string;
}

/** Strip accents, punctuation and case so two spellings can be compared. */
function normalize(str: string): string {
  return str
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/[.\-']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a display name into the parts used for matching. */
function splitName(name: string): NameParts {
  // "Shi, Jingyu" → "Jingyu Shi" before splitting.
  const reordered = name.includes(',')
    ? name
        .split(',')
        .map((s) => s.trim())
        .reverse()
        .join(' ')
    : name;

  const norm = normalize(reordered);
  const parts = norm.split(' ').filter(Boolean);

  if (parts.length === 0) return { full: '', last: '', initial: '' };
  if (parts.length === 1) return { full: norm, last: parts[0], initial: '' };

  return {
    full: norm,
    last: parts[parts.length - 1],
    initial: parts[0][0] ?? '',
  };
}

/**
 * True when a BibTeX author string refers to the given person.
 *
 * An exact full-name match always wins. Failing that, an abbreviated form
 * ("J. Shi") matches on surname plus first initial — enough to catch Scholar's
 * shortened spellings without colliding across different lab members, whose
 * surnames and initials differ.
 */
function isSamePerson(author: NameParts, person: NameParts): boolean {
  if (!author.last || !person.last) return false;
  if (author.full === person.full) return true;
  if (author.last !== person.last) return false;

  // Only accept a surname match when one side is an abbreviated given name.
  const authorGiven = author.full.slice(0, author.full.length - author.last.length).trim();
  const personGiven = person.full.slice(0, person.full.length - person.last.length).trim();
  const isAbbreviated = authorGiven.length <= 2 || personGiven.length <= 2;

  return isAbbreviated && author.initial === person.initial && author.initial !== '';
}

/** A publication credited to a person, with the fields the profile page renders. */
export interface PersonPublication {
  entry: BibEntry;
  title: string;
  authors: string[];
  venue: string;
  year: number;
}

/**
 * Every publication in `entries` authored by `personName`, newest first.
 *
 * @param personName Display name from the people collection (e.g. "Jingyu Shi").
 * @param entries    Parsed papers.bib entries.
 * @param aliases    Extra spellings for this person (e.g. a maiden name).
 */
export function publicationsByPerson(
  personName: string,
  entries: BibEntry[],
  aliases: string[] = [],
): PersonPublication[] {
  const targets = [personName, ...aliases].map(splitName).filter((n) => n.last !== '');
  if (targets.length === 0) return [];

  const matched: PersonPublication[] = [];

  for (const entry of entries) {
    const authors = getAuthors(entry)
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);

    const isAuthor = authors.some((author) => {
      const parts = splitName(author);
      return targets.some((target) => isSamePerson(parts, target));
    });

    if (!isAuthor) continue;

    matched.push({
      entry,
      title: (entry.fields.title ?? '').replace(/[{}]/g, ''),
      authors,
      venue: entry.fields.journal ?? entry.fields.booktitle ?? entry.fields.publisher ?? '',
      year: getYear(entry),
    });
  }

  return matched.sort((a, b) => {
    if (a.year !== b.year) return b.year - a.year;
    return a.title.localeCompare(b.title);
  });
}

/** Count publications per person — used for the badge on the people index. */
export function publicationCount(
  personName: string,
  entries: BibEntry[],
  aliases: string[] = [],
): number {
  return publicationsByPerson(personName, entries, aliases).length;
}
