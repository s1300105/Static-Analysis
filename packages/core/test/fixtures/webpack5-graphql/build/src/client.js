// 文字列の本文を fetch で送る（ast_url が POST /graphql、graphql_text が operation を拾う）
export function search(q) {
  return fetch('/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'query SearchUsers($q: String!) { searchUsers(q: $q) { id name } }', variables: { q } }),
  });
}

// GraphQL に見えるが GraphQL ではない文字列（拾ってはいけない）
export const notes = ['query string is too long', 'mutation observer started', '{ "query": 1 }'];
