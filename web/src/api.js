export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function doFetch(path, method, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || res.statusText);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function api(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  try {
    return await doFetch(path, method, body, timeoutMs);
  } catch (err) {
    // A real HTTP error response (4xx/5xx) is not a transport failure — surface it as-is.
    if (err instanceof ApiError) throw err;

    // Retry is GET-only: GETs are safe to repeat, but POST/PUT/PATCH/DELETE may
    // have already mutated server state, so retrying them could duplicate the
    // mutation. Only retry once, after a short delay, on transport failures
    // (network errors or a timeout abort).
    if (method === 'GET') {
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        return await doFetch(path, method, body, timeoutMs);
      } catch (retryErr) {
        if (retryErr instanceof ApiError) throw retryErr;
        throw new ApiError(
          0,
          retryErr.name === 'AbortError'
            ? 'Request timed out. Please try again.'
            : 'Network error — please check your connection and try again.'
        );
      }
    }

    throw new ApiError(
      0,
      err.name === 'AbortError'
        ? 'Request timed out. Please try again.'
        : 'Network error — please check your connection and try again.'
    );
  }
}
