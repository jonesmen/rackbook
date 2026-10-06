// Minimaler OpenID-Connect-Provider für Tests (verhält sich wie Authentik: Gruppen im Claim "groups").
import http from 'node:http';
import { generateKeyPairSync, createSign, createHash, randomBytes } from 'node:crypto';

const b64u = b => Buffer.from(b).toString('base64url');

export async function startMockIdp({ clientId = 'rackbook', clientSecret = 'geheim' } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const tokens = new Map();
  const state = { user: { sub: 'u-1', preferred_username: 'alice', name: 'Alice Admin', email: 'alice@example.org', groups: [] } };
  let issuer;

  const sign = payload => {
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }));
    const body = b64u(JSON.stringify(payload));
    const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
    return `${head}.${body}.${sig}`;
  };
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const readBody = req => new Promise(r => { let d = ''; req.on('data', c => { d += c; }); req.on('end', () => r(d)); });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer, authorization_endpoint: issuer + 'authorize', token_endpoint: issuer + 'token', userinfo_endpoint: issuer + 'userinfo',
        jwks_uri: issuer + 'jwks', end_session_endpoint: issuer + 'end-session', response_types_supported: ['code'],
        subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      if (p.get('client_id') !== clientId || p.get('code_challenge_method') !== 'S256') return json(res, 400, { error: 'invalid_request' });
      const code = b64u(randomBytes(16));
      codes.set(code, { nonce: p.get('nonce'), challenge: p.get('code_challenge'), redirect: p.get('redirect_uri'), user: { ...state.user } });
      const to = new URL(p.get('redirect_uri'));
      to.searchParams.set('code', code);
      to.searchParams.set('state', p.get('state'));
      to.searchParams.set('iss', issuer);
      res.writeHead(302, { location: to.href }); return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const p = new URLSearchParams(await readBody(req));
      const c = codes.get(p.get('code'));
      codes.delete(p.get('code'));
      if (!c || p.get('client_id') !== clientId || p.get('client_secret') !== clientSecret) return json(res, 400, { error: 'invalid_grant' });
      if (createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
      if (p.get('redirect_uri') !== c.redirect) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri' });
      const now = Math.floor(Date.now() / 1000);
      const at = b64u(randomBytes(16));
      tokens.set(at, c.user);
      const idToken = sign({ iss: issuer, aud: clientId, sub: c.user.sub, iat: now, exp: now + 300, nonce: c.nonce, preferred_username: c.user.preferred_username, name: c.user.name });
      return json(res, 200, { access_token: at, token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    if (url.pathname === '/userinfo') {
      const u = tokens.get(String(req.headers.authorization || '').replace(/^Bearer /, ''));
      return u ? json(res, 200, u) : json(res, 401, { error: 'invalid_token' });
    }
    if (url.pathname === '/end-session') { res.writeHead(200); return res.end('bye'); }
    json(res, 404, { error: 'not_found' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${server.address().port}/`;
  return { issuer, clientId, clientSecret, state, close: () => server.close() };
}
