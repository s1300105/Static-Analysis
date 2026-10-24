import { createClient } from './http';

const api = createClient({ baseURL: '/api/v2' });

export const getUser = (userId) => api.get(`/users/${userId}`, { params: { include: 'profile' } });
export const updateUser = (userId, data) => api.put(`/users/${userId}`, { displayName: data.name, email: data.email });
export const deleteDoc = (docId) => api.delete('/docs/' + docId);
export const adminStats = () => api.get('/admin/stats');
export const searchDocs = (term) => fetch(`/api/v2/search?q=${encodeURIComponent(term)}&limit=20`);

export function login(user, pass) {
  return fetch('https://auth.example.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Version': '3.1' },
    body: JSON.stringify({ username: user, password: pass, grant_type: 'password' }),
  });
}

export function legacyReport(id) {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/legacy/reports/' + id + '/export');
  xhr.send();
}

export const subscribe = () => new WebSocket('wss://rt.example.com/socket');
export const ping = () => navigator.sendBeacon('/telemetry/ping', 'x');
export const legacySearch = ($) => $.ajax({ url: '/api/v1/legacy-search', type: 'POST', data: { query: 'x', page: 1 } });

// エンドポイントではないもの（誤検出の確認用）
export const routes = [{ path: '/users/:id' }, { path: '/settings' }];
export const contentType = (headers) => headers.get('content-type');
export const nextParam = (search) => new URLSearchParams(search).get('next');
export const logo = '/static/logo.png';
