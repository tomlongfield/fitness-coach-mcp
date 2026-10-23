import { z } from 'zod';
import { getState, getMedia } from '../opengym-client.js';
import { normalizeState } from '../opengym-logic.js';
import { workoutMediaOf, normalizeMediaRef } from '../vendor/opengym/media-refs.js';
import { mapWithConcurrency } from './shared.js';
import { localTimestamp } from '../date-utils.js';

const STILL_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
// Per image, after download. The app re-encodes photos on the device before
// upload, so a real one is well under this — it's a guard against a GIF or
// an unconverted original blowing up the response, not an expected limit.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// The still to show for a ref: the photo itself, or a video's poster frame
// (openGym stores one alongside every video). A video with no poster has
// nothing viewable here.
function viewableOf(ref) {
  if (STILL_MIMES.has(ref.mime)) return { hash: ref.hash, mime: ref.mime, fromVideo: false };
  if (ref.poster && STILL_MIMES.has(ref.poster.mime)) return { hash: ref.poster.hash, mime: ref.poster.mime, fromVideo: true };
  return null;
}

// Progress photos filed under a day rather than a workout (openGym 1.4.2,
// state.dayPhotos: { <hash>: { d, m: MediaRef, _ts } }): a day without a
// workout, or a photo added later for an earlier day. Read as upstream's
// day-photos.js readDayPhoto does — a removed photo is a stamped entry
// with no m, and an entry must be keyed by its own file.
function dayPhotosOf(state) {
  const map = state.dayPhotos && typeof state.dayPhotos === 'object' ? state.dayPhotos : {};
  const out = [];
  for (const [hash, e] of Object.entries(map)) {
    if (!e || typeof e !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(String(e.d || ''))) continue;
    const ref = normalizeMediaRef(e.m);
    if (ref && ref.hash === hash) out.push({ d: e.d, ref });
  }
  return out;
}

export function registerMediaTools(server) {
  server.registerTool(
    'get_workout_photos',
    {
      title: 'Get workout photos',
      description:
        "openGym photos as images, newest first: workout photos and progress photos filed under a day. Each is a full download, so keep limit small. Only for photo questions; most workouts have none.",
      inputSchema: {
        workoutId: z.string().min(1).optional().describe('From get_recent_workouts; omit for the latest.'),
        limit: z.number().int().min(1).max(10).optional().describe('Default 4.'),
      },
    },
    async ({ workoutId, limit }) => {
      const state = normalizeState(await getState());
      const max = limit ?? 4;
      let workouts = state.workouts;
      if (workoutId) {
        workouts = workouts.filter((w) => w.id === workoutId);
        if (!workouts.length) throw new Error(`No workout with id ${JSON.stringify(workoutId)}.`);
      }
      const fromWorkouts = workouts.flatMap((w) => workoutMediaOf(w).map((ref) => ({ w, d: w.d, ref })));
      const fromDays = workoutId ? [] : dayPhotosOf(state);
      const all = [...fromWorkouts, ...fromDays]
        .map((m) => ({ ...m, view: viewableOf(m.ref) }))
        .filter((m) => m.view)
        .sort((a, b) => (b.ref.at || 0) - (a.ref.at || 0) || String(b.d).localeCompare(String(a.d)));
      const picked = all.slice(0, max);

      const downloaded = await mapWithConcurrency(picked, 4, async (m) => ({ ...m, file: await getMedia(m.view.hash) }));
      const items = [];
      const content = [];
      for (const m of downloaded) {
        const meta = {
          ...(m.w ? { workoutId: m.w.id } : {}),
          date: m.d,
          ...(m.w ? { workoutName: m.w.name ?? null } : {}),
          ...(m.ref.at ? { addedAt: localTimestamp(m.ref.at) } : {}),
          ...(m.view.fromVideo ? { videoPosterOnly: true } : {}),
        };
        if (!m.file) {
          items.push({ ...meta, unavailable: 'not on the server (never uploaded from the device, or removed)' });
          continue;
        }
        if (m.file.size > MAX_IMAGE_BYTES || !STILL_MIMES.has(m.file.mimeType)) {
          items.push({ ...meta, unavailable: `skipped (${m.file.mimeType}, ${m.file.size} bytes)` });
          continue;
        }
        items.push({ ...meta, image: content.length + 1 });
        content.push({ type: 'image', data: m.file.data, mimeType: m.file.mimeType });
      }
      const summary = { count: items.length, hasMore: all.length > picked.length, photos: items };
      // Restated in the result itself so the description's instruction
      // also reaches a caller that's reading the empty output.
      if (!items.length) summary.note = 'No photos. This is normal — nothing to report or act on.';
      // Metadata first, then the images in the order `image: n` refers to.
      return { content: [{ type: 'text', text: JSON.stringify(summary) }, ...content] };
    }
  );
}
