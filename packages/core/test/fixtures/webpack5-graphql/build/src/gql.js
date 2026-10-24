// graphql-tag に似た小さなタグ（本番ビルドでは名前が短くなる）
export function gql(strings, ...values) {
  return { kind: 'Document', source: strings.reduce((acc, s, i) => acc + s + (i < values.length ? values[i].source : ''), '') };
}
