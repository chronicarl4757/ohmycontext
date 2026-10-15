// token readers for site APIs — run in page/content context only (not node-testable)

export function unwrapToken(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim().replace(/^"|"$/g, '');
  if (t.startsWith('{')) {
    try {
      const v = (JSON.parse(t) as Record<string, unknown>).value;
      return typeof v === 'string' && v ? v : null;
    } catch {
      return null;
    }
  }
  return t || null;
}

export function readDeepSeekToken(): string | null {
  try {
    return unwrapToken(localStorage.getItem('userToken'));
  } catch {
    return null;
  }
}

export function readKimiToken(): string | null {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.includes('access_token')) {
        const v = unwrapToken(localStorage.getItem(k));
        if (v) return v;
      }
    }
  } catch {
    // storage blocked
  }
  return null;
}

export async function readChatGptToken(fetchFn: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchFn('/api/auth/session', { credentials: 'include' });
    if (res.ok) {
      const t = (await res.json() as Record<string, unknown>).accessToken;
      if (typeof t === 'string' && t) return t;
    }
  } catch {
    // logged out / offline
  }
  return null;
}
