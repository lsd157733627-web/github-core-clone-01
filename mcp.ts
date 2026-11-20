// mcp.ts — Model Context Protocol over streamable HTTP (POST /mcp).
// JSON-RPC 2.0: server/discover (2026-07-28), initialize (legacy),
// tools/list, tools/call. Standard library only.

import { VIEWER, issueJson, pullJson, repoJson } from './store.ts';
import type { ForgeStore, Repo } from './store.ts';

export const MCP_VERSION = '2026-07-28';
export const MCP_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_NAME = 'github-core-clone';
export const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required: string[],
): ToolDef {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: true },
  };
}

/** The frozen tool list: two tools/list calls must serialize byte-identically. */
export const TOOLS: readonly ToolDef[] = Object.freeze([
  tool(
    'create_repo',
    'Create a new repository owned by the authenticated user.',
    {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
      owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get a repository by owner and name.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
      labels: { type: 'string', description: 'Comma-separated label names.' },
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List issues in a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Open a pull request between two branches of a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Merge a pull request (squash) and close it.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
      number: { type: 'number', description: 'Alias for pull_number.' },
      merge_method: { type: 'string', description: 'Merge method: squash, merge, or rebase.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
]);

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

type JsonRpcId = string | number | null;

interface RpcResponse {
  status: number;
  body: unknown;
}

function rpcResult(id: JsonRpcId, result: unknown): RpcResponse {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): RpcResponse {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { status: 200, body: { jsonrpc: '2.0', id, error } };
}

/** Normalize a tool name for suffix matching (what the suite does). */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name: string): ToolDef | undefined {
  const wanted = normalizeName(name);
  return TOOLS.find((t) => {
    const n = normalizeName(t.name);
    return n === wanted || n.endsWith(wanted) || wanted.endsWith(n);
  });
}

function toolResult(summary: unknown, isError = false): Record<string, unknown> {
  const text = typeof summary === 'string' ? summary : JSON.stringify(summary);
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
  };
  if (typeof summary !== 'string') result.structuredContent = summary;
  if (isError) result.isError = true;
  return result;
}

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = '';
  let repo = '';
  if (typeof args.owner === 'string') owner = args.owner;
  if (typeof args.owner_login === 'string') owner = args.owner_login;
  if (typeof args.repo === 'string') repo = args.repo;
  if (typeof args.repository === 'string') repo = args.repository;
  if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [o, r] = (args.full_name as string).split('/');
    if (owner === '') owner = o;
    if (repo === '') repo = r;
  }
  return { owner, repo };
}

function needRepo(store: ForgeStore, owner: string, repoName: string): Repo {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) throw new Error(`repository ${owner}/${repoName} not found`);
  return repo;
}

function callTool(store: ForgeStore, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const toolDef = findTool(name);
  if (toolDef === undefined) {
    throw Object.assign(new Error(`unknown tool: ${name}`), { code: JSON_RPC_METHOD_NOT_FOUND });
  }
  const missing = toolDef.inputSchema.required.filter((prop) => {
    // full_name can stand in for owner+repo.
    if ((prop === 'owner' || prop === 'repo') && typeof args.full_name === 'string' && (args.full_name as string).includes('/')) return false;
    return args[prop] === undefined || args[prop] === null || args[prop] === '';
  });
  if (missing.length > 0) {
    return toolResult(`missing required argument(s): ${missing.join(', ')}`, true);
  }

  try {
    switch (toolDef.name) {
      case 'create_repo': {
        const repoName = String(args.name);
        const description = typeof args.description === 'string' ? args.description : '';
        const isPrivate = args.private === true;
        const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER.login;
        try {
          const repo = store.createRepo(owner, repoName, description, isPrivate);
          return toolResult(repoSummary(repo));
        } catch {
          return toolResult(`repository ${owner}/${repoName} already exists`, true);
        }
      }
      case 'get_repo': {
        const { owner, repo: repoName } = splitFullName(args);
        const repo = needRepo(store, owner, repoName);
        return toolResult(repoSummary(repo));
      }
      case 'create_issue': {
        const { owner, repo: repoName } = splitFullName(args);
        const repo = needRepo(store, owner, repoName);
        const labels =
          typeof args.labels === 'string' && args.labels !== ''
            ? (args.labels as string).split(',').map((s) => s.trim()).filter(Boolean)
            : Array.isArray(args.labels)
              ? (args.labels as unknown[]).map(String)
              : [];
        const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', labels);
        return toolResult(issueSummary(repo, issue));
      }
      case 'list_issues': {
        const { owner, repo: repoName } = splitFullName(args);
        const repo = needRepo(store, owner, repoName);
        const state = typeof args.state === 'string' ? args.state : 'open';
        const issues = repo.issues
          .filter((i) => state === 'all' || i.state === state)
          .map((i) => issueSummary(repo, i));
        return toolResult({ repository: `${owner}/${repoName}`, issues });
      }
      case 'create_pull_request': {
        const { owner, repo: repoName } = splitFullName(args);
        const repo = needRepo(store, owner, repoName);
        const pull = store.createPull(
          repo,
          String(args.title),
          String(args.head),
          String(args.base),
          typeof args.body === 'string' ? args.body : '',
        );
        return toolResult(pullSummary(store, repo, pull));
      }
      case 'merge_pull_request': {
        const { owner, repo: repoName } = splitFullName(args);
        const repo = needRepo(store, owner, repoName);
        const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number ?? args.number);
        const pull = store.getPull(repo, number);
        if (pull === undefined) return toolResult(`pull request #${number} not found`, true);
        const method = typeof args.merge_method === 'string' ? (args.merge_method as string).toLowerCase() : 'squash';
        try {
          const sha = store.mergePull(repo, pull, method);
          return toolResult({ ...pullSummary(store, repo, pull), merged: true, sha });
        } catch (e) {
          return toolResult(e instanceof Error ? e.message : 'merge failed', true);
        }
      }
      default:
        return toolResult(`tool ${toolDef.name} is not implemented`, true);
    }
  } catch (e) {
    return toolResult(e instanceof Error ? e.message : 'tool call failed', true);
  }
}

