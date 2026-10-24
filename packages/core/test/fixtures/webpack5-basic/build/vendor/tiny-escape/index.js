var VERSION = '1.2.3';
function escapeHtml(input) {
  return String(input).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}
module.exports = { escapeHtml: escapeHtml, VERSION: VERSION };
