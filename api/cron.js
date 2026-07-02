const crypto = require('crypto');

// --- 1. TUYA CREDENTIALS ---
const CLIENT_ID = 'p9dpw35gs4wtjx3pwf8q'; 
const CLIENT_SECRET = '09e2028325d84c74a074fcdd647b1b27';
const DEVICE_ID = 'bfa7a6c82314556b7ey30d'; 
const HOST = 'https://openapi.tuyaeu.com';

// --- 2. FIREBASE CREDENTIALS ---
const FB_API_KEY = 'AIzaSyBRyqIxdirqgJDzevLIVBQpIMJ8mhMnzcM';
const FB_PROJECT = 'electricity--meter';
const FB_APP_ID = 'electricity--meter';

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
    // Enable CORS for testing
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const tokenData = await tuyaRequest('/v1.0/token?grant_type=1');
        if (!tokenData.success) throw new Error("Token Error: " + tokenData.msg);
        const accessToken = tokenData.result.access_token;

        // Using Statistics API to solve the "pulse" problem of the CBI meter
        const statsData = await tuyaRequest(`/v1.0/devices/${DEVICE_ID}/statistics/total?code=add_ele`, 'GET', accessToken);
        if (!statsData.success) throw new Error("Stats Error: " + statsData.msg);
        
        let currentTotalKwh = 0;
        if (statsData.result && statsData.result.total !== undefined) {
            currentTotalKwh = parseFloat(statsData.result.total);
        }
        
        // Failsafe: Ensure it parses decimals correctly if Tuya sends raw pulses
        if (currentTotalKwh > 1000) currentTotalKwh = currentTotalKwh / 100;

        const authRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FB_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ returnSecureToken: true })
        });
        const authData = await authRes.json();
        if (authData.error) throw new Error("Firebase Auth: " + authData.error.message);
        const idToken = authData.idToken;

        // Set to SAST (South African Standard Time) to ensure correct midnight rollovers
        const todayObj = new Date();
        const zaTime = new Date(todayObj.toLocaleString("en-US", { timeZone: "Africa/Johannesburg" }));
        const todayStr = zaTime.toLocaleDateString('en-CA'); // Outputs YYYY-MM-DD

        const docsRes = await fetch(`https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents/artifacts/${FB_APP_ID}/public/data/meter_readings`, {
            headers: { 'Authorization': `Bearer ${idToken}` }
        });
        const docsData = await docsRes.json();
        
        function parseFirestoreVal(obj) {
            if (!obj) return 0;
            if (obj.doubleValue !== undefined) return parseFloat(obj.doubleValue);
            if (obj.integerValue !== undefined) return parseInt(obj.integerValue, 10);
            if (obj.stringValue !== undefined) return obj.stringValue;
            return 0;
        }

        let allReadings = [];
        if (docsData.documents) {
            allReadings = docsData.documents.map(doc => {
                const fields = doc.fields || {};
                return {
                    date: fields.date ? parseFirestoreVal(fields.date) : '',
                    meterTotal: fields.meterTotal ? parseFirestoreVal(fields.meterTotal) : 0,
                    kwh: fields.kwh ? parseFirestoreVal(fields.kwh) : 0
                };
            });
        }

        let pastReadings = allReadings.filter(d => d.date < todayStr).sort((a, b) => b.date.localeCompare(a.date));
        let todayReading = allReadings.find(d => d.date === todayStr);

        let lastKnownTotal = pastReadings.length > 0 ? pastReadings[0].meterTotal : currentTotalKwh;
        let calculatedTodayKwh = Math.max(0, currentTotalKwh - lastKnownTotal);

        // --- RATCHET MECHANISM ---
        // Guarantees we never accidentally save a lower number than what is already stored
        let existingKwh = todayReading ? todayReading.kwh : 0;
        let finalTodayKwh = Math.max(calculatedTodayKwh, existingKwh);

        let existingTotal = todayReading ? todayReading.meterTotal : 0;
        let finalMeterTotal = Math.max(currentTotalKwh, existingTotal);

        const writeBody = {
            fields: {
                date: { stringValue: todayStr },
                meterTotal: { doubleValue: finalMeterTotal },
                kwh: { doubleValue: finalTodayKwh },
                timestamp: { integerValue: Date.now().toString() }
            }
        };

        const writeRes = await fetch(`https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents/artifacts/${FB_APP_ID}/public/data/meter_readings/${todayStr}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(writeBody)
        });
        
        if (!writeRes.ok) {
            const writeErr = await writeRes.text();
            throw new Error("Firebase Write Error: " + writeErr);
        }

        res.status(200).json({ 
            success: true, 
            loggedDate: todayStr, 
            tuyaGrandTotal: currentTotalKwh,
            ratchetMeterTotal: finalMeterTotal, 
            usageToday: finalTodayKwh 
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}
