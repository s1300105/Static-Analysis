import { greet } from './greeting';

export function showFromHash(renderer) {
  const name = decodeURIComponent(location.hash.slice(1));
  renderer.renderUnsafe(greet(name));
}
