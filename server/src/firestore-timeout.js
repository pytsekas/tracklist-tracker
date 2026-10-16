// The SDK retries a downed backend on its own before ever rejecting — up to
// ~42s to exhaust its retries on a read, verified empirically against a host
// that refuses every connection. That budget comes from a lookup internal to
// the SDK (`getServiceConfig` in @google-cloud/firestore's util.js, which
// constructs its retry config with `{}` as the override argument — hardcoded,
// not sourced from anything passed to the `Firestore` constructor), so it
// cannot be shortened through public settings. Left alone, a Firestore outage
// would make every annotation write hang for ~42s before the 502 the spec
// promises, burning Cloud Run request time for nothing. Racing every call
// against a short, driver-owned deadline is the only way to keep that
// promise; the timeout is a production feature, not a test device.
export const FIRESTORE_TIMEOUT_MS = 5000;

/**
 * Race a Firestore call against a driver-owned deadline. Shared by the
 * annotation and favourites drivers so there is one copy of the reasoning
 * above and one copy of the late-success warning below.
 */
export function withTimeout(promise, ms, label) {
  let timer;
  let firedLate = false;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      firedLate = true;
      reject(new Error(`Firestore call timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timedOut]).finally(() => {
    clearTimeout(timer);
    // The loser is a real call the SDK may still be retrying in the
    // background, and an abandoned runTransaction can still go on to commit —
    // the client already got its 502 and moved on, so a late success here
    // must not surface as an unhandled rejection. The warning is gated on
    // `firedLate`, not just on `promise` resolving: without that guard, an
    // ordinary call that wins the race well inside `ms` would also log "after
    // its deadline had already fired", which is false, and at request rate
    // that false line would drown out the one case this exists to catch.
    promise.then(
      () => { if (firedLate) console.warn(`Firestore ${label} completed after its ${ms}ms deadline had already fired`); },
      () => {});
  });
}
