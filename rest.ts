// rest.ts — GitHub REST v3 surface (/api/v3). Pure routing + JSON shaping;
// the HTTP layer (auth, body parsing, request ids) lives in app.ts.

import {
  VIEWER,
  branchJson,
  commitJson,
  commentJson,
  err,
  issueJson,
  labelJson,
  pullJson,
  repoJson,
  userJson,
} from './store.ts';
import type { ForgeStore, Repo, StoreError } from './store.ts';
import { parseCommit, parseTree } from './git.ts';

export interface RestContext {
  store: ForgeStore;
  method: string;
  segments: string[];
  query: URLSearchParams;
  url: string;
  body: unknown;
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function fail(status: number, message: string): never {
  throw err(status, message);
}

function bodyObj(ctx: RestContext): Record<string, unknown> {
  if (ctx.body === undefined || ctx.body === null) return {};
  if (typeof ctx.body !== 'object' || Array.isArray(ctx.body)) fail(400, 'request body must be a JSON object');
  return ctx.body as Record<string, unknown>;
}

function strField(obj: Record<string, unknown>, name: string, required = false): string {
  const v = obj[name];
  if (v === undefined || v === null) {
    if (required) fail(422, `missing field: ${name}`);
    return '';
  }
  if (typeof v !== 'string') fail(422, `field ${name} must be a string`);
  return v;
}

function boolField(obj: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const v = obj[name];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') fail(422, `field ${name} must be a boolean`);
  return v;
}

function numField(obj: Record<string, unknown>, name: string): number {
  const v = obj[name];
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) fail(422, `field ${name} must be an integer`);
  return v;
}

