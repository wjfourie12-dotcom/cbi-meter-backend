const crypto = require('crypto');

// Your Tuya Developer Credentials
const CLIENT_ID = 'fxhunrafe5vvcpqwwpj9';
const CLIENT_SECRET = '45f88345c94c4985a5371a26843a00f0';
const DEVICE_ID = 'bfa7a6c82314556b7ey30d';

// Tuya Central Europe Data Center endpoint
const HOST = 'https://openapi.tuyaeu.com'; 

// Helper function to generate the complex Tuya HMAC-SHA256 signatures
function calcSign(clientId, accessToken, timestamp, nonce, signStr, secret) {
    const str = clientId + accessToken + timestamp + nonce + signStr;
    return crypto.createHmac('sha256', secret).update(str, 'utf8').digest('hex').toUpperCase();
}

// Helper to make API requests to Tuya
async function tuyaRequest(path, method = 'GET', accessToken = '') {
    const timestamp = Date.now().toString();
    const nonce = ''; // Tuya allows empty nonce for most requests
    
    // Tuya String-To-Sign format: HTTPMethod + \n + Content-SHA256 + \n + Headers + \n + URL
    const contentHash = crypto.createHash('sha256').update('', 'utf8').digest('hex'); // Empty body for GET
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
    // 1. Set CORS headers so your HTML file is allowed to request this data
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // 2. Fetch a temporary Access Token from Tuya
        const tokenData = await tuyaRequest('/v1.0/token?grant_type=1');
        if (!tokenData.success) throw new Error(tokenData.msg);
        const accessToken = tokenData.result.access_token;

        // 3. Fetch the daily electricity statistics for your CBI Meter
        // We request the 'add_ele' (added electricity / energy consumption) stat for the current month
        const date = new Date();
        const startMonth = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}01`;
        
        // Note: The specific stat code may vary slightly by CBI firmware. 'add_ele' is standard for Tuya Energy.
        const statsData = await tuyaRequest(`/v1.0/devices/${DEVICE_ID}/stat/days?stat_code=add_ele&start_day=${startMonth}`, 'GET', accessToken);
        
        if (!statsData.success) throw new Error(statsData.msg);

        // 4. Format the data perfectly for our HTML dashboard
        const rawDays = statsData.result.Days || {};
        const formattedData = Object.keys(rawDays).map(dayKey => {
            // Convert "20260615" to "2026-06-15"
            const formattedDate = `${dayKey.substring(0,4)}-${dayKey.substring(4,6)}-${dayKey.substring(6,8)}`;
            return {
                date: formattedDate,
                kwh: parseFloat(rawDays[dayKey]),
                cost: 0 // Frontend calculates cost
            };
        });

        // 5. Send clean data to the HTML frontend
        res.status(200).json(formattedData);

    } catch (error) {
        console.error("Tuya API Error:", error);
        res.status(500).json({ error: "Failed to fetch live data from meter" });
    }
};
