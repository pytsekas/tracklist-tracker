import { createRemoteJWKSet, jwtVerify } from 'jose';

export const IAP_ISSUER = 'https://cloud.google.com/iap';
export const IAP_JWKS_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';
export const IAP_HEADER = 'x-goog-iap-jwt-assertion';

let remote = null;

/** Google's IAP signing keys, fetched once and cached for six hours. */
export function iapKeys(url = IAP_JWKS_URL) {
  remote ??= createRemoteJWKSet(new URL(url), { cacheMaxAge: 6 * 60 * 60 * 1000 });
  return remote;
}

/**
 * Verify an IAP assertion. Throws on anything short of a valid one — there is
 * no partial success and no anonymous fallback.
 *
 * `audience` is Cloud Run's form,
 *   /projects/PROJECT_NUMBER/locations/REGION/services/SERVICE_NAME
 * which is NOT the App Engine or backend-service form used by most IAP sample
 * code. It arrives as IAP_AUDIENCE from Terraform rather than being assembled
 * here: a hand-built audience is a check that passes for the wrong service.
 */
export async function verifyAssertion(token, { audience, keys = iapKeys() }) {
  // jose only checks `aud` when this option is not undefined — an unset
  // audience silently skips the check rather than failing it, so a caller
  // that forwards a missing config value gets a verifier that accepts any
  // IAP-signed assertion for any service. Guard it here, where the check is.
  if (!audience) throw new Error('verifyAssertion requires an IAP audience');

  const { payload } = await jwtVerify(token, keys, {
    issuer: IAP_ISSUER,
    audience,
    algorithms: ['ES256'], // an allowlist of one; this is what rejects alg:none
    requiredClaims: ['exp'], // jose only requires exp when asked; IAP always sets it
  });
  if (!payload.email) throw new Error('IAP assertion carries no email claim');
  return { email: payload.email, sub: payload.sub };
}

/**
 * Express middleware putting `{ email }` on `req.user`.
 *
 * `devEmail` is for localhost, where IAP does not exist. It is only ever passed
 * when K_SERVICE is unset (see index.js) — on Cloud Run a missing audience is a
 * fatal boot error, never a silent downgrade to an unauthenticated user.
 */
export function requireUser({ audience, devEmail = null, keys = undefined }) {
  if (!devEmail && !audience) {
    throw new Error('requireUser needs an IAP audience, or a devEmail for local use');
  }

  return async (req, res, next) => {
    if (devEmail) {
      req.user = { email: devEmail };
      return next();
    }

    const token = req.get(IAP_HEADER);
    if (!token) return res.status(401).json({ error: 'missing IAP assertion' });

    try {
      req.user = await verifyAssertion(token, { audience, keys });
      next();
    } catch (err) {
      // Deliberately terse to the client: the reason goes to the log.
      console.warn(`rejected IAP assertion: ${err.code ?? ''} ${err.message}`);
      res.status(statusFor(err)).json({
        error: statusFor(err) === 503 ? 'cannot verify identity' : 'invalid IAP assertion',
      });
    }
  };
}

/**
 * 403 when the token is at fault, 503 when we could not reach Google's keys to
 * judge it. Both fail closed — the distinction exists so that an IAP or network
 * outage reads as an outage in the logs rather than as a flood of rejected
 * users, and so a client can sensibly retry the second but not the first.
 */
function statusFor(err) {
  const code = err.code ?? '';
  const tokenFault =
    code.startsWith('ERR_JWT_') ||
    code.startsWith('ERR_JWS_') ||
    code.startsWith('ERR_JOSE_') ||
    code === 'ERR_JWKS_NO_MATCHING_KEY' ||
    /email claim/.test(err.message);
  return tokenFault ? 403 : 503;
}
