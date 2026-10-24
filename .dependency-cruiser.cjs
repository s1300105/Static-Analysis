/**
 * Enforces the one-way dependency direction from docs/architecture.md §1:
 *   @sa/types -> (nothing)   @sa/core -> @sa/types only
 *   @sa/cli / @sa/mcp -> @sa/core, @sa/types   (and nobody imports cli/mcp)
 * Package names resolve to packages/<name>/src via the root tsconfig paths.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make the layering impossible to reason about.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'types-is-leaf',
      severity: 'error',
      comment: '@sa/types must not depend on any other workspace package.',
      from: { path: '^packages/types/src' },
      to: { path: '^packages/(core|cli|mcp|orchestrator|eval)/src' },
    },
    {
      name: 'core-depends-on-types-only',
      severity: 'error',
      comment: '@sa/core may use @sa/types but never an entry-point package.',
      from: { path: '^packages/core/src' },
      to: { path: '^packages/(cli|mcp|orchestrator|eval)/src' },
    },
    {
      name: 'entry-points-are-not-imported',
      severity: 'error',
      comment: 'cli/mcp/orchestrator are entry points; nothing may import them.',
      from: { pathNot: '^packages/(cli|mcp|orchestrator)/' },
      to: { path: '^packages/(cli|mcp|orchestrator)/src' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    exclude: { path: '(^|/)(dist|node_modules)/|\\.test\\.ts$' },
    enhancedResolveOptions: {
      extensions: ['.ts', '.js', '.json'],
    },
  },
};
