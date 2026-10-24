// axios に似た小さな HTTP クライアント（ベース URL つきのインスタンス）
export function createClient(config) {
  const base = config.baseURL;
  const send = (method, url, data, opts = {}) =>
    fetch(base + url + (opts.params ? '?' + new URLSearchParams(opts.params) : ''), {
      method,
      body: data && JSON.stringify(data),
      headers: opts.headers,
    });
  return {
    get: (url, opts) => send('GET', url, undefined, opts),
    post: (url, data, opts) => send('POST', url, data, opts),
    put: (url, data, opts) => send('PUT', url, data, opts),
    delete: (url, opts) => send('DELETE', url, undefined, opts),
  };
}
