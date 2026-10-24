/*!
 * sa-fixture-lib v1.2.3
 * (c) Example | MIT License
 */
export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
