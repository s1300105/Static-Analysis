import * as queries from './queries';
import * as precompiled from './precompiled';
import { notes, search } from './client';

// Relay の生成物は CommonJS（モジュールマップに別のモジュールとして残る）
const profileQuery = require('./__generated__/UserProfileQuery.graphql');

// 本番ビルドで消されないように全部をぶら下げる
window.App = { queries, precompiled, search, notes, profileQuery };
