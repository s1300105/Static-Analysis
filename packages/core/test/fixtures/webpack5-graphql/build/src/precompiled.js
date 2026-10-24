// babel-plugin-graphql-tag などがビルド時に変換した DocumentNode（loc.source.body がある形と無い形）
export const ADMIN_USERS = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'AdminUsers' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'role' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'Role' } },
          directives: [],
        },
      ],
      directives: [],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [{ kind: 'Field', name: { kind: 'Name', value: 'adminUsers' }, arguments: [], directives: [] }],
      },
    },
  ],
};

export const UPDATE_SETTINGS = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'UpdateSettings' },
      variableDefinitions: [],
      directives: [],
      selectionSet: { kind: 'SelectionSet', selections: [] },
    },
  ],
  loc: {
    start: 0,
    end: 80,
    source: {
      body: 'mutation UpdateSettings($input: SettingsInput!, $notify: Boolean) { updateSettings(input: $input) { ok } }',
      name: 'GraphQL request',
    },
  },
};
