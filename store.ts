// store.ts — in-memory forge store: repos, git objects, issues, pulls, labels.
// Deterministic: every timestamp comes from a monotonic sequence counter, never
// the wall clock, so a replay produces byte-identical responses.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  flattenTree,
  hashObject,
  ident,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
} from './git.ts';
import type { GitObject, TreeEntry } from './git.ts';

// ---------------------------------------------------------------- identity
// The viewer identity comes from the kit's public, fixed scenario (the same
// for every trial): the token names this user.

export interface UserInfo {
  login: string;
  id: number;
  name: string;
  email: string;
  type: 'User' | 'Organization';
}

export const VIEWER: UserInfo = {
  login: 'adaiversen',
  id: 1000,
  name: 'Ada Iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
};

export const TEAMMATE: UserInfo = {
  login: 'quinnkeller',
  id: 1001,
  name: 'Quinn Keller',
  email: 'quinnkeller@example.invalid',
  type: 'User',
};

export const STRANGER: UserInfo = {
  login: 'olgabauer',
  id: 1002,
  name: 'Olga Bauer',
  email: 'olgabauer@example.invalid',
  type: 'User',
};

export const ORG: UserInfo = {
  login: 'faint-meadow-org',
  id: 2000,
  name: 'Faint Meadow Org',
  email: 'faint-meadow-org@example.invalid',
  type: 'Organization',
};

export const USERS: UserInfo[] = [VIEWER, TEAMMATE, STRANGER, ORG];

export function userByLogin(login: string): UserInfo | undefined {
  return USERS.find((u) => u.login === login);
}

// ---------------------------------------------------------------- global ids