function repoSummary(repo: Repo): Record<string, unknown> {
  const r = repoJson(repo) as Record<string, unknown>;
  return {
    id: r.id,
    node_id: r.node_id,
    name: r.name,
    full_name: r.full_name,
    owner: { login: repo.owner.login, id: repo.owner.id },
    private: r.private,
    description: r.description,
    default_branch: r.default_branch,
    html_url: r.html_url,
    url: r.url,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function issueSummary(repo: Repo, issue: ReturnType<ForgeStore['createIssue']>): Record<string, unknown> {
  const j = issueJson(repo, issue) as Record<string, unknown>;
  return {
    id: j.id,
    node_id: j.node_id,
    number: j.number,
    title: j.title,
    body: j.body,
    state: j.state,
    user: { login: VIEWER.login },
    labels: (j.labels as { name: string }[]).map((l) => l.name),
    comments: j.comments,
    created_at: j.created_at,
    updated_at: j.updated_at,
    html_url: j.html_url,
    url: j.url,
  };
}

function pullSummary(store: ForgeStore, repo: Repo, pull: ReturnType<ForgeStore['createPull']>): Record<string, unknown> {
  const j = pullJson(store, repo, pull) as Record<string, unknown>;
  return {
    id: j.id,
    node_id: j.node_id,
    number: j.number,
    title: j.title,
    body: j.body,
    state: j.state,
    merged: j.merged,
    mergeable: j.mergeable,
    head: { ref: (j.head as Record<string, unknown>).ref, sha: (j.head as Record<string, unknown>).sha },
    base: { ref: (j.base as Record<string, unknown>).ref, sha: (j.base as Record<string, unknown>).sha },
    merged_at: j.merged_at,
    merge_commit_sha: j.merge_commit_sha,
    created_at: j.created_at,
    updated_at: j.updated_at,
    html_url: j.html_url,
    url: j.url,
  };
}

export interface McpHandleResult {
  status: number;
  body: unknown;
}

/**
 * Handle one POST /mcp request. `bodyText` is the raw request body;
 * `authorized` says whether the Authorization header carried the trial token.
 * Returns null for a notification (no JSON-RPC response is due).
 */
export function handleMcp(store: ForgeStore, bodyText: string, authorized: boolean): McpHandleResult | null {
  let doc: unknown;
  try {
    doc = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_PARSE_ERROR, message: 'Parse error' } },
    };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_INVALID_REQUEST, message: 'Invalid Request' } },
    };
  }
  const req = doc as Record<string, unknown>;
  const id = (req.id ?? null) as JsonRpcId;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) get no JSON-RPC response.
  if (req.id === undefined) return null;

  if (method === 'server/discover') {
    return rpcResult(id, {
      protocolVersion: MCP_VERSION,
      supportedVersions: [MCP_VERSION, ...MCP_LEGACY_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated =
      requested === MCP_VERSION || MCP_LEGACY_VERSIONS.includes(requested) ? requested : MCP_LEGACY_VERSIONS[0];
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    if (!authorized) {
      return { status: 401, body: { message: 'Bad credentials' } };
    }
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (toolName === '') {
      return rpcError(id, JSON_RPC_INVALID_PARAMS, 'tools/call requires a tool name');
    }
    if (findTool(toolName) === undefined) {
      return rpcError(id, JSON_RPC_METHOD_NOT_FOUND, `unknown tool: ${toolName}`);
    }    try {
      const result = callTool(store, toolName, args);
      return rpcResult(id, result);
    } catch (e) {
      if ((e as { code?: number }).code === JSON_RPC_METHOD_NOT_FOUND) {
        return rpcError(id, JSON_RPC_METHOD_NOT_FOUND, (e as Error).message);
      }
      return rpcResult(id, toolResult(e instanceof Error ? e.message : 'tool call failed', true));
    }
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  return rpcError(id, JSON_RPC_METHOD_NOT_FOUND, `method not found: ${method}`);
}
