import { escapeHtml } from 'tiny-escape';

export class Renderer {
  constructor(root) {
    this.root = root;
  }

  renderUnsafe(html) {
    this.root.innerHTML = html;
  }

  renderText(text) {
    this.root.innerHTML = escapeHtml(text);
  }
}
