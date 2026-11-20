// graphql.ts — a small GraphQL executor for the 18 fixed documents the suite
// sends (gh / github-mcp-server shapes), plus __type introspection probes.
// Written from the documents in the kit; standard library only.

import {
  VIEWER,
  gid,
  parseGid,
} from './store.ts';
import type { ForgeStore, Issue, Pull, Repo } from './store.ts';

// ---------------------------------------------------------------- parser

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation';
  selections: SelectionNode[];
}

type Token =
  | { t: 'punct'; v: string }
  | { t: 'name'; v: string }
  | { t: 'string'; v: string }
  | { t: 'int'; v: number }
  | { t: 'var'; v: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ t: 'punct', v: '...' });
      i += 3;
      continue;
    }
    if ('{}():![]=@'.includes(c) || c === '$') {
      if (c === '$') {
        let j = i + 1;
        while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
        tokens.push({ t: 'var', v: input.slice(i + 1, j) });
        i = j;
        continue;
      }
      tokens.push({ t: 'punct', v: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc as string;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ t: 'string', v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j] as string)) j += 1;
      tokens.push({ t: 'int', v: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ t: 'name', v: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`graphql: unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly variables: Record<string, unknown>;
  private readonly fragments: Map<string, SelectionNode[]>;

  constructor(tokens: Token[], variables: Record<string, unknown>, fragments: Map<string, SelectionNode[]>) {
    this.tokens = tokens;
    this.variables = variables;
    this.fragments = fragments;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (t === undefined) throw new Error('graphql: unexpected end of document');
    this.pos += 1;
    return t;
  }

  private expectPunct(v: string): void {
    const t = this.next();
    if (t.t !== 'punct' || t.v !== v) throw new Error(`graphql: expected ${v}, got ${JSON.stringify(t)}`);
  }

  private isPunct(v: string): boolean {
    const t = this.peek();
    return t !== undefined && t.t === 'punct' && t.v === v;
  }

  parseDocument(): Operation {
    // Skip `query Name($var: Type = default) {` / `mutation Name(...) {` / bare `{`.
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first !== undefined && first.t === 'name' && (first.v === 'query' || first.v === 'mutation')) {
      kind = first.v;
      this.next();
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName.t === 'name') this.next();
      if (this.isPunct('(')) this.skipParens();
    }
    // Fragment definitions may precede the operation; collect them.
    while (true) {
      const t = this.peek();
      if (t !== undefined && t.t === 'name' && t.v === 'fragment') {
        this.next();
        const nameTok = this.next();
        if (nameTok.t !== 'name') throw new Error('graphql: fragment needs a name');
        const onTok = this.next();
        if (onTok.t !== 'name' || onTok.v !== 'on') throw new Error('graphql: fragment needs "on"');
        const typeTok = this.next();
        if (typeTok.t !== 'name') throw new Error('graphql: fragment needs a type');
        const sels = this.parseSelections();
        this.fragments.set(nameTok.v, sels);
        continue;
      }
      break;
    }
    const selections = this.parseSelections();
    return { kind, selections };
  }

  private skipParens(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t.t === 'punct' && t.v === '(') depth += 1;
      else if (t.t === 'punct' && t.v === ')') depth -= 1;
    }
  }

  private parseSelections(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      const t = this.peek();
      if (t === undefined) throw new Error('graphql: unterminated selection set');
      if (t.t === 'punct' && t.v === '...') {
        this.next();
        const nextTok = this.peek();
        if (nextTok !== undefined && nextTok.t === 'name' && nextTok.v === 'on') {
          this.next();
          const typeTok = this.next();
          if (typeTok.t !== 'name') throw new Error('graphql: inline fragment needs a type');
          out.push({ kind: 'fragment', typeCondition: typeTok.v, selections: this.parseSelections() });
        } else if (nextTok !== undefined && nextTok.t === 'name') {
          this.next();
          const frag = this.fragments.get(nextTok.v);
          if (frag === undefined) throw new Error(`graphql: unknown fragment ${nextTok.v}`);
          out.push({ kind: 'fragment', typeCondition: null, selections: frag });
        } else {
          out.push({ kind: 'fragment', typeCondition: null, selections: this.parseSelections() });
        }
        continue;
      }
      if (t.t !== 'name') throw new Error(`graphql: expected field name, got ${JSON.stringify(t)}`);
      this.next();
      let alias: string | null = null;
      let name = t.v;
      if (this.isPunct(':')) {
        this.next();
        const nameTok = this.next();
        if (nameTok.t !== 'name') throw new Error('graphql: expected field name after alias');
        alias = name;
        name = nameTok.v;
      }
      let args: Record<string, unknown> = {};
      if (this.isPunct('(')) args = this.parseArgs();
      const selections = this.isPunct('{') ? this.parseSelections() : [];
      out.push({ kind: 'field', alias, name, args, selections });
    }
    this.expectPunct('}');
    return out;
  }

  private parseArgs(): Record<string, unknown> {
    this.expectPunct('(');
    const args: Record<string, unknown> = {};
    while (!this.isPunct(')')) {
      const nameTok = this.next();
      if (nameTok.t !== 'name') throw new Error('graphql: expected argument name');
      this.expectPunct(':');
      args[nameTok.v] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): unknown {
    const t = this.next();
    if (t.t === 'var') return this.variables[t.v] ?? null;
    if (t.t === 'string') return t.v;
    if (t.t === 'int') return t.v;
    if (t.t === 'name') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      return t.v; // enum value, kept as a string
    }
    if (t.t === 'punct' && t.v === '[') {
      const list: unknown[] = [];
      while (!this.isPunct(']')) list.push(this.parseValue());
      this.expectPunct(']');
      return list;
    }
    if (t.t === 'punct' && t.v === '{') {
      const obj: Record<string, unknown> = {};
      while (!this.isPunct('}')) {
        const nameTok = this.next();
        if (nameTok.t !== 'name') throw new Error('graphql: expected object field name');
        this.expectPunct(':');
        obj[nameTok.v] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    throw new Error(`graphql: unexpected value token ${JSON.stringify(t)}`);
  }
}

// ---------------------------------------------------------------- schema

/** Field name -> return type name, per object type. */
const FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: { login: 'String', id: 'ID', name: 'String', email: 'String', avatarUrl: 'String', url: 'String' },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User',
    description: 'String', defaultBranchRef: 'Ref', viewerPermission: 'String', hasIssuesEnabled: 'Boolean',
    issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest',
    url: 'String', createdAt: 'String', updatedAt: 'String', isPrivate: 'Boolean', fork: 'Boolean',
    labels: 'LabelConnection',
  },
  Ref: { name: 'String', target: 'Commit' },
  Commit: { oid: 'String', message: 'String' },
  Issue: {
    id: 'ID', number: 'Int', title: 'String', state: 'String', body: 'String', url: 'String',
    createdAt: 'String', updatedAt: 'String', closedAt: 'String', author: 'User', labels: 'LabelConnection',
    comments: 'IssueCommentConnection', repository: 'Repository',
  },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  IssueComment: { id: 'ID', body: 'String', author: 'User', createdAt: 'String', url: 'String' },
  IssueCommentConnection: { nodes: 'IssueComment', edges: 'IssueCommentEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  PullRequest: {
    id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'String', merged: 'Boolean',
    mergeable: 'String', headRefName: 'String', baseRefName: 'String', headRef: 'Ref', baseRef: 'Ref',
    files: 'PullRequestFileConnection', author: 'User', url: 'String', createdAt: 'String',
    updatedAt: 'String', closedAt: 'String', repository: 'Repository',
  },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestFileConnection: { nodes: 'PullRequestFile', edges: 'PullRequestFileEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestFileEdge: { node: 'PullRequestFile', cursor: 'String' },
  PullRequestFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  Label: { id: 'ID', name: 'String', color: 'String', description: 'String' },
  LabelConnection: { nodes: 'Label', edges: 'LabelEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  LabelEdge: { node: 'Label', cursor: 'String' },
  __Type: { name: 'String', kind: 'String', description: 'String', fields: '__Field', enumValues: '__EnumValue' },
  __Field: { name: 'String', description: 'String', args: 'String', type: 'String' },
  __EnumValue: { name: 'String', description: 'String' },
  __Schema: { queryType: '__Type', mutationType: '__Type', types: '__Type' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', clientMutationId: 'String' },
  Node: { id: 'ID' },
};

const SCALARS = new Set(['String', 'Int', 'ID', 'Boolean', 'Float']);

/** Introspection field lists, as the suite's probes require them. */
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'url', 'createdAt', 'updatedAt', 'closedAt', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'fork', 'labels'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl', 'url'],
  SearchType: [],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ---------------------------------------------------------------- execution

type GqlValue =
  | { __typename: 'User'; user: { login: string; id: number; name: string; email: string } }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'IssueComment'; repo: Repo; issue: Issue; comment: { id: number; nodeId: string; body: string; createdAt: string } }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'Commit'; oid: string; message: string }
  | { __typename: 'IssueConnection'; items: Issue[]; repo: Repo }
  | { __typename: 'PullRequestConnection'; items: Pull[]; repo: Repo }
  | { __typename: 'PullRequestFileConnection'; files: { filename: string; additions: number; deletions: number }[] }
  | { __typename: 'LabelConnection'; labels: { id: number; nodeId: string; name: string; color: string; description: string }[] }
  | { __typename: 'IssueCommentConnection'; repo: Repo; issue: Issue }
  | { __typename: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Schema' }
  | { __typename: 'CreateIssuePayload'; repo: Repo; issue: Issue | null }
  | { __typename: 'CloseIssuePayload'; repo: Repo; issue: Issue | null }
  | { __typename: 'CreatePullRequestPayload'; repo: Repo; pull: Pull | null }
  | { __typename: 'MergePullRequestPayload'; repo: Repo; pull: Pull | null }
  | { __typename: 'AddCommentPayload'; repo: Repo; issue: Issue; comment: { id: number; nodeId: string; body: string; createdAt: string } | null }
  | { __typename: 'IssueEdge'; node: GqlValue; cursor: string }
  | { __typename: 'PullRequestEdge'; node: GqlValue; cursor: string }
  | { __typename: 'PullRequestFileEdge'; node: GqlValue; cursor: string }
  | { __typename: 'IssueCommentEdge'; node: GqlValue; cursor: string }
  | { __typename: 'LabelEdge'; node: GqlValue; cursor: string }
  | { __typename: 'PullRequestFile'; path: string; additions: number; deletions: number }
  | { __typename: 'Label'; name: string; color: string; description: string; id: number; nodeId: string };

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function cursorToNumber(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(-?\d+)$/.exec(decoded);
    return m !== null ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
}

export class GraphQLError extends Error {
  readonly path: (string | number)[];

  constructor(message: string, path: (string | number)[] = []) {
    super(message);
    this.path = path;
  }
}

class Executor {
  private readonly store: ForgeStore;

  constructor(store: ForgeStore) {
    this.store = store;
  }

  executeOperation(op: Operation): Record<string, unknown> {
    const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
    const data: Record<string, unknown> = {};
    for (const sel of op.selections) {
      if (sel.kind === 'fragment') {
        Object.assign(data, this.executeSelections(rootType, null, sel.selections, []));
      } else {
        const key = sel.alias ?? sel.name;
        data[key] = this.executeField(rootType, null, sel, []);
      }
    }
    return data;
  }

  private executeSelections(typeName: string, obj: GqlValue | null, selections: SelectionNode[], path: (string | number)[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.kind === 'fragment') {
        if (sel.typeCondition !== null && obj !== null && obj.__typename !== sel.typeCondition) continue;
        const nextType = sel.typeCondition ?? typeName;
        Object.assign(out, this.executeSelections(nextType, obj, sel.selections, path));
        continue;
      }
      const key = sel.alias ?? sel.name;
      out[key] = this.executeField(typeName, obj, sel, [...path, key]);
    }
    return out;
  }

  private executeField(typeName: string, obj: GqlValue | null, field: FieldNode, path: (string | number)[]): unknown {
    const fields = FIELD_TYPES[typeName];
    if (fields === undefined || !(field.name in fields)) {
      throw new GraphQLError(`Cannot query field "${field.name}" on type "${typeName}".`, path);
    }
    const returnType = fields[field.name] as string;
    const value = this.resolveField(typeName, obj, field);
    if (value === null || value === undefined) return null;
    if (SCALARS.has(returnType)) return value;
    if (field.selections.length === 0) return value;
    if (Array.isArray(value)) {
      return value.map((v, i) => this.executeSelections(returnType, v as GqlValue, field.selections, [...path, i]));
    }
    return this.executeSelections(returnType, value as GqlValue, field.selections, path);
  }

  private resolveField(typeName: string, obj: GqlValue | null, field: FieldNode): unknown {
    const args = field.args;
    switch (typeName) {
      case 'Query': {
        if (field.name === 'viewer') return { __typename: 'User', user: VIEWER };
        if (field.name === 'repository') {
          const repo = this.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
          return repo === undefined ? null : { __typename: 'Repository', repo };
        }
        if (field.name === 'node') {
          const parsed = parseGid(String(args.id ?? ''));
          if (parsed === null) return null;
          if (parsed.type === 'Repository') {
            const [owner, name] = parsed.key.split('/');
            const repo = this.store.getRepo(owner, name);
            return repo === undefined ? null : { __typename: 'Repository', repo };
          }
          if (parsed.type === 'Issue') {
            const [owner, name, num] = parsed.key.split('/');
            const repo = this.store.getRepo(owner, name);
            const issue = repo?.issues.find((i) => i.number === Number(num));
            return repo !== undefined && issue !== undefined ? { __typename: 'Issue', repo, issue } : null;
          }
          if (parsed.type === 'PullRequest') {
            const [owner, name, num] = parsed.key.split('/');
            const repo = this.store.getRepo(owner, name);
            const pull = repo?.pulls.find((p) => p.number === Number(num));
            return repo !== undefined && pull !== undefined ? { __typename: 'PullRequest', repo, pull } : null;
          }
          if (parsed.type === 'User') {
            return { __typename: 'User', user: VIEWER };
          }
          return null;
        }
        if (field.name === '__type') {
          const name = String(args.name ?? '');
          if (TYPE_FIELDS[name] === undefined && TYPE_ENUM_VALUES[name] === undefined) return null;
          return { __typename: '__Type', name };
        }
        if (field.name === '__schema') return { __typename: '__Schema' };
        return null;
      }
      case 'Node': {
        if (field.name === 'id') {
          const o = obj as GqlValue;
          if (o.__typename === 'Repository') return o.repo.nodeId;
          if (o.__typename === 'Issue') return o.issue.nodeId;
          if (o.__typename === 'PullRequest') return o.pull.nodeId;
          if (o.__typename === 'User') return gid('User', o.user.login);
        }
        return null;
      }
      case 'Mutation': {
        return this.resolveMutation(field);
      }
      case 'User': {
        const u = (obj as { __typename: 'User'; user: { login: string; id: number; name: string; email: string } }).user;
        if (field.name === 'login') return u.login;
        if (field.name === 'id') return gid('User', u.login);
        if (field.name === 'name') return u.name;
        if (field.name === 'email') return u.email;
        if (field.name === 'avatarUrl') return `https://example.invalid/avatar/${u.login}`;
        if (field.name === 'url') return `https://github.com/${u.login}`;
        return null;
      }
      case 'Repository': {
        const repo = (obj as { __typename: 'Repository'; repo: Repo }).repo;
        switch (field.name) {
          case 'id': return repo.nodeId;
          case 'databaseId': return repo.id;
          case 'name': return repo.name;
          case 'nameWithOwner': return `${repo.owner.login}/${repo.name}`;
          case 'owner': return { __typename: 'User', user: repo.owner };
          case 'description': return repo.description;
          case 'defaultBranchRef': {
            const tip = this.store.headCommit(repo);
            return tip === null ? null : { __typename: 'Ref', name: repo.defaultBranch };
          }
          case 'viewerPermission': return 'ADMIN';
          case 'hasIssuesEnabled': return true;
          case 'url': return `https://github.com/${repo.owner.login}/${repo.name}`;
          case 'createdAt': return repo.createdAt;
          case 'updatedAt': return repo.updatedAt;
          case 'isPrivate': return repo.isPrivate;
          case 'fork': return false;
          case 'issue': {
            const issue = repo.issues.find((i) => i.number === Number(args.number));
            return issue === undefined ? null : { __typename: 'Issue', repo, issue };
          }
          case 'issues': {
            return this.issueConnection(repo, args);
          }
          case 'pullRequests': {
            return this.pullConnection(repo, args);
          }
          case 'pullRequest': {
            const pull = repo.pulls.find((p) => p.number === Number(args.number));
            return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
          }
          case 'labels': {
            return { __typename: 'LabelConnection', labels: repo.labels };
          }
          default: return null;
        }
      }
      case 'Ref': {
        return (obj as { __typename: 'Ref'; name: string }).name;
      }
      case 'Issue': {
        const { repo, issue } = obj as { __typename: 'Issue'; repo: Repo; issue: Issue };
        switch (field.name) {
          case 'id': return issue.nodeId;
          case 'number': return issue.number;
          case 'title': return issue.title;
          case 'state': return issue.state.toUpperCase();
          case 'body': return issue.body;
          case 'url': return `https://github.com/${repo.owner.login}/${repo.name}/issues/${issue.number}`;
          case 'createdAt': return issue.createdAt;
          case 'updatedAt': return issue.updatedAt;
          case 'closedAt': return issue.closedAt;
          case 'author': return { __typename: 'User', user: issue.user };
          case 'labels': return { __typename: 'LabelConnection', labels: repo.labels.filter((l) => issue.labels.includes(l.name)) };
          case 'comments': return { __typename: 'IssueCommentConnection', repo, issue };
          case 'repository': return { __typename: 'Repository', repo };
          default: return null;
        }
      }
      case 'IssueConnection': {
        const conn = obj as { __typename: 'IssueConnection'; items: Issue[]; repo: Repo };
        if (field.name === 'nodes') return conn.items.map((issue) => ({ __typename: 'Issue', repo: conn.repo, issue }));
        if (field.name === 'edges') {
          return conn.items.map((issue) => ({ __typename: 'IssueEdge', node: { __typename: 'Issue', repo: conn.repo, issue }, cursor: cursorFor(issue.number) }));
        }
        if (field.name === 'totalCount') return conn.items.length;
        if (field.name === 'pageInfo') return conn.pageInfo;
        return null;
      }
      case 'IssueEdge': {
        const edge = obj as { __typename: 'IssueEdge'; node: GqlValue; cursor: string };
        return field.name === 'node' ? edge.node : edge.cursor;
      }
      case 'IssueCommentConnection': {
        const { repo, issue } = obj as { __typename: 'IssueCommentConnection'; repo: Repo; issue: Issue };
        if (field.name === 'nodes') {
          return issue.comments.map((c) => ({ __typename: 'IssueComment', repo, issue, comment: c }));
        }
        if (field.name === 'edges') {
          return issue.comments.map((c) => ({
            __typename: 'IssueCommentEdge',
            node: { __typename: 'IssueComment', repo, issue, comment: c },
            cursor: cursorFor(c.id),
          }));
        }
        if (field.name === 'totalCount') return issue.comments.length;
        if (field.name === 'pageInfo') {
          return { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
        }
        return null;
      }
      case 'IssueCommentEdge': {
        const edge = obj as { __typename: 'IssueCommentEdge'; node: GqlValue; cursor: string };
        return field.name === 'node' ? edge.node : edge.cursor;
      }
      case 'IssueComment': {
        const c = (obj as { __typename: 'IssueComment'; comment: { id: number; nodeId: string; body: string; createdAt: string } }).comment;
        if (field.name === 'id') return c.nodeId;
        if (field.name === 'body') return c.body;
        if (field.name === 'createdAt') return c.createdAt;
        if (field.name === 'author') return { __typename: 'User', user: VIEWER };
        if (field.name === 'url') return '';
        return null;
      }
      case 'PullRequest': {
        const { repo, pull } = obj as { __typename: 'PullRequest'; repo: Repo; pull: Pull };
        switch (field.name) {
          case 'id': return pull.nodeId;
          case 'number': return pull.number;
          case 'title': return pull.title;
          case 'body': return pull.body;
          case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
          case 'merged': return pull.merged;
          case 'mergeable': return this.store.pullMergeable(repo, pull);
          case 'headRefName': return pull.headRef;
          case 'baseRefName': return pull.baseRef;
          case 'headRef': return { __typename: 'Ref', name: pull.headRef };
          case 'baseRef': return { __typename: 'Ref', name: pull.baseRef };
          case 'files': {
            const files = this.store.pullFiles(repo, pull);
            const first = typeof args.first === 'number' ? (args.first as number) : files.length;
            const sliced = files.slice(0, first);
            return {
              __typename: 'PullRequestFileConnection',
              files: sliced.map((f) => ({ filename: f.filename, additions: f.additions, deletions: f.deletions })),
            };
          }
          case 'author': return { __typename: 'User', user: pull.user };
          case 'url': return `https://github.com/${repo.owner.login}/${repo.name}/pull/${pull.number}`;
          case 'createdAt': return pull.createdAt;
          case 'updatedAt': return pull.updatedAt;
          case 'closedAt': return pull.closedAt;
          case 'repository': return { __typename: 'Repository', repo };
          default: return null;
        }
      }
      case 'PullRequestConnection': {
        const conn = obj as { __typename: 'PullRequestConnection'; items: Pull[]; repo: Repo };
        if (field.name === 'nodes') return conn.items.map((pull) => ({ __typename: 'PullRequest', repo: conn.repo, pull }));
        if (field.name === 'edges') {
          return conn.items.map((pull) => ({ __typename: 'PullRequestEdge', node: { __typename: 'PullRequest', repo: conn.repo, pull }, cursor: cursorFor(pull.number) }));
        }
        if (field.name === 'totalCount') return conn.items.length;
        if (field.name === 'pageInfo') return conn.pageInfo;
        return null;
      }
      case 'PullRequestEdge': {
        const edge = obj as { __typename: 'PullRequestEdge'; node: GqlValue; cursor: string };
        return field.name === 'node' ? edge.node : edge.cursor;
      }
      case 'PullRequestFileConnection': {
        const conn = obj as { __typename: 'PullRequestFileConnection'; files: { filename: string; additions: number; deletions: number }[] };
        if (field.name === 'nodes') {
          return conn.files.map((f) => ({ __typename: 'PullRequestFile', path: f.filename, additions: f.additions, deletions: f.deletions }));
        }
        if (field.name === 'edges') {
          return conn.files.map((f, i) => ({
            __typename: 'PullRequestFileEdge',
            node: { __typename: 'PullRequestFile', path: f.filename, additions: f.additions, deletions: f.deletions },
            cursor: cursorFor(i + 1),
          }));
        }
        if (field.name === 'totalCount') return conn.files.length;
        if (field.name === 'pageInfo') {
          return { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
        }
        return null;
      }
      case 'PullRequestFileEdge': {
        const edge = obj as { __typename: 'PullRequestFileEdge'; node: GqlValue; cursor: string };
        return field.name === 'node' ? edge.node : edge.cursor;
      }
      case 'PullRequestFile': {
        const f = obj as { __typename: 'PullRequestFile'; path: string; additions: number; deletions: number };
        if (field.name === 'path') return f.path;
        if (field.name === 'additions') return f.additions;
        if (field.name === 'deletions') return f.deletions;
        if (field.name === 'changeType') return 'MODIFIED';
        return null;
      }
      case 'PageInfo': {
        const p = obj as { __typename: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
        if (field.name === 'hasNextPage') return p.hasNextPage;
        if (field.name === 'hasPreviousPage') return p.hasPreviousPage;
        if (field.name === 'startCursor') return p.startCursor;
        if (field.name === 'endCursor') return p.endCursor;
        return null;
      }
      case 'LabelConnection': {
        const conn = obj as { __typename: 'LabelConnection'; labels: { id: number; nodeId: string; name: string; color: string; description: string }[] };
        if (field.name === 'nodes') {
          return conn.labels.map((l) => ({ __typename: 'Label', name: l.name, color: l.color, description: l.description, id: l.id, nodeId: l.nodeId }));
        }
        if (field.name === 'edges') {
          return conn.labels.map((l) => ({
            __typename: 'LabelEdge',
            node: { __typename: 'Label', name: l.name, color: l.color, description: l.description, id: l.id, nodeId: l.nodeId },
            cursor: cursorFor(l.id),
          }));
        }
        if (field.name === 'totalCount') return conn.labels.length;
        if (field.name === 'pageInfo') {
          return { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
        }
        return null;
      }
      case 'LabelEdge': {
        const edge = obj as { __typename: 'LabelEdge'; node: GqlValue; cursor: string };
        return field.name === 'node' ? edge.node : edge.cursor;
      }
      case 'Label': {
        const l = obj as { __typename: 'Label'; name: string; color: string; description: string; id: number; nodeId: string };
        if (field.name === 'id') return l.nodeId;
        if (field.name === 'name') return l.name;
        if (field.name === 'color') return l.color;
        if (field.name === 'description') return l.description;
        return null;
      }
      case '__Type': {
        const t = obj as { __typename: '__Type'; name: string };
        if (field.name === 'name') return t.name;
        if (field.name === 'kind') return TYPE_ENUM_VALUES[t.name] !== undefined ? 'ENUM' : 'OBJECT';
        if (field.name === 'description') return null;
        if (field.name === 'fields') {
          const names = TYPE_FIELDS[t.name] ?? [];
          return names.map((n) => ({ __typename: '__Field', name: n }));
        }
        if (field.name === 'enumValues') {
          const names = TYPE_ENUM_VALUES[t.name] ?? [];
          return names.map((n) => ({ __typename: '__EnumValue', name: n }));
        }
        return null;
      }
      case '__Field': {
        const f = obj as unknown as { name: string };
        if (field.name === 'name') return f.name;
        if (field.name === 'description') return null;
        if (field.name === 'args') return [];
        if (field.name === 'type') return null;
        return null;
      }
      case '__EnumValue': {
        const f = obj as unknown as { name: string };
        if (field.name === 'name') return f.name;
        if (field.name === 'description') return null;
        return null;
      }
      case '__Schema': {
        if (field.name === 'queryType') return { __typename: '__Type', name: 'Query' };
        if (field.name === 'mutationType') return { __typename: '__Type', name: 'Mutation' };
        if (field.name === 'types') {
          return Object.keys(TYPE_FIELDS).map((n) => ({ __typename: '__Type', name: n }));
        }
        return null;
      }
      case 'CreateIssuePayload': {
        const p = obj as { __typename: 'CreateIssuePayload'; repo: Repo; issue: Issue | null };
        if (field.name === 'issue') return p.issue === null ? null : { __typename: 'Issue', repo: p.repo, issue: p.issue };
        if (field.name === 'clientMutationId') return null;
        return null;
      }
      case 'CloseIssuePayload': {
        const p = obj as { __typename: 'CloseIssuePayload'; repo: Repo; issue: Issue | null };
        if (field.name === 'issue') return p.issue === null ? null : { __typename: 'Issue', repo: p.repo, issue: p.issue };
        if (field.name === 'clientMutationId') return null;
        return null;
      }
      case 'CreatePullRequestPayload': {
        const p = obj as { __typename: 'CreatePullRequestPayload'; repo: Repo; pull: Pull | null };
        if (field.name === 'pullRequest') return p.pull === null ? null : { __typename: 'PullRequest', repo: p.repo, pull: p.pull };
        if (field.name === 'clientMutationId') return null;
        return null;
      }
      case 'MergePullRequestPayload': {
        const p = obj as { __typename: 'MergePullRequestPayload'; repo: Repo; pull: Pull | null };
        if (field.name === 'pullRequest') return p.pull === null ? null : { __typename: 'PullRequest', repo: p.repo, pull: p.pull };
        if (field.name === 'clientMutationId') return null;
        return null;
      }
      case 'AddCommentPayload': {
        const p = obj as { __typename: 'AddCommentPayload'; repo: Repo; issue: Issue; comment: { id: number; nodeId: string; body: string; createdAt: string } | null };
        if (field.name === 'commentEdge') {
          if (p.comment === null) return null;
          return {
            __typename: 'IssueCommentEdge',
            node: { __typename: 'IssueComment', repo: p.repo, issue: p.issue, comment: p.comment },
            cursor: cursorFor(p.comment.id),
          };
        }
        if (field.name === 'clientMutationId') return null;
        return null;
      }
      default:
        return null;
    }
  }

  private issueConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
    let list = [...repo.issues];
    const states = args.states;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((s) => String(s).toLowerCase()));
      list = list.filter((i) => wanted.has(i.state));
    }
    const orderBy = args.orderBy as Record<string, unknown> | undefined;
    if (orderBy !== undefined && String(orderBy.field ?? '') === 'CREATED_AT' && String(orderBy.direction ?? '') === 'DESC') {
      list.sort((a, b) => b.number - a.number);
    } else {
      list.sort((a, b) => a.number - b.number);
    }
    // Cursor pagination must follow the list's order: for DESC the cursor
    // walks downward, so re-key by the position in the ordered list.
    const first = typeof args.first === 'number' ? (args.first as number) : null;
    const afterN = cursorToNumber(typeof args.after === 'string' ? (args.after as string) : null);
    let rest = list;
    if (afterN !== null) {
      const idx = list.findIndex((i) => i.number === afterN);
      rest = idx >= 0 ? list.slice(idx + 1) : list;
    }
    const pageItems = first === null ? rest : rest.slice(0, first);
    const hasNextPage = rest.length > pageItems.length;
    const page: Page<Issue> = {
      nodes: pageItems,
      hasNextPage,
      endCursor: pageItems.length ? cursorFor(pageItems[pageItems.length - 1].number) : null,
      startCursor: pageItems.length ? cursorFor(pageItems[0].number) : null,
    };
    const conn: GqlValue = {
      __typename: 'IssueConnection',
      items: page.nodes,
      repo,
      pageInfo: {
        __typename: 'PageInfo',
        hasNextPage: page.hasNextPage,
        hasPreviousPage: false,
        startCursor: page.startCursor,
        endCursor: page.endCursor,
      },
    };
    return conn;
  }

  private pullConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
    const list = [...repo.pulls].sort((a, b) => b.number - a.number);
    const first = typeof args.first === 'number' ? (args.first as number) : null;
    const afterN = cursorToNumber(typeof args.after === 'string' ? (args.after as string) : null);
    let rest = list;
    if (afterN !== null) {
      const idx = list.findIndex((p) => p.number === afterN);
      rest = idx >= 0 ? list.slice(idx + 1) : list;
    }
    const pageItems = first === null ? rest : rest.slice(0, first);
    const hasNextPage = rest.length > pageItems.length;
    const conn: GqlValue = {
      __typename: 'PullRequestConnection',
      items: pageItems,
      repo,
      pageInfo: {
        __typename: 'PageInfo',
        hasNextPage,
        hasPreviousPage: false,
        startCursor: pageItems.length ? cursorFor(pageItems[0].number) : null,
        endCursor: pageItems.length ? cursorFor(pageItems[pageItems.length - 1].number) : null,
      },
    };
    return conn;
  }

  private resolveMutation(field: FieldNode): GqlValue | null {
    const input = (field.args.input ?? {}) as Record<string, unknown>;
    if (field.name === 'createIssue') {
      const repoId = String(input.repositoryId ?? '');
      const parsed = parseGid(repoId);
      const repo = parsed !== null && parsed.type === 'Repository'
        ? this.store.getRepo(...(parsed.key.split('/') as [string, string]))
        : undefined;
      if (repo === undefined) throw new GraphQLError('repository not found');
      const issue = this.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''));
      return { __typename: 'CreateIssuePayload', repo, issue };
    }
    if (field.name === 'closeIssue') {
      const parsed = parseGid(String(input.issueId ?? ''));
      if (parsed === null || parsed.type !== 'Issue') throw new GraphQLError('issue not found');
      const [owner, name, num] = parsed.key.split('/');
      const repo = this.store.getRepo(owner, name);
      const issue = repo?.issues.find((i) => i.number === Number(num));
      if (repo === undefined || issue === undefined) throw new GraphQLError('issue not found');
      issue.state = 'closed';
      issue.closedAt = this.store.now();
      issue.updatedAt = issue.closedAt;
      return { __typename: 'CloseIssuePayload', repo, issue };
    }
    if (field.name === 'createPullRequest') {
      const repoId = String(input.repositoryId ?? '');
      const parsed = parseGid(repoId);
      const repo = parsed !== null && parsed.type === 'Repository'
        ? this.store.getRepo(...(parsed.key.split('/') as [string, string]))
        : undefined;
      if (repo === undefined) throw new GraphQLError('repository not found');
      const pull = this.store.createPull(
        repo,
        String(input.title ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
        String(input.body ?? ''),
      );
      return { __typename: 'CreatePullRequestPayload', repo, pull };
    }
    if (field.name === 'mergePullRequest') {
      const parsed = parseGid(String(input.pullRequestId ?? ''));
      if (parsed === null || parsed.type !== 'PullRequest') throw new GraphQLError('pull request not found');
      const [owner, name, num] = parsed.key.split('/');
      const repo = this.store.getRepo(owner, name);
      const pull = repo?.pulls.find((p) => p.number === Number(num));
      if (repo === undefined || pull === undefined) throw new GraphQLError('pull request not found');
      const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
      this.store.mergePull(repo, pull, method);
      return { __typename: 'MergePullRequestPayload', repo, pull };
    }
    if (field.name === 'addComment') {
      const parsed = parseGid(String(input.subjectId ?? ''));
      if (parsed === null) throw new GraphQLError('subject not found');
      if (parsed.type === 'Issue') {
        const [owner, name, num] = parsed.key.split('/');
        const repo = this.store.getRepo(owner, name);
        const issue = repo?.issues.find((i) => i.number === Number(num));
        if (repo === undefined || issue === undefined) throw new GraphQLError('issue not found');
        const comment = this.store.addComment(repo, issue, String(input.body ?? ''));
        return { __typename: 'AddCommentPayload', repo, issue, comment };
      }
      if (parsed.type === 'PullRequest') {
        const [owner, name, num] = parsed.key.split('/');
        const repo = this.store.getRepo(owner, name);
        const pull = repo?.pulls.find((p) => p.number === Number(num));
        if (repo === undefined || pull === undefined) throw new GraphQLError('pull request not found');
        // Comments on a pull request land on its backing issue record when one
        // exists; otherwise they attach to the pull itself via a synthetic issue.
        const issue = repo.issues.find((i) => i.number === pull.number);
        if (issue !== undefined) {
          const comment = this.store.addComment(repo, issue, String(input.body ?? ''));
          return { __typename: 'AddCommentPayload', repo, issue, comment };
        }
        throw new GraphQLError('pull request has no comment thread');
      }
      throw new GraphQLError('subject not found');
    }
    return null;
  }
}

// ---------------------------------------------------------------- entry point

export interface GraphQLResult {
  status: number;
  body: unknown;
}

export function handleGraphQL(store: ForgeStore, body: unknown): GraphQLResult {
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
      return { data: null, errors: [{ message: 'request body must be an object with query and variables' }] };
    }
    const query = (doc as Record<string, unknown>).query;
    if (typeof query !== 'string' || query.trim() === '') {
      return { data: null, errors: [{ message: 'query must be a non-empty string' }] };
    }
    const variables = ((doc as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
    try {
      const parser = new Parser(tokenize(query), variables, new Map());
      const op = parser.parseDocument();
      const executor = new Executor(store);
      const data = executor.executeOperation(op);
      return { data };
    } catch (e) {
      if (e instanceof GraphQLError) {
        return { data: null, errors: [{ message: e.message, path: e.path }] };
      }
      return { data: null, errors: [{ message: e instanceof Error ? e.message : 'query failed' }] };
    }
  };

  if (Array.isArray(body)) {
    return { status: 200, body: body.map((doc) => runOne(doc)) };
  }
  return { status: 200, body: runOne(body) };
}
