// api/send-invite.js — Vercel Serverless Function (CampSync)
// Po vytvorení pozvánky pošle pozvanému upozornenie (push) a e-mail.
// Server overí, kto volá, že pozvánku vytvoril on (pred menej ako 15 min) a že je členom partie.
// Text skladá server — cez tento endpoint sa nedá poslať ľubovoľná správa.
//
// Premenné vo Verceli (Settings → Environment Variables):
//   FIREBASE_SERVICE_ACCOUNT  povinná (už existuje)
//   APP_URL                   napr. https://tvojadomena.sk (bez lomky na konci)
//   E-mail (nepovinné — bez toho sa pošle len push):
//     SMTP_USER   napr. campsync1@gmail.com
//     SMTP_PASS   heslo aplikácie z Google účtu (16 znakov, NIE bežné heslo)
//     SMTP_HOST   nepovinné, predvolene smtp.gmail.com (WebSupport: smtp.m1.websupport.sk)
//     MAIL_FROM   nepovinné, predvolene  CampSync <SMTP_USER>
//   (alternatíva: RESEND_API_KEY + MAIL_FROM)
//   Potrebuje balík nodemailer → súbor package.json v koreni repozitára.

const WORLDS = { camp: '⛺ Camping', fish: '🎣 Fishing', chat: '🏡 Cabin' };
const MAX_AGE_MS = 15 * 60 * 1000;

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST requests only' });

  try {
    const { idToken, email, mode } = req.body || {};
    const to = String(email || '').trim().toLowerCase();
    if (!/^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/.test(to) || !WORLDS[mode]) return res.status(400).json({ error: 'Missing data' });

    const me = await verifyIdToken(idToken);
    if (!me) return res.status(401).json({ error: 'Not signed in' });

    const token = await getAccessToken();

    /* pozvánka musí existovať, byť od volajúceho a čerstvá */
    const invDoc = await fsGet(['invites', to], token);
    const inv = invDoc && invDoc[mode];
    if (!inv || inv.invitedBy !== me.uid) return res.status(403).json({ error: 'Invitation not found' });
    if (!inv.ts || Date.now() - Number(inv.ts) > MAX_AGE_MS) return res.status(403).json({ error: 'Invitation is too old' });

    /* volajúci musí byť členom partie a pozvaný e-mail v nej zapísaný */
    const party = await fsGet(['parties', String(inv.partyId || '')], token);
    if (!party || !(party.members || {})[me.uid] || !(party.memberEmails || []).includes(to)) {
      return res.status(403).json({ error: 'Crew does not match' });
    }

    const who = clip(inv.invitedByName || 'A friend', 60);
    const partyName = clip(party.name || inv.partyName || 'crew', 60);
    const world = WORLDS[mode];

    /* 1) push na zariadenia pozvaného (ak má zapnutý 🔔) */
    let pushed = 0;
    const pt = await fsGet(['pushTokens', to], token);
    const tokens = [...new Set(((pt && pt.tokens) || []).filter(Boolean))];
    if (tokens.length) {
      const { sent, dead } = await sendFcm(token, tokens, {
        title: '✉️ New invitation',
        body: `${who} invites you to the crew "${partyName}" (${world})`,
        link: `${APP_URL}/app.html?tab=invite&mode=${mode}`
      });
      pushed = sent;
      await fsRemoveTokens(['pushTokens', to], 'tokens', dead, token);
    }

    /* 2) e-mail — cez SMTP (Gmail / WebSupport), prípadne cez Resend */
    let mailSent = false;
    const mail = {
      to,
      subject: `${who} invites you to the crew "${partyName}" ⛺`,
      html: inviteHtml({ who, party: partyName, world, appUrl: APP_URL, to }),
      text: inviteText({ who, party: partyName, world, appUrl: APP_URL, to })
    };
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      try {
        const nodemailer = (await import('nodemailer')).default;
        const host = process.env.SMTP_HOST || 'smtp.gmail.com';
        const transporter = nodemailer.createTransport({
          host, port: 465, secure: true,
          auth: { user: process.env.SMTP_USER, pass: String(process.env.SMTP_PASS).replace(/\s/g, '') }
        });
        await transporter.sendMail({ from: process.env.MAIL_FROM || `CampSync <${process.env.SMTP_USER}>`, ...mail });
        mailSent = true;
      } catch (e) {
        console.error('SMTP', e && e.message);   // e-mail zlyhal, push už odišiel — appka pokračuje
      }
    } else if (process.env.RESEND_API_KEY && process.env.MAIL_FROM) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env.MAIL_FROM, ...mail, to: [to] })
      });
      mailSent = r.ok;
      if (!r.ok) console.error('Resend', r.status, await r.text().catch(() => ''));
    }

    return res.status(200).json({ pushed, mailSent });
  } catch (e) {
    console.error('send-invite', e);
    return res.status(500).json({ error: e.message });
  }
}

/* ---------- obsah e-mailu ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function inviteHtml({ who, party, world, appUrl, to }) {
  const link = `${appUrl}/app.html`;
  return `<!doctype html><html lang="en"><body style="margin:0;padding:0;background:#0c1826;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0c1826;padding:28px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#f3ecdc;border-radius:18px;overflow:hidden">
  <tr><td style="background:#14212e;padding:20px 24px">
    <span style="font-size:22px;font-weight:bold;letter-spacing:1px;color:#f3ecdc">CAMP</span><span style="font-size:22px;font-weight:bold;letter-spacing:1px;color:#4da3ff">SYNC</span>
  </td></tr>
  <tr><td style="padding:26px 24px 8px;color:#14212e">
    <p style="margin:0 0 6px;font-size:15px;color:#6a6252">${esc(world)}</p>
    <h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:#14212e">${esc(who)} invites you to the crew "${esc(party)}"</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#26221a">CampSync gives your crew a shared packing list and a crew chat — all in one place.</p>
    <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#4da3ff;border-radius:12px">
      <a href="${link}" style="display:inline-block;padding:14px 26px;font-size:16px;font-weight:bold;color:#0c1826;text-decoration:none">Open CampSync</a>
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:20px 24px 26px;color:#26221a;font-size:14px;line-height:1.6">
    <b>How to join:</b><br>
    1. Open the app with the button above.<br>
    2. Sign in with the Google account for this address: <b>${esc(to)}</b><br>
    3. In the ✉️ Invite tab → Invitations, tap <b>Accept</b>.
  </td></tr>
  <tr><td style="background:#e7dcc4;padding:14px 24px;font-size:12px;color:#6a6252">
    You got this email because someone invited you to a crew in CampSync. If you don't know what this is about, just ignore it.
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

function inviteText({ who, party, world, appUrl, to }) {
  return `${who} invites you to the crew "${party}" (${world}) in CampSync.

How to join:
1. Open ${appUrl}/app.html
2. Sign in with the Google account for ${to}
3. In the Invite tab → Invitations, tap Accept.

If you don't know what this is about, just ignore this email.`;
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
