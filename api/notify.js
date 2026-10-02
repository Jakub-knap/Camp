// api/notify.js — Vercel Serverless Function (CampSync)
// Upozornenie ostatným členom partie. Server overí, kto volá (Firebase ID token),
// že je členom partie, a tokeny si zistí sám z partie — klient ich už neposiela.
//
// Premenné vo Verceli: FIREBASE_SERVICE_ACCOUNT (povinná), APP_URL (napr. https://tvojadomena.sk)

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST requests only' });

  try {
    const { idToken, partyId, title, body, link } = req.body || {};
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(partyId || ''))) return res.status(400).json({ error: 'Missing crew' });

    const me = await verifyIdToken(idToken);
    if (!me) return res.status(401).json({ error: 'Not signed in' });

    const token = await getAccessToken();
    const party = await fsGet(['parties', partyId], token);
    if (!party) return res.status(404).json({ error: 'Partia neexistuje' });
    const members = party.members || {};
    if (!members[me.uid]) return res.status(403).json({ error: 'You are not a member of this crew' });

    /* tokeny ostatných AKTUÁLNYCH členov (odídení a vyhodení nedostanú nič) */
    const owner = {};
    for (const [uid, arr] of Object.entries(party.fcmTokens || {})) {
      if (uid === me.uid || !members[uid]) continue;
      for (const t of (arr || [])) if (t) owner[t] = uid;
    }
    const tokens = Object.keys(owner);
    if (!tokens.length) return res.status(200).json({ success: true, sent: 0, total: 0 });

    const safeLink = /^\/app\.html(\?[\w=&%.-]*)?$/.test(String(link || '')) ? link : '/app.html';
    const { sent, dead } = await sendFcm(token, tokens, {
      title: clip(title, 80) || '⛺ CampSync',
      body: clip(body, 200) || 'Something new in your crew',
      link: APP_URL + safeLink
    });

    /* neplatné tokeny (odinštalovaná appka) odstráň z partie */
    const byUid = {};
    dead.forEach(t => { (byUid[owner[t]] = byUid[owner[t]] || []).push(t); });
    await Promise.all(Object.entries(byUid).map(([uid, vals]) =>
      fsRemoveTokens(['parties', partyId], `fcmTokens.\`${uid}\``, vals, token)));

    return res.status(200).json({ success: true, sent, total: tokens.length, removed: dead.length });
  } catch (e) {
    console.error('notify', e);
    return res.status(500).json({ error: e.message });
  }
}

/* ================== spoločné pomocné funkcie (rovnaké v notify.js aj send-invite.js) ================== */
const PROJECT_ID = 'camp-5b677';
const DB_ROOT = `projects/${PROJECT_ID}/databases/(default)/documents`;
const FS_URL = `https://firestore.googleapis.com/v1/${DB_ROOT}`;
const SCOPES = 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging';
const APP_URL = (process.env.APP_URL || 'https://camp-beta-teal.vercel.app').replace(/\/$/, '');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
const clip = (s, n) => String(s || '').slice(0, n);

/* ---------- base64url ---------- */
function b64urlToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
const b64urlToJson = s => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
const toB64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/* ---------- overenie Firebase prihlásenia (ID token) ----------
   Podpis sa overuje verejnými kľúčmi Googlu, takže sa nedá podvrhnúť, kto volá. */
let jwkCache = { keys: null, until: 0 };
async function googleKeys() {
  if (jwkCache.keys && Date.now() < jwkCache.until) return jwkCache.keys;
  const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  if (!r.ok) throw new Error('JWK ' + r.status);
  const d = await r.json();
  jwkCache = { keys: d.keys || [], until: Date.now() + 3600 * 1000 };
  return jwkCache.keys;
}
async function verifyIdToken(idToken) {
  try {
    const [h, p, sig] = String(idToken || '').split('.');
    if (!h || !p || !sig) return null;
    const header = b64urlToJson(h), payload = b64urlToJson(p);
    if (header.alg !== 'RS256') return null;
    const jwk = (await googleKeys()).find(k => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const now = Math.floor(Date.now() / 1000);
    if (payload.aud !== PROJECT_ID) return null;
    if (payload.iss !== `https://securetoken.google.com/${PROJECT_ID}`) return null;
    if (!payload.exp || payload.exp < now) return null;
    if (payload.iat && payload.iat > now + 300) return null;
    if (!payload.sub) return null;
    return { uid: payload.sub, email: String(payload.email || '').toLowerCase() };
  } catch (e) {
    return null;
  }
}

/* ---------- Google access token zo service accountu ---------- */
async function getAccessToken() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const enc = obj => toB64url(new TextEncoder().encode(JSON.stringify(obj)));
  const signingInput = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: sa.client_email, sub: sa.client_email, aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600, scope: SCOPES
  })}`;
  const keyData = sa.private_key.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\s/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(keyData), c => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput)));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${signingInput}.${toB64url(sig)}` })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Token error: ' + JSON.stringify(d));
  return d.access_token;
}

/* ---------- Firestore REST ---------- */
function fsDecode(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsDecode);
  if ('mapValue' in v) {
    const out = {};
    for (const [k, x] of Object.entries(v.mapValue.fields || {})) out[k] = fsDecode(x);
    return out;
  }
  return null;
}
/* path napr. ['parties', id] — segmenty sa bezpečne zakódujú */
async function fsGet(segments, token) {
  const r = await fetch(`${FS_URL}/${segments.map(encodeURIComponent).join('/')}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('Firestore ' + r.status);
  const d = await r.json();
  return fsDecode({ mapValue: { fields: d.fields || {} } });
}
/* odstráň neplatné tokeny z poľa v dokumente (arrayRemove na serveri) */
async function fsRemoveTokens(segments, fieldPath, values, token) {
  if (!values.length) return;
  await fetch(`https://firestore.googleapis.com/v1/${DB_ROOT}:commit`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writes: [{
        transform: {
          document: `${DB_ROOT}/${segments.join('/')}`,
          fieldTransforms: [{ fieldPath, removeAllFromArray: { values: values.map(t => ({ stringValue: t })) } }]
        }
      }]
    })
  }).catch(() => {});
}

/* ---------- odoslanie cez FCM (len dáta — notifikáciu zobrazí náš sw.js) ---------- */
async function sendFcm(accessToken, tokens, data) {
  const results = await Promise.allSettled(tokens.map(token =>
    fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token, data, webpush: { headers: { Urgency: 'normal', TTL: '3600' } } } })
    }).then(async r => ({ token, status: r.status, body: await r.json().catch(() => ({})) }))
  ));
  let sent = 0;
  const dead = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    if (r.value.status === 200) sent++;
    else if (r.value.status === 404 || JSON.stringify(r.value.body).includes('UNREGISTERED')) dead.push(r.value.token);
  }
  return { sent, dead };
}
/* ================== koniec spoločných funkcií ================== */
