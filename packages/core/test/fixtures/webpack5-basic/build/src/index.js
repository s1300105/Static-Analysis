import { Renderer } from './render';
import { GREETING } from './greeting';

const renderer = new Renderer(document.getElementById('app'));
renderer.renderText(GREETING);

window.addEventListener('hashchange', () => {
  import(/* webpackChunkName: "lazy" */ './lazy').then((m) => m.showFromHash(renderer));
});
