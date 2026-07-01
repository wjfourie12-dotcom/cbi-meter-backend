const crypto = require('crypto');

// --- 1. TUYA CONFIGURATION ---
const CLIENT_ID = 'p9dpw35gs4wtjx3pwf8q'; 
const CLIENT_SECRET = '09e2028325d84c74a074fcdd647b1b27';
const DEVICE_ID = 'bfa7a6c82314556b7ey30d'; 
const HOST = 'https://openapi.tuyaeu.com';

// --- 2. FIREBASE CONFIGURATION ---
const FB_API_KEY = "AIzaSyBRyqIxdirqgJDzevLIVBQpIMJ8mhMnzcM";
const FB_PROJECT = "electricity--meter";
const FB_APP_ID = "electricity--meter";

// Tuya Encryption Helper
function calcSign(clientId, accessToken, timestamp, nonce, stringToSign, secret) {
    const str = clientId + accessToken + timestamp + nonce + stringToSign;
    return crypto.createHmac('sha256', secret).update(str, 'utf8').digest('hex').toUpperCase();
}

// Tuya Request Engine
async function tuyaRequest(path, method = 'GET', accessToken = '') {
    const timestamp = Date.now().toString();
    const nonce = ''; 
    const [urlPath, queryString] = path.split('?');
    let sortedPath = urlPath;
    
    if (queryString) {
        const params = new URLSearchParams(queryString);
        const sortedParams = Array.from(params.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join('&');
        sortedPath += '?' + sortedParams;
    }

    const contentHash = crypto.createHash('sha256').update('', 'utf8').digest('hex');
    const stringToSign = `${method}\n${contentHash}\n\n${sortedPath}`;
    const sign = calcSign(CLIENT_ID, accessToken, timestamp, nonce, stringToSign, CLIENT_SECRET);
    
    const response = await fetch(`${HOST}${sortedPath}`, {
        method: method,
        headers: {
            'client_id': CLIENT_ID, 'access_token': accessToken, 'sign': sign,
            'sign_method': 'HMAC-SHA256', 't': timestamp, 'nonce': nonce, 'Content-Type': 'application/json'
        }
    });
    return await response.json();
}

// Firestore REST Data Parser
function parseFirestoreVal(val) {
    if (val.doubleValue !== undefined) return parseFloat(val.doubleValue);
    if (val.integerValue !== undefined) return parseInt(val.integerValue, 10);
    if (val.stringValue !== undefined) return val.stringValue;
    return 0;
}

module.exports = async function handler(req, res) {
    try {
        console.log("--- Starting Hourly Sync ---");

        // 1. GET LIVE METER DATA FROM TUYA
        const tokenData = await tuyaRequest('/v1.0/token?grant_type=1');
        const statusData = await tuyaRequest(`/v1.0/devices/${DEVICE_ID}/status`, 'GET', tokenData.result.access_token);
        const statusArray = statusData.result || statusData.status;
        
        const energyPoint = statusArray.find(dp => dp.code === 'add_ele' || dp.code === 'total_forward_energy');
        
        // ALWAYS divide by 100 to convert to true kWh
        let currentTotalKwh = parseFloat(energyPoint.value) / 100;

        // 2. GET SAST TIMEZONE DATE (UTC+2 for Cape Town)
        const now = new Date();
        const sastTime = new Date(now.getTime() + (2 * 60 * 60 * 1000));
        const todayStr = sastTime.toISOString().split('T')[0];

        // 3. AUTHENTICATE WITH FIREBASE (Anonymous REST)
        const authRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FB_API_KEY}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ returnSecureToken: true })
        });
        const authData = await authRes.json();
        const idToken = authData.idToken;

        // 4. FETCH PAST READINGS FROM FIREBASE
        const docsRes = await fetch(`https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents/artifacts/${FB_APP_ID}/public/data/meter_readings`, {
            headers: { 'Authorization': `Bearer ${idToken}` }
        });
        const docsData = await docsRes.json();
        
        let allReadings = [];
        if (docsData.documents) {
            allReadings = docsData.documents.map(doc => {
                const fields = doc.fields || {};
                return {
                    date: fields.date ? parseFirestoreVal(fields.date) : '',
                    meterTotal: fields.meterTotal ? parseFirestoreVal(fields.meterTotal) : 0,
                };
            });
        }

        // 5. CALCULATE DAILY USAGE
        let pastReadings = allReadings.filter(d => d.date < todayStr).sort((a, b) => b.date.localeCompare(a.date));
        let lastKnownTotal = pastReadings.length > 0 ? pastReadings[0].meterTotal : currentTotalKwh;
        let todayKwh = Math.max(0, currentTotalKwh - lastKnownTotal);

        // 6. SAVE BACK TO FIREBASE
        const writeBody = {
            fields: {
                date: { stringValue: todayStr },
                meterTotal: { doubleValue: currentTotalKwh },
                kwh: { doubleValue: todayKwh },
                timestamp: { integerValue: Date.now().toString() }
            }
        };

        await fetch(`https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents/artifacts/${FB_APP_ID}/public/data/meter_readings/${todayStr}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(writeBody)
        });

        res.status(200).json({ success: true, loggedDate: todayStr, total: currentTotalKwh, usageToday: todayKwh });

    } catch (error) {
        console.error("Cron Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
}