/** Page/per_page + Link header (next/last/first/prev as applicable). */
function paginate<T>(ctx: RestContext, items: T[]): { page: T[]; link: string | null } {
  const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '1', 10);
  const pageNum = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const base = ctx.url.split('?')[0];
  const linkFor = (p: number): string => {
    const q = new URLSearchParams(ctx.query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${base}?${q.toString()}`;
  };
  const links: string[] = [];
  if (pageNum < totalPages) {
    links.push(`<${linkFor(pageNum + 1)}>; rel="next"`);
    links.push(`<${linkFor(totalPages)}>; rel="last"`);
  }
  if (pageNum > 1) {
    links.push(`<${linkFor(1)}>; rel="first"`);
    links.push(`<${linkFor(pageNum - 1)}>; rel="prev"`);
  }
  return { page, link: links.length ? links.join(', ') : null };
}

function withLink(result: RestResult, link: string | null): RestResult {
  if (link === null) return result;
  return { ...result, headers: { ...(result.headers ?? {}), Link: link } };
}

function needRepo(ctx: RestContext, owner: string, name: string): Repo {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) fail(404, 'Not Found');
  return repo;
}

function decodeSegments(segments: string[]): string[] {
  return segments.map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

export function handleRest(ctx: RestContext): RestResult {
  const { store, method } = ctx;
  const seg = decodeSegments(ctx.segments);

  try {
    // ---- API root and meta
    if (seg.length === 0) {
      if (method !== 'GET') fail(404, 'Not Found');
      return {
        status: 200,
        body: {
          current_user_url: 'https://api.github.com/user',
          current_user_authorizations_html_url: 'https://github.com/settings/applications',
          authorizations_url: 'https://api.github.com/authorizations',
          code_search_url: 'https://api.github.com/search/code?q={query}{&page,per_page,sort,order}',
          commit_search_url: 'https://api.github.com/search/commits?q={query}{&page,per_page,sort,order}',
          emails_url: 'https://api.github.com/user/emails',
          emojis_url: 'https://api.github.com/emojis',
          events_url: 'https://api.github.com/events',
          feeds_url: 'https://api.github.com/feeds',
          followers_url: 'https://api.github.com/users/{user}/followers',
          following_url: 'https://api.github.com/users/{user}/following{/other_user}',
          gists_url: 'https://api.github.com/gists{/gist_id}',
          hub_url: 'https://api.github.com/hub',
          issue_search_url: 'https://api.github.com/search/issues?q={query}{&page,per_page,sort,order}',
          issues_url: 'https://api.github.com/issues',
          keys_url: 'https://api.github.com/user/keys',
          label_search_url: 'https://api.github.com/search/labels?repository_id={repository_id}&q={query}{&page,per_page}',
          notifications_url: 'https://api.github.com/notifications',
          organization_url: 'https://api.github.com/orgs/{org}',
          public_gists_url: 'https://api.github.com/gists/public',
          rate_limit_url: 'https://api.github.com/rate_limit',
          repository_url: 'https://api.github.com/repos/{owner}/{repo}',
          repository_search_url: 'https://api.github.com/search/repositories?q={query}{&page,per_page,sort,order}',
          current_user_repositories_url: 'https://api.github.com/user/repos{?type,page,per_page,sort}',
          starred_url: 'https://api.github.com/user/starred{/owner}{/repo}',
          starred_gists_url: 'https://api.github.com/gists/starred',
          user_url: 'https://api.github.com/users/{user}',
          user_organizations_url: 'https://api.github.com/user/orgs',
          user_repositories_url: 'https://api.github.com/users/{user}/repos{?type,page,per_page,sort}',
          user_search_url: 'https://api.github.com/search/users?q={query}{&page,per_page,sort,order}',
        },
        headers: { 'X-OAuth-Scopes': 'repo, read:org', 'X-Accepted-OAuth-Scopes': 'repo, read:org' },
      };
    }
    if (seg.length === 1 && seg[0] === 'meta') {
      if (method !== 'GET') fail(404, 'Not Found');
      return {
        status: 200,
        body: {
          verifiable_password_authentication: true,
          ssh_key_fingerprints: {},
          ssh_keys: [],
          hooks: [],
          web: [],
          api: [],
          git: [],
          packages: [],
          pages: [],
          importer: [],
          actions: [],
          dependabot: [],
          installed_version: '1.0.0',
        },
      };
    }

    // ---- /user
    if (seg[0] === 'user') {
      if (seg.length === 1) {
        if (method !== 'GET') fail(404, 'Not Found');
        return { status: 200, body: userJson(VIEWER) };
      }
      if (seg.length === 2 && seg[1] === 'repos') {
        if (method === 'GET') {
          const repos = store.reposOf(VIEWER.login);
          const { page, link } = paginate(ctx, repos.map((r) => repoJson(r)));
          return withLink({ status: 200, body: page }, link);
        }
        if (method === 'POST') {
          const b = bodyObj(ctx);
          const name = strField(b, 'name', true);
          const description = strField(b, 'description');
          const isPrivate = boolField(b, 'private', false);
          try {
            const repo = store.createRepo(VIEWER.login, name, description, isPrivate);
            return { status: 201, body: repoJson(repo) };
          } catch (e) {
            if ((e as StoreError).status === 422) {
              return {
                status: 422,
                body: {
                  message: 'Repository creation failed.',
                  errors: [
                    {
                      resource: 'Repository',
                      code: 'custom',
                      field: 'name',
                      message: 'name already exists on this account',
                    },
                  ],
                },
              };
            }
            throw e;
          }
        }
        fail(404, 'Not Found');
      }
      fail(404, 'Not Found');
    }

    // ---- /repos/{owner}/{repo}/...
    if (seg[0] === 'repos' && seg.length >= 3) {
      const owner = seg[1];
      const repoName = seg[2];
      const rest = seg.slice(3);

      if (rest.length === 0) {
        if (method === 'GET') return { status: 200, body: repoJson(needRepo(ctx, owner, repoName)) };
        if (method === 'PATCH') {
          const repo = needRepo(ctx, owner, repoName);
          const b = bodyObj(ctx);
          if (b.description !== undefined) repo.description = strField(b, 'description');
          if (b.private !== undefined) repo.isPrivate = boolField(b, 'private', repo.isPrivate);
          repo.updatedAt = store.now();
          return { status: 200, body: repoJson(repo) };
        }
        if (method === 'DELETE') {
          if (!store.deleteRepo(owner, repoName)) fail(404, 'Not Found');
          return { status: 204, body: null };
        }
        fail(404, 'Not Found');
      }

      const repo = needRepo(ctx, owner, repoName);

      // branches
      if (rest[0] === 'branches') {
        if (rest.length === 1) {
          if (method !== 'GET') fail(404, 'Not Found');
          const branches = [...repo.refs.keys()]
            .filter((r) => r.startsWith('refs/heads/'))
            .map((r) => r.slice('refs/heads/'.length))
            .sort()
            .map((name) => branchJson(repo, name, repo.refs.get(`refs/heads/${name}`) as string));
          const { page, link } = paginate(ctx, branches);
          return withLink({ status: 200, body: page }, link);
        }
        if (rest.length === 2) {
          if (method !== 'GET') fail(404, 'Not Found');
          const sha = repo.refs.get(`refs/heads/${rest[1]}`);
          if (sha === undefined) fail(404, 'Branch not found');
          return { status: 200, body: branchJson(repo, rest[1], sha) };
        }
        fail(404, 'Not Found');
      }

      // commits
      if (rest[0] === 'commits') {
        if (method !== 'GET') fail(404, 'Not Found');
        if (rest.length === 1) {
          const branch = ctx.query.get('sha') ?? repo.defaultBranch;
          const tip = store.resolveRef(repo, branch);
          if (tip === null) return { status: 200, body: [] };
          const commits = store.listCommits(repo, tip).map((sha) => commitJson(store, repo, sha));
          const { page, link } = paginate(ctx, commits);
          return withLink({ status: 200, body: page }, link);
        }
        if (rest.length === 2) {
          const sha = rest[1];
          const obj = repo.objects.get(sha);
          if (obj === undefined || obj.type !== 'commit') fail(404, 'Not Found');
          return { status: 200, body: commitJson(store, repo, sha) };
        }
        fail(404, 'Not Found');
      }

      // git/refs
      if (rest[0] === 'git' && rest[1] === 'refs') {
        if (method === 'POST' && rest.length === 2) {
          const b = bodyObj(ctx);
          const ref = strField(b, 'ref', true);
          const sha = strField(b, 'sha', true);
          if (!ref.startsWith('refs/')) fail(422, 'ref must start with refs/');
          if (repo.refs.has(ref)) fail(422, 'Reference already exists');
          if (!repo.objects.has(sha)) fail(422, 'Object does not exist');
          repo.refs.set(ref, sha);
          const type = repo.objects.get(sha)?.type ?? 'commit';
          return {
            status: 201,
            body: {
              ref,
              node_id: '',
              url: `https://api.github.com/repos/${owner}/${repoName}/git/refs/${ref.slice(5)}`,
              object: {
                sha,
                type,
                url: `https://api.github.com/repos/${owner}/${repoName}/git/${type}s/${sha}`,
              },
            },
          };
        }
        if (method === 'GET' && rest.length > 2) {
          const refName = `refs/${rest.slice(2).join('/')}`;
          const sha = repo.refs.get(refName);
          if (sha === undefined) fail(404, 'Not Found');
          const type = repo.objects.get(sha)?.type ?? 'commit';
          return {
            status: 200,
            body: {
              ref: refName,
              node_id: '',
              url: `https://api.github.com/repos/${owner}/${repoName}/git/refs/${refName.slice(5)}`,
              object: {
                sha,
                type,
                url: `https://api.github.com/repos/${owner}/${repoName}/git/${type}s/${sha}`,
              },
            },
          };
        }
        fail(404, 'Not Found');
      }

      // contents
      if (rest[0] === 'contents') {
        const path = rest.slice(1).join('/');
        const branch = (bodyObj(ctx).branch as string | undefined) ?? ctx.query.get('ref') ?? repo.defaultBranch;
        if (method === 'GET') {
          const tip = store.headCommit(repo, branch);
          if (tip === null) fail(404, 'Not Found');
          const treeOid = parseCommit(repo.objects.get(tip)?.data as Buffer).tree;
          if (path === '') {
            const entries = dirListing(ctx, repo, treeOid, '');
            return { status: 200, body: entries };
          }
          const segments = path.split('/').filter((s) => s !== '');
          const oid = store.lookupPath(repo, treeOid, segments);
          if (oid !== null) {
            const obj = repo.objects.get(oid) as { type: string; data: Buffer };
            return {
              status: 200,
              body: {
                type: 'file',
                encoding: 'base64',
                size: obj.data.length,
                name: segments[segments.length - 1],
                path,
                content: obj.data.toString('base64'),
                sha: oid,
                url: `https://api.github.com/repos/${owner}/${repoName}/contents/${path}`,
                html_url: `https://github.com/${owner}/${repoName}/blob/${branch}/${path}`,
                git_url: `https://api.github.com/repos/${owner}/${repoName}/git/blobs/${oid}`,
                download_url: `https://raw.githubusercontent.com/${owner}/${repoName}/${branch}/${path}`,
              },
            };
          }
          // Maybe a directory.
          const dirOid = lookupDirOid(repo, treeOid, segments);
          if (dirOid !== null) {
            return { status: 200, body: dirListing(ctx, repo, dirOid, path) };
          }
          fail(404, 'Not Found');
        }
        if (method === 'PUT') {
          const b = bodyObj(ctx);
          const message = strField(b, 'message', true);
          const contentB64 = strField(b, 'content', true);
          let content: Buffer;
          try {
            content = Buffer.from(contentB64, 'base64');
          } catch {
            fail(422, 'content is not valid base64');
          }
          const sha = b.sha !== undefined ? strField(b, 'sha') : undefined;
          const putBranch = typeof b.branch === 'string' ? (b.branch as string) : branch;
          try {
            const { commit, blobOid, created } = store.putFile(repo, putBranch, path, content, message, sha);
            const name = path.split('/').pop() as string;
            return {
              status: created ? 201 : 200,
              body: {
                content: {
                  name,
                  path,
                  sha: blobOid,
                  size: content.length,
                  url: `https://api.github.com/repos/${owner}/${repoName}/contents/${path}`,
                  html_url: `https://github.com/${owner}/${repoName}/blob/${putBranch}/${path}`,
                  git_url: `https://api.github.com/repos/${owner}/${repoName}/git/blobs/${blobOid}`,
                  download_url: `https://raw.githubusercontent.com/${owner}/${repoName}/${putBranch}/${path}`,
                  type: 'file',
                  encoding: 'base64',
                },
                commit: { sha: commit, message, url: `https://api.github.com/repos/${owner}/${repoName}/commits/${commit}` },
              },
            };
          } catch (e) {
            if ((e as StoreError).status !== undefined) throw e;
            throw e;
          }
        }
        if (method === 'DELETE') {
          const b = bodyObj(ctx);
          const message = strField(b, 'message', true);
          const sha = b.sha !== undefined ? strField(b, 'sha') : undefined;
          const delBranch = typeof b.branch === 'string' ? (b.branch as string) : branch;
          const commit = store.deleteFile(repo, delBranch, path, message, sha);
          return { status: 200, body: { commit: { sha: commit, message } } };
        }
        fail(404, 'Not Found');
      }

      // labels
      if (rest[0] === 'labels') {
        if (rest.length === 1 && method === 'GET') {
          const { page, link } = paginate(ctx, repo.labels.map((l) => labelJson(l)));
          return withLink({ status: 200, body: page }, link);
        }
        if (rest.length === 1 && method === 'POST') {
          const b = bodyObj(ctx);
          const name = strField(b, 'name', true);
          const color = b.color !== undefined ? strField(b, 'color') : 'ededed';
          const description = b.description !== undefined ? strField(b, 'description') : '';
          try {
            const label = store.createLabel(repo, name, color, description);
            return { status: 201, body: labelJson(label) };
          } catch (e) {
            if ((e as StoreError).status === 422) {
              return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] } };
            }
            throw e;
          }
        }
        fail(404, 'Not Found');
      }

      // issues
      if (rest[0] === 'issues') {
        if (rest.length === 1) {
          if (method === 'GET') {
            const state = ctx.query.get('state') ?? 'open';
            const sort = ctx.query.get('sort') ?? 'created';
            const direction = ctx.query.get('direction') ?? 'desc';
            let list = repo.issues.filter((i) => state === 'all' || i.state === state);
            if (sort === 'created') {
              list = [...list].sort((a, b) =>
                direction === 'asc'
                  ? a.createdAt.localeCompare(b.createdAt) || a.number - b.number
                  : b.createdAt.localeCompare(a.createdAt) || b.number - a.number,
              );
            }
            const { page, link } = paginate(ctx, list.map((i) => issueJson(repo, i)));
            return withLink({ status: 200, body: page }, link);
          }
          if (method === 'POST') {
            const b = bodyObj(ctx);
            const title = strField(b, 'title', true);
            const bodyText = b.body !== undefined ? strField(b, 'body') : '';
            const labels = Array.isArray(b.labels)
              ? (b.labels as unknown[]).map((l) => {
                  if (typeof l === 'string') return l;
                  if (typeof l === 'object' && l !== null && typeof (l as Record<string, unknown>).name === 'string') {
                    return (l as Record<string, unknown>).name as string;
                  }
                  fail(422, 'labels must be strings');
                })
              : [];
            const issue = store.createIssue(repo, title, bodyText, labels);
            return { status: 201, body: issueJson(repo, issue) };
          }
          fail(404, 'Not Found');
        }
        const number = Number.parseInt(rest[1], 10);
        if (!Number.isSafeInteger(number)) fail(404, 'Not Found');
        const issue = store.getIssue(repo, number);
        if (issue === undefined) fail(404, 'Not Found');
        if (rest.length === 2) {
          if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
          if (method === 'PATCH') {
            const b = bodyObj(ctx);
            if (b.title !== undefined) issue.title = strField(b, 'title');
            if (b.body !== undefined) issue.body = strField(b, 'body');
            if (b.state !== undefined) {
              const state = strField(b, 'state');
              if (state !== 'open' && state !== 'closed') fail(422, 'state must be open or closed');
              issue.state = state;
              issue.closedAt = state === 'closed' ? store.now() : null;
            }
            if (b.labels !== undefined) {
              if (!Array.isArray(b.labels)) fail(422, 'labels must be an array');
              const names = (b.labels as unknown[]).map((l) => String(l));
              for (const n of names) {
                if (!repo.labels.some((l) => l.name === n)) fail(422, `unknown label: ${n}`);
              }
              issue.labels = names;
            }
            issue.updatedAt = store.now();
            return { status: 200, body: issueJson(repo, issue) };
          }
          fail(404, 'Not Found');
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (method === 'GET') {
            const { page, link } = paginate(ctx, issue.comments.map((c) => commentJson(repo, issue, c)));
            return withLink({ status: 200, body: page }, link);
          }
          if (method === 'POST') {
            const b = bodyObj(ctx);
            const bodyText = strField(b, 'body', true);
            const comment = store.addComment(repo, issue, bodyText);
            return { status: 201, body: commentJson(repo, issue, comment) };
          }
          fail(404, 'Not Found');
        }
        fail(404, 'Not Found');
      }

      // pulls
      if (rest[0] === 'pulls') {
        if (rest.length === 1) {
          if (method === 'GET') {
            const state = ctx.query.get('state') ?? 'open';
            const list = repo.pulls
              .filter((p) => state === 'all' || p.state === state)
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number);
            const { page, link } = paginate(ctx, list.map((p) => pullJson(store, repo, p)));
            return withLink({ status: 200, body: page }, link);
          }
          if (method === 'POST') {
            const b = bodyObj(ctx);
            const title = strField(b, 'title', true);
            const head = strField(b, 'head', true);
            const base = strField(b, 'base', true);
            const bodyText = b.body !== undefined ? strField(b, 'body') : '';
            const pull = store.createPull(repo, title, head, base, bodyText);
            return { status: 201, body: pullJson(store, repo, pull) };
          }
          fail(404, 'Not Found');
        }
        const number = Number.parseInt(rest[1], 10);
        if (!Number.isSafeInteger(number)) fail(404, 'Not Found');
        const pull = store.getPull(repo, number);
        if (pull === undefined) fail(404, 'Not Found');
        if (rest.length === 2) {
          if (method === 'GET') return { status: 200, body: pullJson(store, repo, pull) };
          if (method === 'PATCH') {
            const b = bodyObj(ctx);
            if (b.title !== undefined) pull.title = strField(b, 'title');
            if (b.body !== undefined) pull.body = strField(b, 'body');
            if (b.state !== undefined) {
              const state = strField(b, 'state');
              if (state !== 'open' && state !== 'closed') fail(422, 'state must be open or closed');
              pull.state = state;
              pull.closedAt = state === 'closed' ? store.now() : null;
            }
            pull.updatedAt = store.now();
            return { status: 200, body: pullJson(store, repo, pull) };
          }
          fail(404, 'Not Found');
        }
        if (rest.length === 3 && rest[2] === 'files') {
          if (method !== 'GET') fail(404, 'Not Found');
          return { status: 200, body: store.pullFiles(repo, pull) };
        }
        if (rest.length === 3 && rest[2] === 'merge') {
          if (method !== 'PUT') fail(404, 'Not Found');
          const b = bodyObj(ctx);
          const mergeMethod = b.merge_method !== undefined ? strField(b, 'merge_method') : 'merge';
          const sha = store.mergePull(repo, pull, mergeMethod);
          return {
            status: 200,
            body: { sha, merged: true, message: `Pull Request successfully merged` },
          };
        }
        fail(404, 'Not Found');
      }

      fail(404, 'Not Found');
    }

    fail(404, 'Not Found');
  } catch (e) {
    const se = e as StoreError;
    if (se !== null && typeof se === 'object' && typeof se.status === 'number') {
      return { status: se.status, body: { message: se.message } };
    }
    throw e;
  }
}

