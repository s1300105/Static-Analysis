export function run() {
  return fetch('/api/reports/export', { method: 'POST' });
}
