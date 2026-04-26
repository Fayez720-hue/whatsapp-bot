const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const fs = require('fs');
const express = require('express');

// ============================================
// HEALTH CHECK SERVER FOR RAILWAY
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
                    body {
                        font-family: Arial, sans-serif;
                        text-align: center;
                        padding: 50px;
                        background: #f0f0f0;
                    }
                    .qr-container {
                        background: white;
                        padding: 30px;
                        border-radius: 10px;
                        display: inline-block;
                        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                    }
                    img {
                        max-width: 300px;
                        width: 100%;
                    }
                    .instructions {
                        margin-top: 20px;
                        color: #666;
                    }
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
// WHATSAPP SETUP
// ============================================
async function setupWhatsApp() {
    console.log('\n📱 Starting WhatsApp client...');
    
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
    });
    
    client.on('ready', async () => {
        console.log('\n' + '='.repeat(50));
        console.log('✅ WHATSAPP BOT IS READY!');
        console.log('='.repeat(50));
        console.log('📡 Monitoring for NEW contacts...');
        console.log('='.repeat(50) + '\n');
    });
    
    client.on('message', async (message) => {
        try {
            if (message.from === 'status@broadcast') return;
            
            // Get contact info
            const contact = await message.getContact();
            
            // IMPORTANT: Get the phone number from the contact object
            // This is the correct way to get the actual phone number
            let phoneNumber = null;
            
            // Method 1: contact.number (this should be the phone number)
            if (contact.number) {
                let raw = contact.number;
                if (raw.includes('@')) raw = raw.split('@')[0];
                phoneNumber = raw.replace(/[^0-9]/g, '');
            }
            
            // Method 2: contact.id.user
            if (!phoneNumber && contact.id && contact.id.user) {
                let raw = contact.id.user;
                if (raw.includes('@')) raw = raw.split('@')[0];
                phoneNumber = raw.replace(/[^0-9]/g, '');
            }
            
            // Method 3: message.from
            if (!phoneNumber && message.from) {
                let raw = message.from;
                if (raw.includes('@')) raw = raw.split('@')[0];
                phoneNumber = raw.replace(/[^0-9]/g, '');
            }
            
            // Validate - phone number should start with country code and be reasonable length
            if (!phoneNumber || phoneNumber.length < 9 || phoneNumber.length > 15) {
                console.log(`⚠️ Invalid phone number format: ${phoneNumber}`);
                return;
            }
            
            const contactName = contact.pushname || contact.name || phoneNumber;
            
            console.log(`\n📨 Message from: ${contactName}`);
            console.log(`📞 Phone number: ${phoneNumber}`);
            console.log(`📝 Message: "${message.body?.substring(0, 100) || ''}"`);
            
            await saveNewContact(contactName, phoneNumber);
            
        } catch (error) {
            console.error('Message processing error:', error);
        }
    });
    
    client.on('disconnected', (reason) => {
        console.log('\n⚠️ Disconnected:', reason);
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

process.on('SIGINT', () => {
    console.log('\n\n🛑 Shutting down bot...');
    process.exit(0);
});

main().catch(console.error);