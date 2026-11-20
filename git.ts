// git.ts — git object model, pack read/write, pkt-line, delta handling.
// Standard library only (node:crypto, node:zlib). Written for the
// github-core-clone-01 bounty entry. All code here is original.

import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of `type` + `data` (the "type SP size NUL data" hash). */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** The full stored form of an object (header + payload), for hashing checks. */
export function objectBytes(type: ObjectType, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000' | '160000'
  name: string;
  oid: string;
}

/** Parse a tree object's payload into entries (sorted as stored). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) throw new Error('malformed tree: no mode terminator');
    const mode = data.subarray(pos, space).toString('utf8');
    const nul = data.indexOf(0, space + 1);
    if (nul === -1) throw new Error('malformed tree: no name terminator');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('malformed tree: truncated oid');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Serialize tree entries. Entries are stored sorted by name (dirs sort as name + '/'). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Raw header lines we do not interpret (gpgsig etc.), kept for round-trip. */
  extra: string[];
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message, extra: [] };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
    else if (line !== '') info.extra.push(line);
  }
  return info;
}

export interface CommitBuild {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Build a commit payload. `author`/`committer` are full "Name <email> ts +0000" lines. */
export function buildCommit(c: CommitBuild): Buffer {
  const lines: string[] = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`);
  lines.push(`committer ${c.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${c.message}`, 'utf8');
}

/** "Name <email> ts +0000" identity line. */
export function ident(name: string, email: string, tsSec: number): string {
  return `${name} <${email}> ${tsSec} +0000`;
}

// ---------------------------------------------------------------- pkt-line

/** Encode one pkt-line (payload includes its own trailing newline when present). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > 65520) throw new Error('pkt-line too long');
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([head, body]);
}

export const FLUSH = Buffer.from('0000', 'utf8');
export const DELIM = Buffer.from('0001', 'utf8');
export const RESPONSE_END = Buffer.from('0002', 'utf8');

/** Parse a pkt-line stream into lines. Returns {lines, rest} where each line is the
 *  payload without its 4-byte length prefix; flush/delim/end markers become null. */
export function parsePktLines(buf: Buffer): { lines: (Buffer | null)[]; rest: Buffer } {
  const lines: (Buffer | null)[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const hex = buf.subarray(pos, pos + 4).toString('utf8');
    const len = parseInt(hex, 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    if (len <= 2) {
      // Control markers: 0000 flush, 0001 delim, 0002 response-end.
      lines.push(null);
      pos += 4;
      continue;
    }
    if (len < 4) throw new Error('bad pkt-line length < 4');
    if (pos + len > buf.length) break; // incomplete
    lines.push(buf.subarray(pos + 4, pos + len));
    pos += len;
  }
  return { lines, rest: buf.subarray(pos) };
}

/** Encode a sideband frame: band byte + payload, as one pkt-line. */
export function sidebandFrame(band: 1 | 2 | 3, payload: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), payload]));
}

// ---------------------------------------------------------------- pack writing

const PACK_TYPE_NUM: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_NUM_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Write a pack file of plain (non-delta) objects. */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeNum = PACK_TYPE_NUM[obj.type];
    const size = obj.data.length;
    // varint header: first byte holds 4 size bits, following bytes 7 bits each.
    const headBytes: number[] = [];
    let remaining = size;
    let first = (typeNum << 4) | (remaining & 0x0f);
    remaining >>>= 4;
    if (remaining > 0) first |= 0x80;
    headBytes.push(first);
    while (remaining > 0) {
      let b = remaining & 0x7f;
      remaining >>>= 7;
      if (remaining > 0) b |= 0x80;
      headBytes.push(b);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(zlib.deflateSync(obj.data));
  }
  const trailer = sha1Hex(Buffer.concat(parts));
  parts.push(Buffer.from(trailer, 'hex'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- pack reading

export interface PackEntry {
  type: ObjectType;
  data: Buffer;
  oid: string;
}

/** Inflate the deflate stream starting at `start`, expecting `expectedSize` bytes out.
 *  Returns the data and how many input bytes the stream consumed. Uses binary search
 *  on the end offset: inflateSync throws on a truncated stream and ignores trailing
 *  bytes once the stream ends, so the predicate is monotonic. */
function inflateAt(buf: Buffer, start: number, expectedSize: number): { data: Buffer; consumed: number } {
  const ok = (end: number): Buffer | null => {
    try {
      const data = zlib.inflateSync(buf.subarray(start, end));
      return data.length === expectedSize ? data : null;
    } catch {
      return null;
    }
  };
  // Exponential probe to bound the search, then binary search for the smallest end.
  let lo = start;
  let hi = buf.length;
  let probe = Math.min(start + 64, buf.length);
  let found: Buffer | null = null;
  while (probe < buf.length) {
    const data = ok(probe);
    if (data !== null) {
      found = data;
      hi = probe;
      break;
    }
    lo = probe;
    probe = Math.min(start + (probe - start) * 2, buf.length);
  }
  if (found === null) {
    const data = ok(buf.length);
    if (data === null) throw new Error('pack: cannot inflate object data');
    found = data;
    hi = buf.length;
  }
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    const data = ok(mid);
    if (data !== null) hi = mid;
    else lo = mid;
  }
  const data = ok(hi);
  if (data === null) throw new Error('pack: cannot inflate object data');
  return { data, consumed: hi - start };
}

/** Parse a delta's base size / target size varints and apply it to `base`. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('delta: truncated varint');
      const b = delta[pos++];
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta: base size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      // copy from base
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          if (pos >= delta.length) throw new Error('delta: truncated copy');
          offset |= delta[pos++] << (8 * i);
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          if (pos >= delta.length) throw new Error('delta: truncated copy');
          size |= delta[pos++] << (8 * i);
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta: copy out of range');
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new Error('delta: truncated insert');
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta: opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== tgtSize || outLen !== tgtSize) throw new Error('delta: target size mismatch');
  return result;
}

/** Read a whole pack file. Returns objects keyed by oid (deltas resolved). */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack: too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack: bad signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack: unsupported version ${version}`);
  const count = pack.readUInt32BE(8);
  // Trailer check (last 20 bytes must be the sha1 of everything before).
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const expectTrailer = sha1Hex(pack.subarray(0, pack.length - 20));
  if (trailer !== expectTrailer) throw new Error('pack: trailer checksum mismatch');

  interface RawEntry {
    typeNum: number;
    data: Buffer;
    ofsBase?: number; // byte offset of the base object in the pack
    refBase?: string; // oid of the base object
    offset: number; // this entry's offset (for ofs-delta resolution)
  }
  const raw: RawEntry[] = [];
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = pos;
    if (pos >= pack.length - 20) throw new Error('pack: truncated entries');
    let b = pack[pos++];
    const typeNum = (b >> 4) & 0x7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      if (pos >= pack.length - 20) throw new Error('pack: truncated size');
      b = pack[pos++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let ofsBase: number | undefined;
    let refBase: string | undefined;
    if (typeNum === 6) {
      // OFS_DELTA: git's variable-length negative offset.
      if (pos >= pack.length - 20) throw new Error('pack: truncated ofs offset');
      b = pack[pos++];
      let offset = b & 0x7f;
      while (b & 0x80) {
        if (pos >= pack.length - 20) throw new Error('pack: truncated ofs offset');
        b = pack[pos++];
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      ofsBase = entryOffset - offset;
    } else if (typeNum === 7) {
      if (pos + 20 > pack.length - 20) throw new Error('pack: truncated ref oid');
      refBase = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const { data, consumed } = inflateAt(pack, pos, size);
    pos += consumed;
    raw.push({ typeNum, data, ofsBase, refBase, offset: entryOffset });
  }

  const byOffset = new Map<number, RawEntry>();
  for (const e of raw) byOffset.set(e.offset, e);
  const objects = new Map<string, GitObject>();
  const resolved = new Map<number, GitObject>();

  const resolve = (entry: RawEntry, depth: number): GitObject => {
    if (depth > 64) throw new Error('pack: delta chain too deep');
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    let result: GitObject;
    if (entry.typeNum >= 1 && entry.typeNum <= 4) {
      result = { type: PACK_NUM_TYPE[entry.typeNum], data: entry.data };
    } else if (entry.typeNum === 6) {
      const baseEntry = byOffset.get(entry.ofsBase ?? -1);
      if (baseEntry === undefined) throw new Error('pack: ofs-delta base missing');
      const base = resolve(baseEntry, depth + 1);
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeNum === 7) {
      const base = objects.get(entry.refBase ?? '');
      if (base === undefined) throw new Error('pack: ref-delta base missing');
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      throw new Error(`pack: unknown type ${entry.typeNum}`);
    }
    resolved.set(entry.offset, result);
    objects.set(hashObject(result.type, result.data), result);
    return result;
  };
  for (const entry of raw) resolve(entry, 0);
  return objects;
}

/** All objects reachable from `tips` (commits, their trees/blobs, tags), following
 *  parents. `maxDepth` limits commit generations (0 = unlimited); returns the set
 *  plus the shallow boundary commits (commits whose parents were cut off). */
export function reachableObjects(
  store: Map<string, GitObject>,
  tips: string[],
  maxDepth: number,
): { objects: GitObject[]; shallow: string[] } {
  const seen = new Set<string>();
  const out: GitObject[] = [];
  const shallow: string[] = [];
  const visitObject = (oid: string): void => {
    if (seen.has(oid)) return;
    const obj = store.get(oid);
    if (obj === undefined) return;
    seen.add(oid);
    out.push(obj);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      const tree = store.get(info.tree);
      if (tree !== undefined) visitObject(info.tree);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) visitObject(e.oid);
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (m !== null) visitObject(m[1]);
    }
  };
  // Commit walk with depth limiting (depth = generations below the tip).
  const commitQueue: { oid: string; depth: number }[] = [];
  for (const tip of tips) {
    const obj = store.get(tip);
    if (obj === undefined) continue;
    if (obj.type === 'commit') commitQueue.push({ oid: tip, depth: 0 });
    else visitObject(tip);
  }
  const seenCommits = new Set<string>();
  while (commitQueue.length > 0) {
    const { oid, depth } = commitQueue.shift() as { oid: string; depth: number };
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    if (!seen.has(oid)) {
      seen.add(oid);
      out.push(obj);
    }
    const info = parseCommit(obj.data);
    visitObject(info.tree);
    if (maxDepth > 0 && depth + 1 >= maxDepth) {
      shallow.push(oid);
      continue;
    }
    for (const p of info.parents) commitQueue.push({ oid: p, depth: depth + 1 });
  }
  return { objects: out, shallow };
}

/** Whether `ancestor` is reachable from `oid` (or equal). */
export function isAncestor(store: Map<string, GitObject>, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const queue = [oid];
  while (queue.length > 0) {
    const cur = queue.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = store.get(cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    for (const p of info.parents) {
      if (p === ancestor) return true;
      queue.push(p);
    }
  }
  return false;
}

/** The merge-base of two commits (nearest common ancestor), or null. */
export function mergeBase(store: Map<string, GitObject>, a: string, b: string): string | null {
  const ancestorsOf = (start: string): Map<string, number> => {
    const dist = new Map<string, number>();
    const queue: { oid: string; d: number }[] = [{ oid: start, d: 0 }];
    while (queue.length > 0) {
      const { oid, d } = queue.shift() as { oid: string; d: number };
      if (dist.has(oid)) continue;
      dist.set(oid, d);
      const obj = store.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, d: d + 1 });
    }
    return dist;
  };
  const da = ancestorsOf(a);
  const db = ancestorsOf(b);
  let best: string | null = null;
  let bestSum = Infinity;
  for (const [oid, d] of da) {
    const d2 = db.get(oid);
    if (d2 === undefined) continue;
    if (d + d2 < bestSum) {
      bestSum = d + d2;
      best = oid;
    }
  }
  return best;
}

/** Flat file map of a tree (path -> {oid, mode}), recursing into subtrees. */
export function flattenTree(store: Map<string, GitObject>, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, pre: string): void => {
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = pre === '' ? e.name : `${pre}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}
