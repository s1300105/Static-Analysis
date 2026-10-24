import { gql } from './gql';

export const POST_FIELDS = gql`
  fragment PostFields on Post {
    id
    title
  }
`;

export const GET_FEED = gql`
  query GetFeed($first: Int, $after: String) {
    feed(first: $first, after: $after) {
      ...PostFields
    }
  }
  ${POST_FIELDS}
`;

export const DELETE_POST = gql`
  mutation DeletePost($id: ID!, $reason: String) {
    deletePost(id: $id, reason: $reason) {
      ok
    }
  }
`;

export const ON_MESSAGE = gql`
  subscription OnMessage($room: ID!) {
    message(room: $room) {
      id
      body
    }
  }
`;
