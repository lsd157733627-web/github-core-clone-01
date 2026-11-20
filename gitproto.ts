// gitproto.ts — git smart HTTP: info/refs advertisements, upload-pack (v2/v0),
// receive-pack (v0). Written from the protocol as the kit's client speaks it.

import {
  DELIM,
  FLUSH,
  ZERO_OID,
  hashObject,
  isAncestor,
  parseCommit,
  parsePktLines,
  parseTree,
  pktLine,
  readPack,
  reachableObjects,
  sidebandFrame,
  writePack,
} from './git.ts';
import type { GitObject } from './git.ts';
import type { ForgeStore, Repo } from './store.ts';

const AGENT = 'github-core-clone/1.0.0';
const SIDEBAND_MAX = 65515; // side-band-64k: 65520-byte pkt-line minus 4 header bytes minus the band byte

export interface HttpResult {
  status: number;
  body: Buffer;
  contentType: string;
}

function notFound(message = 'Not Found'): HttpResult {
  return { status: 404, body: Buffer.from(JSON.stringify({ message }), 'utf8'), contentType: 'application/json' };
}

function getRepoOr404(store: ForgeStore, owner: string, name: string): Repo | HttpResult {
  const repo = store.getRepo(owner, name);
  return repo === undefined ? notFound('Repository not found') : repo;
}

interface RefLine {
  name: string;
  oid: string;
}

/** All refs of a repo, sorted: heads first, then tags, each alphabetical. */
function sortedRefs(repo: Repo): RefLine[] {
  const refs: RefLine[] = [];
  for (const [name, oid] of repo.refs) refs.push({ name, oid });
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** The commit an annotated tag points at (or the tag oid itself when not a tag). */
function peelTag(repo: Repo, tagOid: string): string {
  const obj = repo.objects.get(tagOid);
  if (obj === undefined || obj.type !== 'tag') return tagOid;
  const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
  return m !== null ? m[1] : tagOid;
}

// ---------------------------------------------------------------- info/refs

export function handleInfoRefs(store: ForgeStore, owner: string, name: string, service: string): HttpResult {
  const repoOrErr = getRepoOr404(store, owner, name);
  if (!('refs' in repoOrErr)) return repoOrErr;
  const repo = repoOrErr;
  const refs = sortedRefs(repo);
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;

  if (service === 'git-upload-pack') {
    // Protocol v2 advertisement.
    const parts: Buffer[] = [
      pktLine('# service=git-upload-pack\n'),
      FLUSH,
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('fetch=shallow\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('object-format=sha1\n'),
      FLUSH,
    ];
    return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-advertisement' };
  }
  if (service === 'git-receive-pack') {
    // Protocol v0 advertisement: HEAD first, carrying the capabilities.
    const caps = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
    const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH];
    const headOid = mainTip ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    parts.push(FLUSH);
    return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-receive-pack-advertisement' };
  }
  return { status: 400, body: Buffer.from(JSON.stringify({ message: 'unknown service' }), 'utf8'), contentType: 'application/json' };
}

// ---------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
}

function parseFetchArgs(lines: (Buffer | null)[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null };
  for (const line of lines) {
    if (line === null) continue;
    const text = line.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    } else if (text.startsWith('filter ')) args.filter = text.slice(7).trim();
  }
  return args;
}

/** Objects the client already holds: the closure of `haves`, stopping at the
 *  shallow boundaries (the client holds those commits but not their parents). */
function haveClosure(repo: Repo, haves: string[], stopAt: Set<string>): Set<string> {
  const held = new Set<string>();
  const visitObject = (oid: string): void => {
    if (held.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj === undefined) return;
    held.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      visitObject(info.tree);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) visitObject(e.oid);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m !== null) visitObject(m[1]);
    }
  };
  const queue: string[] = [];
  for (const have of haves) {
    const obj = repo.objects.get(have);
    if (obj === undefined) continue;
    if (obj.type === 'commit') queue.push(have);
    else visitObject(have);
  }
  const seenCommits = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    if (!held.has(oid)) {
      held.add(oid);
      visitObject(parseCommit(obj.data).tree);
    }
    if (stopAt.has(oid)) continue; // shallow on the client: parents not held
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return held;
}