export function gid(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function parseGid(id: string): { type: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx <= 0) return null;
    return { type: decoded.slice(0, idx), key: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- entities

export interface Label {
  id: number;
  nodeId: string;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  nodeId: string;
  body: string;
  user: UserInfo;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: UserInfo;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  user: UserInfo;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  id: number;
  nodeId: string;
  owner: UserInfo;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Label[];
  issues: Issue[];
  pulls: Pull[];
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
  labelSeq: number;
}

export type StoreError = { status: number; message: string };

export function err(status: number, message: string): StoreError {
  return { status, message };
}

// ---------------------------------------------------------------- line diff

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Added/deleted line counts between two texts (LCS DP, capped; heuristic beyond). */
export function diffLineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length > 500 || b.length > 500) {
    return {
      additions: Math.max(0, b.length - a.length),
      deletions: Math.max(0, a.length - b.length),
    };
  }
  // LCS length via DP over the shorter dimension.
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const lcs = dp[b.length];
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

// ---------------------------------------------------------------- store

const CLOCK_BASE_MS = Date.UTC(2020, 0, 1, 0, 0, 0);

export class ForgeStore {
  private seq = 0;
  private repoSeq = 0;
  private entitySeq = 0;
  private requestSeq = 0;
  readonly repos = new Map<string, Repo>();

  /** Next deterministic timestamp (ISO, one second per tick). */
  now(): string {
    this.seq += 1;
    return new Date(CLOCK_BASE_MS + this.seq * 1000).toISOString();
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  private nextEntityId(): number {
    this.entitySeq += 1;
    return this.entitySeq;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(ownerLogin: string, name: string, description = '', isPrivate = false): Repo {
    const owner = userByLogin(ownerLogin) ?? VIEWER;
    if (this.getRepo(owner.login, name) !== undefined) {
      throw err(422, 'name already exists on this account');
    }
    this.repoSeq += 1;
    const now = this.now();
    const repo: Repo = {
      id: this.repoSeq,
      nodeId: gid('Repository', `${owner.login}/${name}`),
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      pushedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: [],
      issues: [],
      pulls: [],
      issueSeq: 0,
      pullSeq: 0,
      commentSeq: 0,
      labelSeq: 0,
    };
    this.repos.set(this.repoKey(owner.login, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  reposOf(ownerLogin: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner.login === ownerLogin);
  }

  // ------------------------------------------------------------ git helpers

  /** Resolve a ref or a bare branch name to an oid, or null. */
  resolveRef(repo: Repo, refOrBranch: string): string | null {
    if (repo.refs.has(refOrBranch)) return repo.refs.get(refOrBranch) as string;
    const full = refOrBranch.startsWith('refs/') ? refOrBranch : `refs/heads/${refOrBranch}`;
    return repo.refs.get(full) ?? null;
  }

  headCommit(repo: Repo, branch?: string): string | null {
    const ref = branch === undefined ? `refs/heads/${repo.defaultBranch}` : `refs/heads/${branch}`;
    return repo.refs.get(ref) ?? null;
  }

  /** Commits reachable from `tip`, newest first (parents after children). */
  listCommits(repo: Repo, tip: string, limit = 1000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0 && out.length < limit) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      out.push(oid);
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    return out;
  }

  /** Set `path` (segments) to `blobOid` (or delete when null) in the tree at
   *  `treeOid` ('' for an empty tree). Returns the new tree oid. */
  setPathInTree(repo: Repo, treeOid: string, segments: string[], blobOid: string | null): string {
    const entries: TreeEntry[] =
      treeOid === '' ? [] : parseTree((repo.objects.get(treeOid)?.data ?? Buffer.alloc(0)) as Buffer);
    const [head, ...rest] = segments as [string, ...string[]];
    const kept = entries.filter((e) => e.name !== head);
    if (rest.length === 0) {
      if (blobOid !== null) kept.push({ mode: '100644', name: head, oid: blobOid });
    } else {
      const existing = entries.find((e) => e.name === head && e.mode === '40000');
      const childOid = existing === undefined ? '' : existing.oid;
      const newChild = this.setPathInTree(repo, childOid, rest, blobOid);
      const childEntries = newChild === '' ? [] : parseTree(repo.objects.get(newChild)?.data as Buffer);
      if (childEntries.length > 0) kept.push({ mode: '40000', name: head, oid: newChild });
    }
    if (kept.length === 0) return '';
    const data = buildTree(kept);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  }

  /** Look up a path in the tree at `treeOid`. Returns the blob oid or null. */
  lookupPath(repo: Repo, treeOid: string, segments: string[]): string | null {
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const obj = repo.objects.get(current);
      if (obj === undefined || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) {
        return entry.mode === '40000' ? null : entry.oid;
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** Commit `treeOid` on `branch` with `message`, parent = branch tip. */
  commitOnBranch(repo: Repo, branch: string, treeOid: string, message: string): string {
    const parent = this.headCommit(repo, branch);
    const ts = Math.floor(Date.parse(this.now()) / 1000);
    const who = ident(VIEWER.name, VIEWER.email, ts);
    const data = buildCommit({
      tree: treeOid,
      parents: parent === null ? [] : [parent],
      author: who,
      committer: who,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const oid = hashObject('commit', data);
    repo.objects.set(oid, { type: 'commit', data });
    repo.refs.set(`refs/heads/${branch}`, oid);
    repo.updatedAt = this.now();
    repo.pushedAt = repo.updatedAt;
    return oid;
  }

  // ------------------------------------------------------------ contents

  /** Write (create/update) a file at `path` on `branch`. Returns {commit, blobOid, created}. */
  putFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    expectedSha?: string,
  ): { commit: string; blobOid: string; created: boolean } {
    const segments = path.split('/').filter((s) => s !== '');
    if (segments.length === 0) throw err(422, 'path is empty');
    const tip = this.headCommit(repo, branch);
    const baseTree = tip === null ? '' : parseCommit(repo.objects.get(tip)?.data as Buffer).tree;
    const existing = tip === null ? null : this.lookupPath(repo, baseTree, segments);
    if (existing !== null && expectedSha !== undefined && expectedSha !== existing) {
      throw err(409, 'sha does not match the current file');
    }
    if (existing === null && expectedSha !== undefined) {
      throw err(404, 'file does not exist');
    }
    const blobOid = hashObject('blob', content);
    repo.objects.set(blobOid, { type: 'blob', data: content });
    const newTree = this.setPathInTree(repo, baseTree, segments, blobOid);
    const commit = this.commitOnBranch(repo, branch, newTree, message);
    return { commit, blobOid, created: existing === null };
  }

  deleteFile(repo: Repo, branch: string, path: string, message: string, expectedSha?: string): string {
    const segments = path.split('/').filter((s) => s !== '');
    const tip = this.headCommit(repo, branch);
    if (tip === null) throw err(404, 'file does not exist');
    const baseTree = parseCommit(repo.objects.get(tip)?.data as Buffer).tree;
    const existing = this.lookupPath(repo, baseTree, segments);
    if (existing === null) throw err(404, 'file does not exist');
    if (expectedSha !== undefined && expectedSha !== existing) throw err(409, 'sha does not match the current file');
    const newTree = this.setPathInTree(repo, baseTree, segments, null);
    return this.commitOnBranch(repo, branch, newTree, message);
  }

  // ------------------------------------------------------------ labels

  createLabel(repo: Repo, name: string, color = 'ededed', description = ''): Label {
    if (repo.labels.some((l) => l.name === name)) throw err(422, 'label already exists');
    repo.labelSeq += 1;
    const label: Label = {
      id: this.nextEntityId(),
      nodeId: gid('Label', `${repo.owner.login}/${repo.name}/${name}`),
      name,
      color: color.replace(/^#/, ''),
      description,
    };
    repo.labels.push(label);
    return label;
  }

  // ------------------------------------------------------------ issues

  createIssue(repo: Repo, title: string, body = '', labels: string[] = []): Issue {
    for (const name of labels) {
      if (!repo.labels.some((l) => l.name === name)) throw err(422, `unknown label: ${name}`);
    }
    repo.issueSeq += 1;
    const now = this.now();
    const issue: Issue = {
      id: this.nextEntityId(),
      nodeId: gid('Issue', `${repo.owner.login}/${repo.name}/${repo.issueSeq}`),
      number: repo.issueSeq,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user: VIEWER,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((i) => i.number === number);
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    repo.commentSeq += 1;
    const now = this.now();
    const comment: IssueComment = {
      id: this.nextEntityId(),
      nodeId: gid('IssueComment', `${repo.owner.login}/${repo.name}/${issue.number}/${repo.commentSeq}`),
      body,
      user: VIEWER,
      createdAt: now,
      updatedAt: now,
    };
    issue.comments.push(comment);
    return comment;
  }

  // ------------------------------------------------------------ pulls

  createPull(repo: Repo, title: string, headRef: string, baseRef: string, body = ''): Pull {
    const headSha = this.resolveRef(repo, headRef);
    const baseSha = this.resolveRef(repo, baseRef);
    if (headSha === null) throw err(422, `unknown head ref: ${headRef}`);
    if (baseSha === null) throw err(422, `unknown base ref: ${baseRef}`);
    repo.pullSeq += 1;
    const now = this.now();
    const pull: Pull = {
      id: this.nextEntityId(),
      nodeId: gid('PullRequest', `${repo.owner.login}/${repo.name}/${repo.pullSeq}`),
      number: repo.pullSeq,
      title,
      body,
      state: 'open',
      headRef: headRef.replace(/^refs\/heads\//, ''),
      headSha,
      baseRef: baseRef.replace(/^refs\/heads\//, ''),
      baseSha,
      user: VIEWER,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.pullSeq = repo.pullSeq; // keep explicit
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((p) => p.number === number);
  }

  /** 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' for a pull request. */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const head = this.resolveRef(repo, pull.headRef);
    const base = this.resolveRef(repo, pull.baseRef);
    if (head === null || base === null) return 'UNKNOWN';
    if (head === base) return 'MERGEABLE';
    const mb = mergeBase(repo.objects, head, base);
    if (mb === null) return 'CONFLICTING';
    const baseTree = parseCommit(repo.objects.get(mb)?.data as Buffer).tree;
    const headTree = parseCommit(repo.objects.get(head)?.data as Buffer).tree;
    const baseTipTree = parseCommit(repo.objects.get(base)?.data as Buffer).tree;
    const baseFiles = flattenTree(repo.objects, baseTree);
    const headFiles = flattenTree(repo.objects, headTree);
    const baseTipFiles = flattenTree(repo.objects, baseTipTree);
    const paths = new Set([...headFiles.keys(), ...baseTipFiles.keys(), ...baseFiles.keys()]);
    for (const path of paths) {
      const fromBase = baseFiles.get(path)?.oid ?? null;
      const atHead = headFiles.get(path)?.oid ?? null;
      const atBaseTip = baseTipFiles.get(path)?.oid ?? null;
      const headChanged = atHead !== fromBase;
      const baseChanged = atBaseTip !== fromBase;
      if (headChanged && baseChanged && atHead !== atBaseTip) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /** Files changed between the pull's base tip and head tip. */
  pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const head = this.resolveRef(repo, pull.headRef) ?? pull.headSha;
    const base = this.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
    const headObj = repo.objects.get(head);
    const baseObj = repo.objects.get(base);
    if (headObj === undefined || baseObj === undefined) return [];
    const headTree = parseCommit(headObj.data).tree;
    const baseTree = parseCommit(baseObj.data).tree;
    const headFiles = flattenTree(repo.objects, headTree);
    const baseFiles = flattenTree(repo.objects, baseTree);
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    const paths = [...new Set([...headFiles.keys(), ...baseFiles.keys()])].sort();
    for (const path of paths) {
      const h = headFiles.get(path);
      const b = baseFiles.get(path);
      if (h !== undefined && b === undefined) {
        const text = (repo.objects.get(h.oid)?.data ?? Buffer.alloc(0)).toString('utf8');
        const lines = splitLines(text).length;
        out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (h === undefined && b !== undefined) {
        const text = (repo.objects.get(b.oid)?.data ?? Buffer.alloc(0)).toString('utf8');
        const lines = splitLines(text).length;
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (h !== undefined && b !== undefined && h.oid !== b.oid) {
        const oldText = (repo.objects.get(b.oid)?.data ?? Buffer.alloc(0)).toString('utf8');
        const newText = (repo.objects.get(h.oid)?.data ?? Buffer.alloc(0)).toString('utf8');
        const { additions, deletions } = diffLineCounts(oldText, newText);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit sha. */
  mergePull(repo: Repo, pull: Pull, method: string): string {
    if (pull.state !== 'open') throw err(405, 'pull request is not open');
    const head = this.resolveRef(repo, pull.headRef);
    const base = this.resolveRef(repo, pull.baseRef);
    if (head === null || base === null) throw err(409, 'head or base ref is missing');
    if (this.pullMergeable(repo, pull) === 'CONFLICTING') throw err(405, 'merge conflict');
    const headObj = repo.objects.get(head) as GitObject;
    const headTree = parseCommit(headObj.data).tree;
    const ts = Math.floor(Date.parse(this.now()) / 1000);
    const who = ident(VIEWER.name, VIEWER.email, ts);
    const message = method === 'squash' ? `${pull.title} (#${pull.number})\n` : `${pull.title}\n`;
    const data = buildCommit({
      tree: headTree,
      parents: [base],
      author: who,
      committer: who,
      message,
    });
    const sha = hashObject('commit', data);
    repo.objects.set(sha, { type: 'commit', data });
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    const now = this.now();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = now;
    pull.mergeCommitSha = sha;
    pull.closedAt = now;
    pull.updatedAt = now;
    repo.updatedAt = now;
    repo.pushedAt = now;
    return sha;
  }
}

// ---------------------------------------------------------------- serializers

export function userJson(u: UserInfo): Record<string, unknown> {
  return {
    login: u.login,
    id: u.id,
    node_id: gid('User', u.login),
    avatar_url: `https://example.invalid/avatar/${u.login}`,
    gravatar_id: '',
    url: `https://api.github.com/users/${u.login}`,
    html_url: `https://github.com/${u.login}`,
    type: u.type,
    site_admin: false,
    name: u.name,
    email: u.email,
  };
}

export function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id,
    node_id: r.nodeId,
    name: r.name,
    full_name: `${r.owner.login}/${r.name}`,
    owner: userJson(r.owner),
    private: r.isPrivate,
    html_url: `https://github.com/${r.owner.login}/${r.name}`,
    description: r.description,
    fork: false,
    url: `https://api.github.com/repos/${r.owner.login}/${r.name}`,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    pushed_at: r.pushedAt,
    git_url: `git://github.com/${r.owner.login}/${r.name}.git`,
    ssh_url: `git@github.com:${r.owner.login}/${r.name}.git`,
    clone_url: `https://github.com/${r.owner.login}/${r.name}.git`,
    homepage: null,
    size: r.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: r.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: r.isPrivate ? 'private' : 'public',
    default_branch: r.defaultBranch,
  };
}

export function labelJson(l: Label): Record<string, unknown> {
  return {
    id: l.id,
    node_id: l.nodeId,
    url: '',
    name: l.name,
    color: l.color,
    default: false,
    description: l.description,
  };
}

export function issueJson(r: Repo, i: Issue): Record<string, unknown> {
  return {
    id: i.id,
    node_id: i.nodeId,
    url: `https://api.github.com/repos/${r.owner.login}/${r.name}/issues/${i.number}`,
    repository_url: `https://api.github.com/repos/${r.owner.login}/${r.name}`,
    html_url: `https://github.com/${r.owner.login}/${r.name}/issues/${i.number}`,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    locked: false,
    user: userJson(i.user),
    labels: i.labels.map((name) => {
      const found = r.labels.find((l) => l.name === name);
      return found !== undefined ? labelJson(found) : { name, color: 'ededed', description: '' };
    }),
    assignee: null,
    assignees: [],
    comments: i.comments.length,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    closed_at: i.closedAt,
    author_association: 'OWNER',
  };
}

export function commentJson(r: Repo, issue: Issue, c: IssueComment): Record<string, unknown> {
  return {
    id: c.id,
    node_id: c.nodeId,
    url: `https://api.github.com/repos/${r.owner.login}/${r.name}/issues/${issue.number}/comments/${c.id}`,
    html_url: `https://github.com/${r.owner.login}/${r.name}/issues/${issue.number}#issuecomment-${c.id}`,
    body: c.body,
    user: userJson(c.user),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    author_association: 'OWNER',
  };
}

export function pullJson(store: ForgeStore, r: Repo, p: Pull): Record<string, unknown> {
  const headSha = store.resolveRef(r, p.headRef) ?? p.headSha;
  const baseSha = store.resolveRef(r, p.baseRef) ?? p.baseSha;
  return {
    id: p.id,
    node_id: p.nodeId,
    url: `https://api.github.com/repos/${r.owner.login}/${r.name}/pulls/${p.number}`,
    html_url: `https://github.com/${r.owner.login}/${r.name}/pull/${p.number}`,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    locked: false,
    user: userJson(p.user),
    labels: [],
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    closed_at: p.closedAt,
    merged_at: p.mergedAt,
    merge_commit_sha: p.mergeCommitSha,
    merged: p.merged,
    mergeable: store.pullMergeable(r, p) === 'MERGEABLE',
    mergeable_state: store.pullMergeable(r, p) === 'MERGEABLE' ? 'clean' : 'dirty',
    head: {
      label: `${r.owner.login}:${p.headRef}`,
      ref: p.headRef,
      sha: headSha,
      user: userJson(r.owner),
      repo: repoJson(r),
    },
    base: {
      label: `${r.owner.login}:${p.baseRef}`,
      ref: p.baseRef,
      sha: baseSha,
      user: userJson(r.owner),
      repo: repoJson(r),
    },
    author_association: 'OWNER',
    draft: false,
  };
}

export function branchJson(r: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: {
      sha,
      url: `https://api.github.com/repos/${r.owner.login}/${r.name}/commits/${sha}`,
    },
    protected: false,
  };
}

export function commitJson(store: ForgeStore, r: Repo, sha: string): Record<string, unknown> {
  const obj = r.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return { sha };
  const info = parseCommit(obj.data);
  const authorLine = info.author;
  const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(authorLine);
  const name = m !== null ? m[1] : VIEWER.name;
  const email = m !== null ? m[2] : VIEWER.email;
  const date = m !== null ? new Date(Number(m[3]) * 1000).toISOString() : r.createdAt;
  return {
    sha,
    node_id: gid('Commit', `${r.owner.login}/${r.name}/${sha}`),
    commit: {
      author: { name, email, date },
      committer: { name, email, date },
      message: info.message.replace(/\n$/, ''),
      tree: { sha: info.tree, url: `https://api.github.com/repos/${r.owner.login}/${r.name}/git/trees/${info.tree}` },
      url: `https://api.github.com/repos/${r.owner.login}/${r.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `https://api.github.com/repos/${r.owner.login}/${r.name}/commits/${sha}`,
    html_url: `https://github.com/${r.owner.login}/${r.name}/commit/${sha}`,
    author: userJson(VIEWER),
    committer: userJson(VIEWER),
    parents: info.parents.map((p) => ({
      sha: p,
      url: `https://api.github.com/repos/${r.owner.login}/${r.name}/commits/${p}`,
      html_url: `https://github.com/${r.owner.login}/${r.name}/commit/${p}`,
    })),
  };
}

export { ZERO_OID };
