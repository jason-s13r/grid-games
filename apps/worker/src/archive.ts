// Finished games, kept in R2.
//
// When a game ends, its room writes the whole game (genesis, every stamped
// move, who sat where, the result) as one gzipped JSON object. That is what a
// replay plays, and it is what outlives the room: some days after the end the
// room's own storage is deleted, and the archive is the game from then on.
//
// R2 is the cheap place for it: a game is written once and read rarely, and
// storage there costs a fraction of a Durable Object's.

import type { GameArchive } from "@tessera/room";

const key = (roomId: string): string => `games/${roomId}.json.gz`;

export async function writeArchive(bucket: R2Bucket, archive: GameArchive): Promise<void> {
  const text = new Blob([JSON.stringify(archive)]).stream();
  const gzipped = await new Response(text.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  await bucket.put(key(archive.roomId), gzipped, {
    httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
    customMetadata: { format: archive.format, steps: String(archive.steps), hash: archive.hash },
  });
}

export function hasArchive(bucket: R2Bucket, roomId: string): Promise<boolean> {
  return bucket.head(key(roomId)).then((object) => object !== null);
}

/** The archive as stored: gzipped, and labelled so, for the browser to unpack.
 *  A finished game never changes, so it may be cached for good, and it is
 *  kept in the edge cache too: a replay watched by many people, or a script
 *  asking for it in a loop, is served from the cache rather than costing an
 *  R2 read each time. (The cache works on a custom domain such as
 *  tessera.qot.nz, and is skipped on workers.dev.) */
export async function serveArchive(
  bucket: R2Bucket,
  roomId: string,
  request: Request,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // Cached as plain bytes, with no content-encoding for the cache to act on:
  // what goes in is exactly the stored gzip, and it is labelled on the way
  // out. The key carries a version, so a change of layout starts afresh.
  const cache = caches.default;
  const cacheKey = new Request(`${new URL(request.url).origin}/cache/archive/v1/${roomId}`);
  let bytes: ArrayBuffer | undefined;
  let etag: string | undefined;
  const cached = await cache.match(cacheKey);
  if (cached) {
    bytes = await cached.arrayBuffer();
    etag = cached.headers.get("etag") ?? undefined;
  } else {
    const object = await bucket.get(key(roomId));
    if (!object) return null;
    bytes = await object.arrayBuffer();
    etag = object.httpEtag;
    const keep = new Response(bytes.slice(0), {
      headers: { "content-type": "application/octet-stream", "cache-control": "public, max-age=31536000, immutable", etag },
    });
    ctx.waitUntil(cache.put(cacheKey, keep));
  }
  return new Response(bytes, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-encoding": "gzip",
      "cache-control": "public, max-age=31536000, immutable",
      ...(etag ? { etag } : {}),
    },
    encodeBody: "manual",
  });
}
