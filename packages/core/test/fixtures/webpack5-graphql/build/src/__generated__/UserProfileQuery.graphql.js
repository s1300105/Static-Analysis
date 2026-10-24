/**
 * Relay コンパイラが出す生成物の形（persisted query: text は null、id がハッシュ）
 * @flow
 */
'use strict';

var node = (function () {
  var v0 = [
    { defaultValue: null, kind: 'LocalArgument', name: 'userId' },
    { defaultValue: null, kind: 'LocalArgument', name: 'withPosts' },
  ];
  return {
    fragment: { argumentDefinitions: v0, kind: 'Fragment', metadata: null, name: 'UserProfileQuery', selections: [], type: 'Query' },
    kind: 'Request',
    operation: { argumentDefinitions: v0, kind: 'Operation', name: 'UserProfileQuery', selections: [] },
    params: {
      cacheID: '5b8c6c3a5a0f5e4d9f1a2b3c4d5e6f70',
      id: '7f3a9c2e1b4d6f8a0c2e4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a',
      metadata: {},
      name: 'UserProfileQuery',
      operationKind: 'query',
      text: null,
    },
  };
})();

module.exports = node;