/** Directory listing entries for the tree at `treeOid` under `path`. */
function dirListing(ctx: RestContext, repo: Repo, treeOid: string, path: string): Record<string, unknown>[] {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return [];
  const entries = [];
  for (const e of parseTree(obj.data)) {
    const childPath = path === '' ? e.name : `${path}/${e.name}`;
    const isDir = e.mode === '40000';
    const size = isDir ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0);
    entries.push({
      type: isDir ? 'dir' : 'file',
      size,
      name: e.name,
      path: childPath,
      sha: e.oid,
      url: `https://api.github.com/repos/${repo.owner.login}/${repo.name}/contents/${childPath}`,
      html_url: `https://github.com/${repo.owner.login}/${repo.name}/tree/${repo.defaultBranch}/${childPath}`,
      git_url: `https://api.github.com/repos/${repo.owner.login}/${repo.name}/git/trees/${e.oid}`,
      download_url: isDir ? null : `https://raw.githubusercontent.com/${repo.owner.login}/${repo.name}/${repo.defaultBranch}/${childPath}`,
    });
  }
  return entries;
}

/** The tree oid of the directory at `segments` under `treeOid`, or null. */
function lookupDirOid(repo: Repo, treeOid: string, segments: string[]): string | null {
  let current = treeOid;
  for (const segment of segments) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segment && e.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}
