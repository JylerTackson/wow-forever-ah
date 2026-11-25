// Shared Blizzard API client + config for the collector, server and sync scripts.
export const CLIENT_ID = process.env.BLIZZARD_CLIENT_ID;
export const CLIENT_SECRET = process.env.BLIZZARD_CLIENT_SECRET;
export const REGION = (process.env.REGION || "us").toLowerCase();
export const RULESET = process.env.RULESET_ID || "2"; // ignored by the API today, but required in the path
export const HOUSES = (process.env.HOUSES || "110,113,116").split(",").map((s) => Number(s.trim()));
export const API = `https://${REGION}.api.blizzard.com`;
export const LOCALE = { us: "en_US", eu: "en_GB", kr: "ko_KR", tw: "zh_TW" }[REGION] ?? "en_US";
export const NS = {
  dynamic: `dynamic-forever-${REGION}`,
  profile: `profile-forever-${REGION}`,
  // Static data: try Forever first, then Classic Era (fills most of Forever's item 404s).
  static: [`static-forever-${REGION}`, `static-classic1x-${REGION}`],
};

export function requireCredentials() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("Missing BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET in .env (run with node --env-file=.env ...)");
    process.exit(1);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const basicAuth = () => "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

// ---------- client-credentials token ----------
let token = null;
let tokenExpires = 0;
let tokenPromise = null;
export async function getToken() {
  if (token && Date.now() < tokenExpires - 60_000) return token;
  tokenPromise ??= (async () => {
    const res = await fetch("https://oauth.battle.net/token", {
      method: "POST",
      headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`token request failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    token = body.access_token;
    tokenExpires = Date.now() + body.expires_in * 1000;
    return token;
  })().finally(() => (tokenPromise = null));
  return tokenPromise;
}

// GET an API path. Returns { status, lastModified, json } and never throws on HTTP errors.
export async function apiGet(path, namespace, opts = {}) {
  const sep = path.includes("?") ? "&" : "?";
  return getUrl(`${API}${path}${sep}namespace=${namespace}&locale=${LOCALE}`, opts);
}

// GET a full href as returned inside Blizzard responses (already carries its namespace).
export async function hrefGet(href, opts = {}) {
  const u = new URL(href);
  if (!u.searchParams.has("locale")) u.searchParams.set("locale", LOCALE);
  return getUrl(u.toString(), opts);
}

async function getUrl(url, { ifModifiedSince, bearer } = {}) {
  const headers = { Authorization: `Bearer ${bearer ?? (await getToken())}` };
  if (ifModifiedSince) headers["If-Modified-Since"] = new Date(ifModifiedSince).toUTCString();
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const lm = res.headers.get("last-modified");
    return {
      status: res.status,
      lastModified: lm ? Date.parse(lm) : null,
      json: res.ok ? await res.json() : null,
    };
  }
}

// Try each static namespace in turn; returns { json, namespace } or { json: null }.
export async function staticGet(path) {
  for (const ns of NS.static) {
    const r = await apiGet(path, ns);
    if (r.json) return { json: r.json, namespace: ns };
  }
  return { json: null, namespace: null };
}

export async function iconFor(type, id) {
  const { json } = await staticGet(`/data/wow/media/${type}/${id}`);
  return json?.assets?.find((a) => a.key === "icon")?.value ?? null;
}

// Run fn over items with at most n in flight (Blizzard allows 100 req/s; we stay far below).
export async function pool(items, n, fn) {
  const queue = [...items];
  const results = [];
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      results.push(await fn(item));
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, queue.length || 1) }, worker));
  return results;
}

// ---------- user OAuth (authorization code flow, for "my characters") ----------
export function authorizeUrl(redirectUri, state) {
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: "wow.profile",
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });
  return `https://oauth.battle.net/authorize?${q}`;
}

export async function exchangeCode(code, redirectUri) {
  const res = await fetch("https://oauth.battle.net/token", {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  if (!res.ok) throw new Error(`code exchange failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { token: body.access_token, expires: Date.now() + (body.expires_in ?? 86400) * 1000 };
}
