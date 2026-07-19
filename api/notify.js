// api/notify.js - Vercel Serverless Function (CampSync)
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Len POST požiadavky' });

    const { title, body, tokens } = req.body;

    if (!tokens || tokens.length === 0) {
        return res.status(400).json({ error: 'Žiadne tokeny' });
    }

    const projectId = "camp-5b677";

    try {
        const accessToken = await getAccessToken();

        const rawResults = await Promise.allSettled(
            tokens.map(token =>
                fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        message: {
                            token: token,
                            data: {
                                title: title || '⛺ CampSync',
                                body: body || 'Novinka v partii'
                            },
                            notification: {
                                title: title || '⛺ CampSync',
                                body: body || 'Novinka v partii'
                            },
                            webpush: {
                                headers: {
                                    Urgency: 'normal',
                                    TTL: '3600'
                                },
                                notification: {
                                    title: title || '⛺ CampSync',
                                    body: body || 'Novinka v partii',
                                    icon: '/icon-192.png',
                                    badge: '/icon-192.png',
                                    vibrate: [150, 80, 150],
                                    tag: 'campsync-items'
                                },
                                fcm_options: { link: '/app.html' }
                            }
                        }
                    })
                }).then(async r => ({ status: r.status, body: await r.json() }))
            )
        );

        const sent = rawResults.filter(r => r.status === 'fulfilled' && r.value.status === 200).length;
        return res.status(200).json({ success: true, sent, total: tokens.length });

    } catch (error) {
        console.error('FCM chyba:', error);
        return res.status(500).json({ error: error.message });
    }
}

async function getAccessToken() {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iss: serviceAccount.client_email,
        sub: serviceAccount.client_email,
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
        scope: 'https://www.googleapis.com/auth/firebase.messaging'
    };
    const jwt = await createJWT(payload, serviceAccount.private_key);
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: jwt
        })
    });
    const data = await response.json();
    if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data));
    return data.access_token;
}

async function createJWT(payload, privateKey) {
    const header = { alg: 'RS256', typ: 'JWT' };
    const encode = obj => btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const signingInput = `${encode(header)}.${encode(payload)}`;
    const keyData = privateKey.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\s/g, '');
    const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey('pkcs8', binaryKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput));
    const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${signingInput}.${sigBase64}`;
}
