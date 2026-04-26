const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const fs = require('fs');
const express = require('express');

// ============================================
// HEALTH CHECK SERVER
// ============================================
const healthApp = express();
const healthPort = process.env.PORT || 3000;
let currentQR = null;

healthApp.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

healthApp.get('/', (req, res) => {
    res.send('WhatsApp Bot is running!');
});

healthApp.get('/qr', (req, res) => {
    if (currentQR) {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp QR Code</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f0f0f0; }
                    .qr-container { background: white; padding: 30px; border-radius: 10px; display: inline-block; }
                    img { max-width: 300px; }
                    .instructions { margin-top: 20px; color: #666; }
                </style>
            </head>
            <body>
                <div class="qr-container">
                    <h2>Scan with WhatsApp</h2>
                    <img src="${currentQR}" alt="QR Code">
                    <div class="instructions">
                        <p>1. Open WhatsApp on your phone</p>
                        <p>2. Go to Settings → Linked Devices</p>
                        <p>3. Tap "Link a Device"</p>
                        <p>4. Scan this QR code</p>
                    </div>
                </div>
            </body>
            </html>
        `);
    } else {
        res.send('<h2>Waiting for QR code...</h2><p>Bot is starting up. Refresh in a few seconds.</p>');
    }
});

healthApp.listen(healthPort, () => {
    console.log(`✅ Health check server running on port ${healthPort}`);
});

// ============================================
// CONFIGURATION
// ============================================
const SHEET_ID = process.env.SHEET_ID || '1oZMWwvTHATw4Eoehm6URoysFwp3ylm8Bb0udy-qG1zg';
let googleSheet = null;
const knownContacts = new Set();

// Heartbeat to monitor bot status
let heartbeatInterval = null;
let lastMessageTime = Date.now();

// ============================================
// GOOGLE SHEETS SETUP
// ============================================
async function setupGoogleSheet() {
    try {
        let creds;
        
        if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
            console.log('📊 Using Google credentials from environment variables');
            creds = {
                client_email: process.env.GOOGLE_CLIENT_EMAIL,
                private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
            };
        } else if (fs.existsSync('./credentials.json')) {
            console.log('📊 Using Google credentials from file');
            creds = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
        } else {
            console.error('❌ No Google credentials found!');
            return false;
        }
        
        const doc = new GoogleSpreadsheet(SHEET_ID);
        await doc.useServiceAccountAuth({
            client_email: creds.client_email,
            private_key: creds.private_key,
        });
        await doc.loadInfo();

        console.log(`📊 Connected to sheet: "${doc.title}"`);
        
        let sheet = doc.sheetsByIndex[0];
        console.log(`📊 Using tab: "${sheet.title}"`);
        
        const rows = await sheet.getRows();
        
        if (rows.length === 0 || (rows.length > 0 && !rows[0].hasOwnProperty('الموبايل'))) {
            await sheet.setHeaderRow(['رقم', 'الاسم', 'الموبايل', 'التاريخ']);
            console.log('📋 Set headers');
        }
        
        const existingRows = await sheet.getRows();
        for (const row of existingRows) {
            const phoneNumber = row['الموبايل'];
            if (phoneNumber && phoneNumber.trim() !== '') {
                knownContacts.add(phoneNumber.trim());
            }
        }
        console.log(`📚 Loaded ${knownContacts.size} existing contacts`);
        
        googleSheet = sheet;
        console.log('✅ Google Sheet connected successfully!');
        return true;
    } catch (error) {
        console.error('❌ Google Sheet error:', error.message);
        return false;
    }
}

// ============================================
// SAVE NEW CONTACT
// ============================================
async function saveNewContact(contactName, phoneNumber) {
    if (!googleSheet) return false;
    if (knownContacts.has(phoneNumber.trim())) {
        console.log(`⏭️ Contact already exists: ${contactName} (${phoneNumber})`);
        return false;
    }
    
    try {
        const date = new Date().toLocaleDateString('ar-EG');
        await googleSheet.addRow({
            'رقم': '',
            'الاسم': contactName,
            'الموبايل': phoneNumber,
            'التاريخ': date
        });
        knownContacts.add(phoneNumber.trim());
        console.log(`✅ NEW CONTACT SAVED: ${contactName} (${phoneNumber}) - ${date}`);
        return true;
    } catch (error) {
        console.error('❌ Save error:', error.message);
        return false;
    }
}

// ============================================
// EXTRACT PHONE NUMBER RELIABLY (FIXES WRONG NUMBERS)
// ============================================
async function extractPhoneNumber(client, message, myNumber) {
    try {
        // Method 1: Get from message sender directly
        let senderRaw = message.from;
        if (senderRaw && senderRaw.includes('@')) {
            const candidate = senderRaw.split('@')[0].replace(/[^0-9]/g, '');
            // If it's a valid number length and not the internal format, use it
            if (candidate && candidate.length >= 9 && candidate.length <= 15 && !candidate.startsWith('1')) {
                return candidate;
            }
        }
        
        // Method 2: Get from contact with fallbacks
        let contact = null;
        try {
            contact = await client.getContactById(message.from);
        } catch (err) {
            console.log('Could not fetch contact, using fallback');
        }
        
        if (contact) {
            // Try contact.number
            if (contact.number) {
                let cleaned = contact.number.replace(/[^0-9]/g, '');
                if (cleaned && cleaned.length >= 9) return cleaned;
            }
            // Try contact.id.user
            if (contact.id && contact.id.user) {
                let cleaned = contact.id.user.split('@')[0].replace(/[^0-9]/g, '');
                if (cleaned && cleaned.length >= 9 && !cleaned.startsWith('1')) return cleaned;
            }
        }
        
        // Method 3: Infer from chat
        try {
            const chat = await message.getChat();
            if (chat && !chat.isGroup && chat.id && chat.id.user) {
                let cleaned = chat.id.user.split('@')[0].replace(/[^0-9]/g, '');
                if (cleaned && cleaned.length >= 9 && !cleaned.startsWith('1')) return cleaned;
            }
        } catch (err) {}
        
        return null;
    } catch (error) {
        console.error('Error extracting phone number:', error);
        return null;
    }
}

// ============================================
// WHATSAPP SETUP WITH PERSISTENT MONITORING
// ============================================
async function setupWhatsApp() {
    console.log('\n📱 Starting WhatsApp client...');
    
    // Clear session on each start to avoid stale connections
    const sessionPath = '/app/session-data';
    if (fs.existsSync(sessionPath)) {
        console.log('🗑️ Clearing old session data...');
        try {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        } catch (err) {}
    }
    
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: 'whatsapp-bot',
            dataPath: '/app/session-data'
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.51.html',
        }
    });
    
    client.on('qr', (qr) => {
        currentQR = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
        console.log(`\n📱 QR Code available at: https://your-app.railway.app/qr\n`);
        qrcode.generate(qr, { small: true });
        console.log('\n1. Open WhatsApp on your phone');
        console.log('2. Go to Settings → Linked Devices');
        console.log('3. Tap "Link a Device"');
        console.log('4. Scan the QR code above\n');
    });
    
    client.on('ready', async () => {
        console.log('\n' + '='.repeat(50));
        console.log('✅ WHATSAPP BOT IS READY!');
        console.log('='.repeat(50));
        
        // Get and display bot's own number
        let myNumber = 'unknown';
        try {
            const info = await client.info;
            myNumber = info.wid.user;
            console.log(`🤖 Bot connected as: ${myNumber}`);
        } catch (err) {}
        
        console.log('📡 Monitoring for NEW contacts continuously...');
        console.log('='.repeat(50) + '\n');
        
        // Heartbeat every 3 minutes to confirm bot is alive
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            const minutesSinceLastMsg = Math.round((Date.now() - lastMessageTime) / 60000);
            console.log(`💓 Bot alive - ${new Date().toLocaleTimeString()} - Monitoring ${knownContacts.size} contacts - Last message ${minutesSinceLastMsg} min ago`);
        }, 180000);
    });
    
    // Main message handler with safe error catching
    client.on('message', async (message) => {
        try {
            // Skip status broadcasts and group notifications
            if (message.from === 'status@broadcast') return;
            
            lastMessageTime = Date.now();
            
            // Get bot's own number for comparison
            let myNumber = 'unknown';
            try {
                const info = await client.info;
                myNumber = info.wid.user;
            } catch (err) {}
            
            // Extract phone number using reliable method
            let phoneNumber = await extractPhoneNumber(client, message, myNumber);
            
            // Get contact name safely
            let contactName = phoneNumber || 'Unknown';
            try {
                const contact = await message.getContact();
                contactName = contact.pushname || contact.name || phoneNumber || 'Unknown';
            } catch (err) {
                console.log('Could not fetch contact name');
            }
            
            if (!phoneNumber) {
                console.log(`⚠️ Could not extract phone number for message from: ${message.from}`);
                return;
            }
            
            console.log(`\n📨 Message from: ${contactName} (${phoneNumber})`);
            if (message.body) {
                console.log(`📝 Message: "${message.body.substring(0, 100)}"`);
            }
            
            await saveNewContact(contactName, phoneNumber);
            
        } catch (error) {
            // Catch errors per message so one bad message doesn't break everything
            console.error('Message processing error:', error);
        }
    });
    
    client.on('disconnected', (reason) => {
        console.log('\n⚠️ Disconnected:', reason);
        console.log('🔄 Bot disconnected. Railway will restart automatically.');
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
    });
    
    client.on('auth_failure', (msg) => {
        console.error('❌ Authentication failed:', msg);
    });
    
    await client.initialize();
    return client;
}

// ============================================
// MAIN
// ============================================
async function main() {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 WHATSAPP BOT - RAILWAY DEPLOYMENT');
    console.log('='.repeat(50));
    console.log(`Started: ${new Date().toLocaleString()}`);
    console.log('='.repeat(50) + '\n');
    
    console.log('📊 Connecting to Google Sheets...');
    const sheetConnected = await setupGoogleSheet();
    
    if (!sheetConnected) {
        console.log('\n⚠️ Cannot continue without Google Sheets');
        return;
    }
    
    await setupWhatsApp();
}

// Cleanup on exit
process.on('SIGINT', () => {
    console.log('\n\n🛑 Shutting down bot...');
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n\n🛑 Bot terminated...');
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    process.exit(0);
});

main().catch(console.error);