/**
 * Publication media helpers.
 *
 * Publications can carry a `preview` image and a `video` in papers.bib. Videos
 * arrive in three shapes — a YouTube link, a Vimeo link, or a self-hosted file
 * — and each needs a different element. These helpers classify the URL so the
 * page can pick between an <iframe> and a native <video>.
 */

/** How a video should be rendered on the page. */
export type VideoKind = 'youtube' | 'vimeo' | 'file' | 'link';

export interface VideoEmbed {
  kind: VideoKind;
  /** iframe src for youtube/vimeo, or the file URL for a native <video>. */
  src: string;
  /** Original URL, for the "open in new tab" fallback link. */
  href: string;
}

/** File extensions the browser can play in a native <video> element. */
const PLAYABLE = /\.(mp4|webm|ogv|ogg|mov)(\?.*)?$/i;

/**
 * Pull the 11-character video ID out of any of YouTube's URL shapes:
 * watch?v=, youtu.be/, /embed/, /shorts/, /live/.
 */
function youtubeId(url: string): string | null {
  const patterns = [
    /[?&]v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /\/embed\/([\w-]{11})/,
    /\/shorts\/([\w-]{11})/,
    /\/live\/([\w-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/** Pull the numeric ID out of a Vimeo URL. */
function vimeoId(url: string): string | null {
  const match = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  return match ? match[1] : null;
}

/**
 * Classify a video URL into something renderable.
 *
 * @param video    Raw `video` field from papers.bib.
 * @param mediaDir Base path prepended to non-absolute paths.
 */
export function resolveVideo(video: string | undefined, mediaDir: string): VideoEmbed | undefined {
  if (!video) return undefined;
  const raw = video.trim();
  if (!raw) return undefined;

  const isAbsolute = /^https?:\/\//i.test(raw) || raw.startsWith('/');
  const href = isAbsolute ? raw : `${mediaDir}${raw}`;

  const yt = youtubeId(raw);
  if (yt) {
    // youtube-nocookie avoids setting tracking cookies before playback starts.
    return { kind: 'youtube', src: `https://www.youtube-nocookie.com/embed/${yt}`, href: raw };
  }

  const vimeo = vimeoId(raw);
  if (vimeo) {
    return { kind: 'vimeo', src: `https://player.vimeo.com/video/${vimeo}`, href: raw };
  }

  if (PLAYABLE.test(href)) {
    return { kind: 'file', src: href, href };
  }

  // Unknown host (Box, Drive, a lab server page) — link out rather than guess.
  return { kind: 'link', src: href, href };
}

/**
 * Resolve a preview image path against the media directory.
 * Absolute URLs and root-relative paths are passed through untouched.
 */
export function resolvePreview(preview: string | undefined, mediaDir: string): string | undefined {
  if (!preview) return undefined;
  const raw = preview.trim();
  if (!raw) return undefined;

  const isAbsolute = /^https?:\/\//i.test(raw) || raw.startsWith('/');
  return isAbsolute ? raw : `${mediaDir}${raw}`;
}
