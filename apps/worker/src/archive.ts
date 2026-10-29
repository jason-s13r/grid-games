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
 *  A finished game never changes, so it may be cached for good. */
export async function serveArchive(bucket: R2Bucket, roomId: string): Promise<Response | null> {
  const object = await bucket.get(key(roomId));
  if (!object) return null;
  return new Response(object.body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-encoding": "gzip",
      "cache-control": "public, max-age=31536000, immutable",
      etag: object.httpEtag,
    },
    encodeBody: "manual",
  });
}
