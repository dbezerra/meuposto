// Vercel Serverless Function: Proxies the backend HTTP API over HTTPS
// to avoid mixed-content and CORS in the browser.

export default async function handler(req, res) {
  try {
    const { filial = 'D MG 01' } = req.query || {};

    const backendBase = process.env.PORTAL_BACKEND_BASE || 'http://138.219.88.134:9090';
    const user = process.env.PORTAL_USER || 'admin';
    const pass = process.env.PORTAL_PASS || '1234';

    const url = `${backendBase}/rest/PORTALPRESTADOR/fotofunc?filial=${encodeURIComponent(filial)}`;

    const auth = Buffer.from(`${user}:${pass}`).toString('base64');

    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        'Accept': 'application/json, text/plain, */*'
      }
    });

    const text = await response.text();

    // Mirror status and content-type from backend if possible
    res.status(response.status);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json; charset=utf-8');
    res.send(text);
  } catch (e) {
    res.status(500).json({ error: 'Proxy error', details: e?.message || String(e) });
  }
}


