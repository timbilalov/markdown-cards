// Proposed field contract, independent of the production validator.
export const loginCredentials = { username: 'test-user', password: 'cycle13-test-password' };
export const loginOrigin = 'https://app.example.invalid';
const fields = JSON.stringify(loginCredentials).slice(1, -1);

function withMember(member: string): string {
  return `{${fields},${member}}`;
}

export const invalidLoginFields = [
  { name: 'extra field before missing credentials', body: '{"role":"admin"}' },
  ...[
    ['extra role', '"role":"admin"'],
    ['extra redirect', '"redirect":"https://foreign.example.invalid"'],
    ['obsolete csrf field', '"csrf_token":"synthetic-obsolete-csrf"'],
    ['nested extra field', '"profile":{"username":"test-user"}'],
    ['prototype key', '"__proto__":{"rememberMe":true}'],
    ['constructor key', '"constructor":"synthetic-constructor"']
  ].map(([name, member]) => ({ name, body: withMember(member) })),
  { name: 'duplicate identical username', body: withMember('"username":"test-user"') },
  { name: 'duplicate username with valid last value',
    body: `{"username":"wrong-user",${fields}}` },
  { name: 'duplicate username with invalid last value', body: withMember('"username":"wrong-user"') },
  { name: 'duplicate identical password', body: withMember(`"password":${JSON.stringify(loginCredentials.password)}`) },
  { name: 'duplicate password with valid last value', body: `{"password":"wrong-password",${fields}}` },
  { name: 'duplicate identical rememberMe', body: withMember('"rememberMe":false,"rememberMe":false') },
  { name: 'duplicate conflicting rememberMe', body: withMember('"rememberMe":false,"rememberMe":true') },
  { name: 'escaped duplicate username', body: withMember(' "\\u0075sername"\n :\t "test-user" ') },
  { name: 'escaped duplicate rememberMe', body: withMember('"rememberMe":false,"remem\\u0062erMe":true') },
  ...[
    ['leading username whitespace', ' test-user'],
    ['trailing username whitespace', 'test-user '],
    ['whitespace-only username', '   '],
    ['username newline', 'test\nuser'],
    ['username NUL', 'test\u0000user'],
    ['username DEL', 'test\u007fuser'],
    ['lone high surrogate in username', 'test\ud800user'],
    ['lone low surrogate in username', 'test\udc00user'],
    ['257-unit username', 'a'.repeat(257)],
    ['258-unit Unicode username', '🗂'.repeat(129)]
  ].map(([name, username]) => ({ name, body: JSON.stringify({ ...loginCredentials, username }) })),
  ...[
    ['lone high surrogate in password', 'secret\ud800'],
    ['lone low surrogate in password', 'secret\udc00']
  ].map(([name, password]) => ({ name, body: JSON.stringify({ ...loginCredentials, password }) }))
];

// Native Response.json() replaces these bytes, yielding valid but different JSON
// strings. Invalid encoding must be refused before credentials are compared.
export const invalidLoginBytes = [
  { name: 'invalid UTF-8 byte', invalid: [0xff] },
  { name: 'truncated UTF-8 sequence', invalid: [0xe2, 0x82] }
].map(({ name, invalid }) => ({ name, bytes: [
  ...new TextEncoder().encode('{"username":"test-user","password":"'),
  ...invalid,
  ...new TextEncoder().encode('"}')
] }));

// Accepted edge values are exercised as recovery after malformed requests.
// Do not normalize username/password or mistake JSON punctuation for field keys.
export const loginRecoveryCredentials = [
  loginCredentials,
  { username: 'u'.repeat(256), password: ' exact password with spaces ' },
  { username: '🗂'.repeat(128), password: 'Пароль 🗂' },
  { username: 'user name', password: '"username":"decoy",{"rememberMe":true}\\' },
  { username: 'пользователь-e\u0301', password: 'e\u0301 unchanged' },
  { username: 'replacement-\ufffd', password: 'literal-\ufffd' }
];
