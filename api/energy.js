const crypto = require('crypto');

const CLIENT_ID = 'fxhunrafe5vvcpqwwpj9';
const CLIENT_SECRET = '45f88345c94c4985a5371a26843a00f0';
const DEVICE_ID = 'bfa7a6c82314556b7ey30d';
const HOST = 'https://openapi.tuyaeu.com'; 

function calcSign(clientId, accessToken, timestamp, nonce, signStr, secret) {
    const str = clientId + accessToken + timestamp + nonce + signStr;
    return crypto.createHmac('sha256', secret).update(str, 'utf8').digest('hex').toUpperCase();
}

async function tuyaRequest(path, method = 'GET', accessToken = '') {
    const timestamp = Date.now().toString();
    const nonce = ''; 
    const contentHash = crypto.createHash('sha256').update('', 'utf8').digest('hex'); 
    const stringToSign = `${method}\n${contentHash}\n\n${path}`;
    const sign = calcSign(CLIENT_ID, accessToken, timestamp, nonce, stringToSign, CLIENT_SECRET);
    
    const response = await fetch(`${HOST}${path}`, {
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
        // Step 1: Get Token
        const tokenData = await tuyaRequest('/v1.0/token?grant_type=1');
        if (!tokenData.success) {
            return res.status(500).json({ error: "TUYA TOKEN REJECTED: " + tokenData.msg });
        }
        const accessToken = tokenData.result.access_token;

        // Step 2: Get Stats
        const date = new Date();
        const startMonth = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}01`;
        
        const statsData = await tuyaRequest(`/v1.0/devices/${DEVICE_ID}/stat/days?stat_code=add_ele&start_day=${startMonth}`, 'GET', accessToken);
        
        if (!statsData.success) {
            return res.status(500).json({ error: "TUYA DATA REJECTED: " + statsData.msg });
        }

        const rawDays = statsData.result.Days || {};
        const formattedData = Object.keys(rawDays).map(dayKey => {
            const formattedDate = `${dayKey.substring(0,4)}-${dayKey.substring(4,6)}-${dayKey.substring(6,8)}`;
            return {
                date: formattedDate,
                kwh: parseFloat(rawDays[dayKey]),
                cost: 0 
            };
        });

        res.status(200).json(formattedData);

    } catch (error) {
        res.status(500).json({ error: "CODE CRASHED: " + error.message });
    }
};
