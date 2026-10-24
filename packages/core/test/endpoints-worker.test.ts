import { describe, expect, it } from 'vitest';
import extractEndpointCalls, { type ExtractedCall } from '../src/jobs/workers/endpoints.worker';

function calls(code: string): ExtractedCall[] {
  return extractEndpointCalls({ bytes: Buffer.from(code) }).calls;
}

/** 比べやすい形（via・メソッド・URL・パラメータ） */
function brief(code: string): string[] {
  return calls(code).map((c) => {
    const params = c.params.map((p) => `${p.in}:${p.name}`).join(',');
    return `${c.via} ${c.method || '-'} ${c.url}${params ? ` [${params}]` : ''}`;
  });
}

describe('ast_url worker: HTTP client calls', () => {
  it('reads fetch / Request with their options', () => {
    expect(
      brief(`
        fetch("/api/a");
        fetch(\`/api/users/\${userId}/docs/\${t}\`, { method: "delete" });
        window.fetch("/api/b", { method: "POST", headers: { "X-Csrf": t }, body: JSON.stringify({ title, tags: [] }) });
        new Request("/api/c", { method: "PUT", body: new URLSearchParams({ q: 1 }) });
      `),
    ).toEqual([
      'fetch GET /api/a',
      'fetch DELETE /api/users/{userId}/docs/{}',
      'fetch POST /api/b [header:X-Csrf,body:title,body:tags]',
      'fetch PUT /api/c [body:q]',
    ]);
  });

  it('marks the method unknown when it is not a literal', () => {
    expect(brief('fetch("/api/a", { method: m }); axios({ url: "/api/b", method: verb, data: {} });')).toEqual([
      'fetch - /api/a',
      'config - /api/b',
    ]);
  });

  it('reads method-named calls and applies a single base URL of the same module', () => {
    expect(
      brief(`
        const api = axios.create({ baseURL: "https://api.example.com/v1" });
        api.get("/users", { params: { page: 1, per_page: 20 } });
        api.post("users/" + id + "/invite", { email }, { headers: { "X-Req": 1 } });
        api.delete(\`/docs/\${docId}\`);
        api.get("https://other.example.com/x");
      `),
    ).toEqual([
      'method GET https://api.example.com/v1/users [query:page,query:per_page]',
      'method POST https://api.example.com/v1/users/{}/invite [body:email,header:X-Req]',
      'method DELETE https://api.example.com/v1/docs/{docId}',
      'method GET https://other.example.com/x',
    ]);
  });

  it('does not guess when the module has several base URLs', () => {
    const r = extractEndpointCalls({
      bytes: Buffer.from('a.create({ baseURL: "/a" }); b.create({ baseURL: "/b" }); c.get("/x");'),
    });
    expect(r.base).toBeNull();
    expect(r.calls.map((c) => c.url)).toEqual(['/x']);
  });

  it('takes the base from a transport that appends a path, and does not report the transport itself', () => {
    const r = extractEndpointCalls({
      bytes: Buffer.from('function req(p, o) { return fetch("/api/v2" + p, o) } client.get("/me"); client.patch("/me", { name });'),
    });
    expect(r.base).toBe('/api/v2');
    expect(r.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/v2/me', 'PATCH /api/v2/me']);
  });

  it('reads config objects ($.ajax, axios(config), x.request)', () => {
    expect(
      brief(`
        $.ajax({ url: "/legacy/search", type: "POST", data: { q, page } });
        $.ajax("/legacy/item", { type: "GET" });
        axios({ url: "/api/list", params: { sort } });
        http.request({ url: "/api/raw" });
        $.ajax({ url: "/legacy/json", type: "json", data: {} });
      `),
    ).toEqual([
      'config POST /legacy/search [body:q,body:page]',
      'config GET /legacy/item',
      'config GET /api/list [query:sort]',
      'config GET /api/raw',
      'config GET /legacy/json',
    ]);
  });

  it('reads XHR, sendBeacon, WebSocket and EventSource', () => {
    expect(
      brief(`
        x.open("post", "/api/upload?kind=" + k);
        x.open("CONNECT", "/nope");
        navigator.sendBeacon("/t/ping", data);
        new WebSocket("wss://rt.example.com/socket?token=" + tok);
        new EventSource("/api/events");
      `),
    ).toEqual([
      'xhr POST /api/upload?kind={}',
      'beacon POST /t/ping',
      'websocket - wss://rt.example.com/socket?token={tok}',
      'eventsource GET /api/events',
    ]);
    expect(calls('new WebSocket("wss://rt.example.com/s")')[0]!.websocket).toBe(true);
  });

  it('builds URLs from concat calls and module string constants', () => {
    expect(
      brief(`
        const API = "/api/v3";
        const PATH = \`/reports\`;
        fetch(API + PATH + "/" + reportId);
        fetch("/a/".concat(x, "/b"));
        let changed = "/x"; changed = "/y"; fetch(changed + "/z");
      `),
    ).toEqual(['fetch GET /api/v3/reports/{reportId}', 'fetch GET /a/{}/b', 'fetch GET {changed}/z']);
  });
});

describe('ast_url worker: things that are not endpoints', () => {
  it('ignores Map/Headers/URLSearchParams getters, routes, assets and MIME types', () => {
    expect(
      calls(`
        headers.get("content-type");
        new URLSearchParams(location.search).get("next");
        cache.get("user");
        store.set("a/b", 1);
        const routes = [{ path: "/users/:id" }, { path: "/settings" }];
        const logo = "/static/logo.png";
        res.headers.get("application/json");
        el.get("my key/with space");
        fetch(url);
        fetch(a + b);
      `),
    ).toEqual([]);
  });

  it('keeps short minified names out of the placeholders', () => {
    expect(calls('fetch(`/api/u/${e}/d/${user.docId}/${a.b}`)')[0]!.url).toBe('/api/u/{}/d/{docId}/{}');
  });
});

describe('ast_url worker: parsing and positions', () => {
  it('reads a webpack module factory (a function expression) as an expression', () => {
    expect(brief('function (e, t, n) { "use strict"; n.d(t, { a: () => r }); const r = () => fetch("/api/x") }')).toEqual([
      'fetch GET /api/x',
    ]);
    expect(brief('(e, t, n) => { n(1).get("/api/y") }')).toEqual(['method GET /api/y']);
  });

  it('returns UTF-8 byte ranges of the call expression', () => {
    const code = 'const s = "日本語😀"; fetch("/api/x", { method: "POST" });';
    const [c] = calls(code);
    const bytes = Buffer.from(code);
    expect(bytes.subarray(c!.startByte, c!.endByte).toString()).toBe('fetch("/api/x", { method: "POST" })');
  });

  it('keeps a BOM as part of the byte coordinates', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('fetch("/a")')]);
    const [c] = extractEndpointCalls({ bytes }).calls;
    expect([c!.startByte, c!.endByte]).toEqual([3, bytes.length]);
  });

  it('fails with parse_failed on syntax errors and invalid UTF-8', () => {
    for (const bytes of [Buffer.from('fetch("/a"'), Buffer.from([0x66, 0xff, 0x28])]) {
      let err: unknown;
      try {
        extractEndpointCalls({ bytes });
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ skipReason: 'parse_failed' });
    }
  });
});
