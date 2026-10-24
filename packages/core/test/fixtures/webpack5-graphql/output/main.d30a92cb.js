(()=>{"use strict";var e={979:e=>{var t,n={fragment:{argumentDefinitions:t=[{defaultValue:null,kind:"LocalArgument",name:"userId"},{defaultValue:null,kind:"LocalArgument",name:"withPosts"}],kind:"Fragment",metadata:null,name:"UserProfileQuery",selections:[],type:"Query"},kind:"Request",operation:{argumentDefinitions:t,kind:"Operation",name:"UserProfileQuery",selections:[]},params:{cacheID:"5b8c6c3a5a0f5e4d9f1a2b3c4d5e6f70",id:"7f3a9c2e1b4d6f8a0c2e4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a",metadata:{},name:"UserProfileQuery",operationKind:"query",text:null}};e.exports=n}},t={};function n(i){var r=t[i];if(void 0!==r)return r.exports;var a=t[i]={exports:{}};return e[i](a,a.exports,n),a.exports}n.d=(e,t)=>{for(var i in t)n.o(t,i)&&!n.o(e,i)&&Object.defineProperty(e,i,{enumerable:!0,get:t[i]})},n.o=(e,t)=>Object.prototype.hasOwnProperty.call(e,t),n.r=e=>{"undefined"!=typeof Symbol&&Symbol.toStringTag&&Object.defineProperty(e,Symbol.toStringTag,{value:"Module"}),Object.defineProperty(e,"__esModule",{value:!0})};var i={};n.r(i),n.d(i,{DELETE_POST:()=>d,GET_FEED:()=>s,ON_MESSAGE:()=>u,POST_FIELDS:()=>o});var r={};function a(e,...t){return{kind:"Document",source:e.reduce((e,n,i)=>e+n+(i<t.length?t[i].source:""),"")}}n.r(r),n.d(r,{ADMIN_USERS:()=>l,UPDATE_SETTINGS:()=>c});const o=a`
  fragment PostFields on Post {
    id
    title
  }
`,s=a`
  query GetFeed($first: Int, $after: String) {
    feed(first: $first, after: $after) {
      ...PostFields
    }
  }
  ${o}
`,d=a`
  mutation DeletePost($id: ID!, $reason: String) {
    deletePost(id: $id, reason: $reason) {
      ok
    }
  }
`,u=a`
  subscription OnMessage($room: ID!) {
    message(room: $room) {
      id
      body
    }
  }
`,l={kind:"Document",definitions:[{kind:"OperationDefinition",operation:"query",name:{kind:"Name",value:"AdminUsers"},variableDefinitions:[{kind:"VariableDefinition",variable:{kind:"Variable",name:{kind:"Name",value:"role"}},type:{kind:"NamedType",name:{kind:"Name",value:"Role"}},directives:[]}],directives:[],selectionSet:{kind:"SelectionSet",selections:[{kind:"Field",name:{kind:"Name",value:"adminUsers"},arguments:[],directives:[]}]}}]},c={kind:"Document",definitions:[{kind:"OperationDefinition",operation:"mutation",name:{kind:"Name",value:"UpdateSettings"},variableDefinitions:[],directives:[],selectionSet:{kind:"SelectionSet",selections:[]}}],loc:{start:0,end:80,source:{body:"mutation UpdateSettings($input: SettingsInput!, $notify: Boolean) { updateSettings(input: $input) { ok } }",name:"GraphQL request"}}},m=n(979);window.App={queries:i,precompiled:r,search:function(e){return fetch("/graphql",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query:"query SearchUsers($q: String!) { searchUsers(q: $q) { id name } }",variables:{q:e}})})},notes:["query string is too long","mutation observer started",'{ "query": 1 }'],profileQuery:m}})();