function chunkSideband(pack: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  for (let off = 0; off < pack.length; off += SIDEBAND_MAX) {
    frames.push(sidebandFrame(1, pack.subarray(off, Math.min(off + SIDEBAND_MAX, pack.length))));
  }
  if (frames.length === 0) frames.push(sidebandFrame(1, Buffer.alloc(0)));
  return frames;
}

export function handleUploadPack(store: ForgeStore, owner: string, name: string, body: Buffer): HttpResult {
  const repoOrErr = getRepoOr404(store, owner, name);
  if (!('refs' in repoOrErr)) return repoOrErr;
  const repo = repoOrErr;
  let lines: (Buffer | null)[];
  try {
    lines = parsePktLines(body).lines;
  } catch {
    // A malformed pkt-line stream is a bad request, not a crash: answer 400
    // and stay healthy for the next request.
    return { status: 400, body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line stream' }), 'utf8'), contentType: 'application/json' };
  }
  const first = lines[0];
  const firstText = first === null ? '' : first.toString('utf8');

  // ---------------------------------------------------------- v2 commands
  if (firstText.startsWith('command=')) {
    const command = firstText.slice(8).trim();
    if (command === 'ls-refs') {
      let peel = false;
      let symrefs = false;
      const prefixes: string[] = [];
      for (const line of lines) {
        if (line === null) continue;
        const text = line.toString('utf8').replace(/\n$/, '');
        if (text === 'peel') peel = true;
        else if (text === 'symrefs') symrefs = true;
        else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice(11));
      }
      const keep = (refName: string): boolean =>
        prefixes.length === 0 || prefixes.some((p) => refName.startsWith(p));
      const out: Buffer[] = [];
      const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
      if (keep('HEAD')) {
        if (mainTip !== null) {
          out.push(
            pktLine(
              `${mainTip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`,
            ),
          );
        } else {
          out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
        }
      }
      for (const ref of sortedRefs(repo)) {
        if (!keep(ref.name)) continue;
        let line = `${ref.oid} ${ref.name}`;
        if (peel && ref.name.startsWith('refs/tags/')) {
          const peeled = peelTag(repo, ref.oid);
          if (peeled !== ref.oid) line += ` peeled:${peeled}`;
        }
        out.push(pktLine(`${line}\n`));
      }
      out.push(FLUSH);
      return { status: 200, body: Buffer.concat(out), contentType: 'application/x-git-upload-pack-result' };
    }
    if (command === 'fetch') {
      const args = parseFetchArgs(lines);
      const stopAt = new Set(args.shallow);
      const wanted = reachableObjects(repo.objects, args.wants, args.depth ?? 0);
      const held = haveClosure(repo, args.haves, stopAt);
      const sendOids = wanted.objects
        .map((o) => hashObject(o.type, o.data))
        .filter((oid) => !held.has(oid));
      const sendObjects: GitObject[] = [];
      const seen = new Set<string>();
      for (const oid of sendOids) {
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = repo.objects.get(oid);
        if (obj !== undefined) sendObjects.push(obj);
      }
      const pack = writePack(sendObjects);
      const acks = args.haves.filter((h) => repo.objects.has(h));
      const out: Buffer[] = [];
      out.push(pktLine('acknowledgments\n'));
      if (acks.length === 0) out.push(pktLine('NAK\n'));
      else for (const ack of acks) out.push(pktLine(`ACK ${ack}\n`));
      out.push(FLUSH);
      out.push(pktLine('shallow-info\n'));
      const newShallow = wanted.shallow;
      for (const oid of newShallow) out.push(pktLine(`shallow ${oid}\n`));
      const included = new Set(wanted.objects.map((o) => hashObject(o.type, o.data)));
      for (const oid of args.shallow) {
        if (included.has(oid) && !newShallow.includes(oid)) out.push(pktLine(`unshallow ${oid}\n`));
      }
      out.push(FLUSH);
      out.push(pktLine('wanted-refs\n'));
      for (const want of args.wants) {
        for (const ref of sortedRefs(repo)) {
          if (ref.oid === want) out.push(pktLine(`${ref.oid} ${ref.name}\n`));
        }
      }
      out.push(FLUSH);
      out.push(pktLine('packfile\n'));
      for (const frame of chunkSideband(pack)) out.push(frame);
      out.push(FLUSH);
      return { status: 200, body: Buffer.concat(out), contentType: 'application/x-git-upload-pack-result' };
    }
    return { status: 400, body: Buffer.from(JSON.stringify({ message: `unknown command ${command}` }), 'utf8'), contentType: 'application/json' };
  }

  // ---------------------------------------------------------- v0 fetch
  const args = parseFetchArgs(lines);
  let sideband = false;
  for (const line of lines) {
    if (line === null) continue;
    const text = line.toString('utf8');
    if (text.includes('side-band-64k')) sideband = true;
  }
  const stopAt = new Set(args.shallow);
  const wanted = reachableObjects(repo.objects, args.wants, args.depth ?? 0);
  const held = haveClosure(repo, args.haves, stopAt);
  const sendObjects = wanted.objects.filter((o) => !held.has(hashObject(o.type, o.data)));
  const pack = writePack(sendObjects);
  const out: Buffer[] = [];
  const acks = args.haves.filter((h) => repo.objects.has(h));
  if (acks.length === 0) out.push(pktLine('NAK\n'));
  else for (const ack of acks) out.push(pktLine(`ACK ${ack}\n`));
  for (const oid of wanted.shallow) out.push(pktLine(`shallow ${oid}\n`));
  if (sideband) {
    for (const frame of chunkSideband(pack)) out.push(frame);
  } else {
    out.push(pack);
  }
  return { status: 200, body: Buffer.concat(out), contentType: 'application/x-git-upload-pack-result' };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: ForgeStore, owner: string, name: string, body: Buffer): HttpResult {
  const repoOrErr = getRepoOr404(store, owner, name);
  if (!('refs' in repoOrErr)) return repoOrErr;
  const repo = repoOrErr;

  // Split the command pkt-lines from the pack: the first flush pkt-line ends
  // them, and the pack bytes that follow are raw (not pkt-lines), so a plain
  // pkt-line parse would choke on them.
  const commands: PushCommand[] = [];
  let wantSideband = false;
  let pos = 0;
  let packBytes = Buffer.alloc(0);
  while (pos + 4 <= body.length) {
    const hex = body.subarray(pos, pos + 4).toString('utf8');
    if (hex === '0000') {
      packBytes = body.subarray(pos + 4);
      break;
    }
    const len = parseInt(hex, 16);
    if (Number.isNaN(len) || len < 4 || pos + len > body.length) break;
    let text = body.subarray(pos + 4, pos + len).toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      const caps = text.slice(nul + 1);
      if (caps.includes('side-band-64k')) wantSideband = true;
      text = text.slice(0, nul);
    }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(text);
    if (m !== null) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
    pos += len;
  }

  const report = (text: string): HttpResult => {
    const payload = Buffer.from(text, 'utf8');
    const parts: Buffer[] = [];
    if (wantSideband) {
      for (let off = 0; off < payload.length; off += SIDEBAND_MAX) {
        parts.push(sidebandFrame(1, payload.subarray(off, Math.min(off + SIDEBAND_MAX, payload.length))));
      }
    } else {
      parts.push(pktLine(payload));
    }
    parts.push(FLUSH);
    return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-receive-pack-result' };
  };

  if (commands.length === 0) {
    return report('unpack ok\n');
  }

  // Unpack: store every object, even for refs that end up refused.
  if (packBytes.length > 0) {
    let objects: Map<string, GitObject>;
    try {
      objects = readPack(packBytes);
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'unpack failed';
      return report(`unpack ${detail}\n`);
    }
    for (const [oid, obj] of objects) repo.objects.set(oid, obj);
  }

  const results: string[] = ['unpack ok'];
  let changed = false;
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref) ?? null;
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === null) {
        results.push(`ng ${cmd.ref} remote ref does not exist`);
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        results.push(`ng ${cmd.ref} non-fast-forward`);
      } else {
        repo.refs.delete(cmd.ref);
        changed = true;
        results.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      results.push(`ng ${cmd.ref} object not found`);
      continue;
    }
    if (current === null) {
      if (cmd.oldOid !== ZERO_OID) {
        results.push(`ng ${cmd.ref} non-fast-forward`);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        changed = true;
        results.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (cmd.oldOid !== current || !isAncestor(repo.objects, current, cmd.newOid)) {
      results.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    changed = true;
    results.push(`ok ${cmd.ref}`);
  }
  if (changed) {
    const now = store.now();
    repo.updatedAt = now;
    repo.pushedAt = now;
  }
  return report(`${results.join('\n')}\n`);
}
