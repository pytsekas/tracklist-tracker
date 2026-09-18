import { useEffect, useState } from 'react';

/** Tiny data-loading helper: returns { data, error, loading, reload }. */
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setState(s => ({ ...s, loading: true }));
    Promise.resolve(fn())
      .then(data => alive && setState({ data, error: null, loading: false }))
      .catch(error => alive && setState({ data: null, error, loading: false }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { ...state, reload: () => setNonce(n => n + 1) };
}
