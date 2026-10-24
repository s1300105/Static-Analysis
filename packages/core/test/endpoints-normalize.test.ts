import { describe, expect, it } from 'vitest';
import { normalizeEndpointUrl } from '../src/analysis/endpoints/normalize';

describe('normalizeEndpointUrl', () => {
  it.each([
    // [入力, origin, path_norm, path_template]
    ['/api/users', '', '/api/users', '/api/users'],
    ['https://API.Example.com/v1/users/123', 'https://api.example.com', '/v1/users/{}', '/v1/users/:id'],
    ['https://api.example.com:443/x', 'https://api.example.com', '/x', '/x'],
    ['http://api.example.com:8080/x/', 'http://api.example.com:8080', '/x', '/x'],
    ['https://user:secret@api.example.com/x', 'https://api.example.com', '/x', '/x'],
    ['wss://rt.example.com/socket', 'wss://rt.example.com', '/socket', '/socket'],
    ['//cdn.example.com/a/b', '//cdn.example.com', '/a/b', '/a/b'],
    ['/api/docs/${docId}/share', '', '/api/docs/{}/share', '/api/docs/:docId/share'],
    ['/api/docs/{docId}/share', '', '/api/docs/{}/share', '/api/docs/:docId/share'],
    ['/api/docs/:docId/share', '', '/api/docs/{}/share', '/api/docs/:docId/share'],
    ['/api/users/${user.profile.id}', '', '/api/users/{}', '/api/users/:id'],
    ['/api/users/${a + b}', '', '/api/users/{}', '/api/users/:param'],
    ['/files/user-${id}.json', '', '/files/{}', '/files/:id'],
    ['EXPR/users/EXPR', '', '/users/{}', '/users/:param'],
    ['${API_BASE}/users', '', '/users', '/users'],
    ['{base}/orders/{}', '', '/orders/{}', '/orders/:param'],
    ['/{tenant}/users', '', '/{}/users', '/:tenant/users'],
    ['/items/550e8400-e29b-41d4-a716-446655440000', '', '/items/{}', '/items/:id'],
    ['/objects/507f1f77bcf86cd799439011', '', '/objects/{}', '/objects/:id'],
    ['/words/deadbeef/cafebabe12', '', '/words/deadbeef/{}', '/words/deadbeef/:id'],
    ['api//v2/./things', '', '/api/v2/things', '/api/v2/things'],
    ['https://${host}.example.com/x', 'https://{}.example.com', '/x', '/x'],
    ['https://api.example.com', 'https://api.example.com', '/', '/'],
  ])('%s', (input, origin, pathNorm, pathTemplate) => {
    expect(normalizeEndpointUrl(input)).toMatchObject({ origin, pathNorm, pathTemplate });
  });

  it('separates query parameter names and drops values and fragments', () => {
    expect(normalizeEndpointUrl('/search?q=${term}&page=2&page=3&sort&${dyn}=1&a%20b=x#top')).toMatchObject({
      pathNorm: '/search',
      queryParams: ['q', 'page', 'sort', 'a b'],
    });
  });

  it('reports named path parameters and the scheme', () => {
    expect(normalizeEndpointUrl('https://x.example.com/a/${orgId}/b/{repoId}/c/42')).toMatchObject({
      scheme: 'https',
      pathParams: ['orgId', 'repoId'],
    });
    expect(normalizeEndpointUrl('/a')?.scheme).toBeNull();
  });

  it('rejects non-HTTP schemes and empty input', () => {
    for (const bad of ['', '   ', 'mailto:a@example.com', 'javascript:alert(1)', 'data:text/html,x', 'blob:https://x/1', 'ftp://x/y']) {
      expect(normalizeEndpointUrl(bad)).toBeNull();
    }
  });
});
