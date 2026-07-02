onst crypto = require('crypto');

// 1. ADD YOUR TUYA CREDENTIALS HERE
const CLIENT_ID = 'p9dpw35gs4wtjx3pwf8q'; 
const CLIENT_SECRET = '09e2028325d84c74a074fcdd647b1b27';
const DEVICE_ID = 'bfa7a6c82314556b7ey30d'; 

const HOST = 'https://openapi.tuyaeu.com';

function calcSign(clientId, accessToken, timestamp, nonce, stringToSign, secret) {
    const str = clientId + accessToken + timestamp + nonce + stringToSign;
    return crypto.createHmac('sha256', secret).update(str, 'utf8').digest('hex').toUpperCase();
}

async function tuyaRequest(path, method = 'GET', accessToken = '') {
    const timestamp = Date.now().toString();
    const nonce = ''; 
    
    const [urlPath, queryString] = path.split('?');
    let sortedPath = urlPath;
    
    if (queryString) {
        const params = new URLSearchParams(queryString);
        const sortedParams = Array.from(params.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([k, v]) => `${k}=${v}`)
            .join('&');
        sortedPath += '?' + sortedParams;
    }

    const contentHash = crypto.createHash('sha256').update('', 'utf8').digest('hex');
    const stringToSign = `${method}\n${contentHash}\n\n${sortedPath}`;
    
    const sign = calcSign(CLIENT_ID, accessToken, timestamp, nonce, stringToSign, CLIENT_SECRET);
    
    const response = await fetch(`${HOST}${sortedPath}`, {
        method: method,
        headers: {
            'client_id': CLIENT_ID,
            'access_token': accessToken,
            'sign': sign,
            'sign_method': 'HMAC-SHA256',
            't': timestamp,
            'nonce': nonce,
            'Content-Type': 'application/json'
        }
    });
    
    return await response.json();
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const tokenData = await tuyaRequest('/v1.0/token?grant_type=1');
        if (!tokenData.success) throw new Error("Token Error: " + tokenData.msg);
        const accessToken = tokenData.result.access_token;

        // Fetch GRAND TOTAL from Tuya Cloud Statistics instead of the Live Pulse
        const statusData = await tuyaRequest(`/v1.0/devices/${DEVICE_ID}/statistics/total?code=add_ele`, 'GET', accessToken);
        if (!statusData.success) throw new Error("Statistics Error: " + statusData.msg + ". Did you authorize 'Device Data Statistics' in Tuya?");

        // Format it so the HTML dashboard understands it
        const totalValue = parseFloat(statusData.result.total || 0);

        res.status(200).json({
            success: true,
            status: [
                { code: 'total_forward_energy', value: totalValue }
            ]
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}
