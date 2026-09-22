import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import { verifyAssertion, requireUser, IAP_ISSUER, IAP_HEADER } from '../src/auth.js';

const AUDIENCE = '/projects/123456789/locations/europe-north1/services/tracklist-browser';
const EMAIL = 'marko@example.com';

let keys, signer, wrongSigner;

/** Sign an assertion the way IAP would, with overridable claims. */
const assertion = async (over = {}, key = signer) =>
  new SignJWT({ email: EMAIL, ...over.claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(over.issuer ?? IAP_ISSUER)
    .setAudience(over.audience ?? AUDIENCE)
    .setSubject('accounts.google.com:1234')
    .setIssuedAt(over.iat ?? Math.floor(Date.now() / 1000))
    .setExpirationTime(over.exp ?? '5m')
    .sign(key);

before(async () => {
  const pair = await generateKeyPair('ES256');
  const other = await generateKeyPair('ES256');
  signer = pair.privateKey;
  wrongSigner = other.privateKey;
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'ES256' }],
  });
});

test('a well-formed assertion yields the email', async () => {
  const user = await verifyAssertion(await assertion(), { audience: AUDIENCE, keys });
  assert.equal(user.email, EMAIL);
});

test('an expired assertion is rejected', async () => {
  const token = await assertion({ iat: 1600000000, exp: 1600000060 });
  await assert.rejects(() => verifyAssertion(token, { audience: AUDIENCE, keys }));
});

test('a wrong audience is rejected', async () => {
  const token = await assertion({ audience: '/projects/123456789/apps/some-other-app' });
  await assert.rejects(() => verifyAssertion(token, { audience: AUDIENCE, keys }));
});

test('a wrong issuer is rejected', async () => {
  const token = await assertion({ issuer: 'https://evil.example.com' });
  await assert.rejects(() => verifyAssertion(token, { audience: AUDIENCE, keys }));
});

test('an assertion signed by an unknown key is rejected', async () => {
  const token = await assertion({}, wrongSigner);
  await assert.rejects(() => verifyAssertion(token, { audience: AUDIENCE, keys }));
});

test('an alg:none assertion is rejected', async () => {
  // Hand-built, because no signing library will produce this for us.
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = [
    b64({ alg: 'none', typ: 'JWT' }),
    b64({ iss: IAP_ISSUER, aud: AUDIENCE, email: EMAIL, exp: Math.floor(Date.now() / 1000) + 300 }),
    '',
  ].join('.');
  await assert.rejects(() => verifyAssertion(token, { audience: AUDIENCE, keys }));
});

test('an assertion with no email claim is rejected', async () => {
  const token = await assertion({ claims: { email: undefined } });
  await assert.rejects(
    () => verifyAssertion(token, { audience: AUDIENCE, keys }),
    /email/);
});

test('verifyAssertion rejects when called with no audience', async () => {
  // jose only checks `aud` when the option is not undefined — an omitted
  // audience must not silently skip the check.
  const token = await assertion();
  await assert.rejects(
    () => verifyAssertion(token, { audience: undefined, keys }),
    /audience/);
});

test('a correctly signed assertion for a different service is rejected', async () => {
  // Positive control: proves the audience check does real work, so the
  // "no audience" test above isn't passing for the wrong reason.
  const token = await assertion({ audience: '/projects/123456789/locations/europe-north1/services/some-other-service' });
  await assert.rejects(() => verifyAssertion(token, { audience: AUDIENCE, keys }));
});

/* ------------------------------- middleware -------------------------------- */

async function serve(middleware) {
  const app = express();
  app.use(middleware);
  app.get('/whoami', (req, res) => res.json({ email: req.user.email }));
  const server = app.listen(0);
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('requireUser rejects a request with no assertion', async () => {
  const { server, base } = await serve(requireUser({ audience: AUDIENCE, keys }));
  const res = await fetch(`${base}/whoami`);
  assert.equal(res.status, 401);
  server.close();
});

test('requireUser rejects a forged assertion with 403', async () => {
  const { server, base } = await serve(requireUser({ audience: AUDIENCE, keys }));
  const res = await fetch(`${base}/whoami`, {
    headers: { [IAP_HEADER]: await assertion({}, wrongSigner) },
  });
  assert.equal(res.status, 403);
  server.close();
});

test('requireUser accepts a good assertion', async () => {
  const { server, base } = await serve(requireUser({ audience: AUDIENCE, keys }));
  const res = await fetch(`${base}/whoami`, { headers: { [IAP_HEADER]: await assertion() } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { email: EMAIL });
  server.close();
});

test('an unreachable JWKS is 503, not 403', async () => {
  // The keys resolver is what jose calls to fetch a signing key; a network
  // failure surfaces here. It must not look like a rejected user.
  const unreachable = () => { throw Object.assign(new Error('fetch failed'), { code: 'ERR_JWKS_TIMEOUT' }); };
  const { server, base } = await serve(requireUser({ audience: AUDIENCE, keys: unreachable }));
  const res = await fetch(`${base}/whoami`, { headers: { [IAP_HEADER]: await assertion() } });
  assert.equal(res.status, 503);
  server.close();
});

test('an unreachable JWKS still refuses the request', async () => {
  const unreachable = () => { throw Object.assign(new Error('fetch failed'), { code: 'ERR_JWKS_TIMEOUT' }); };
  const { server, base } = await serve(requireUser({ audience: AUDIENCE, keys: unreachable }));
  const res = await fetch(`${base}/whoami`, { headers: { [IAP_HEADER]: await assertion() } });
  assert.notEqual(res.status, 200, 'failing open would disable the only access control the site has');
  server.close();
});

test('devEmail bypasses verification entirely', async () => {
  const { server, base } = await serve(requireUser({ devEmail: 'dev@localhost' }));
  const res = await fetch(`${base}/whoami`);
  assert.deepEqual(await res.json(), { email: 'dev@localhost' });
  server.close();
});

test('requireUser refuses to be constructed with neither audience nor devEmail', () => {
  assert.throws(() => requireUser({}), /audience/);
});
