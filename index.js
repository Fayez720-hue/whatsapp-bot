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

// QR code storage for web interface
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
    console.log(`📱 QR Code available at: https://your-app.railway.app/qr`);
});

// ============================================
// CONFIGURATION - YOUR SHEET ID
// ============================================
const SHEET_ID = process.env.SHEET_ID || '1oZMWwvTHATw4Eoehm6URoysFwp3ylm8Bb0udy-qG1zg';

// Global variable for Google Sheet
let googleSheet = null;

// Track known contacts to avoid duplicate entries
const knownContacts = new Set();

// Heartbeat interval to keep bot alive
let heartbeatInterval = null;

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
        } 
        else if (fs.existsSync('./credentials.json')) {
            console.log('📊 Using Google credentials from file');
            creds = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
        } 
        else {
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
        console.log(`📊 Sheet URL: https://docs.google.com/spreadsheets/d/${SHEET_ID}`);
        
        console.log('📑 Available tabs:');
        for (let i = 0; i < doc.sheetsByIndex.length; i++) {
            console.log(`   ${i + 1}. "${doc.sheetsByIndex[i].title}"`);
        }
        
        let sheet = doc.sheetsByIndex[0];
        console.log(`📊 Using tab: "${sheet.title}"`);
        
        const rows = await sheet.getRows();
        
        if (rows.length === 0 || (rows.length > 0 && !rows[0].hasOwnProperty('الموبايل'))) {
            await sheet.setHeaderRow([
                'رقم',
                'الاسم',
                'الموبايل',
                'التاريخ'
            ]);
            console.log('📋 Set headers: رقم, الاسم, الموبايل, التاريخ');
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
// EXTRACT PHONE NUMBER FROM MESSAGE
// ============================================
function extractPhoneNumber(message) {
    try {
        // Try to get from chat ID first
        if (message._data && message._data.author) {
            const author = message._data.author;
            if (author && author.includes('@')) {
                return author.split('@')[0].replace(/[^0-9]/g, '');
            }
        }
        
        // Try from 'from' field
        if (message.from) {
            const from = message.from;
            if (from && from.includes('@')) {
                const number = from.split('@')[0].replace(/[^0-9]/g, '');
                if (number && number.length > 5) return number;
            }
        }
        
        return null;
    } catch (error) {
        console.error('Error extracting phone number:', error);
        return null;
    }
}

// ============================================
// WHATSAPP SETUP
// ============================================
async function setupWhatsApp() {
    const sessionPath = '/app/session-data';
    if (fs.existsSync(sessionPath)) {
        console.log('🗑️ Clearing old session data...');
        try {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        } catch (err) {
            console.log('Could not clear session data');
        }
    }
    
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
        console.log('\nInstructions:');
        console.log('1. Open WhatsApp on your phone');
        console.log('2. Go to Settings → Linked Devices');
        console.log('3. Tap "Link a Device"');
        console.log('4. Scan the QR code above OR visit /qr endpoint\n');
    });
    
    client.on('ready', async () => {
        console.log('\n' + '='.repeat(50));
        console.log('✅ WHATSAPP BOT IS READY!');
        console.log('='.repeat(50));
        console.log('📡 Monitoring for NEW contacts continuously...');
        console.log('📊 New contacts will be saved to the sheet');
        console.log('\n💡 Bot will stay active and monitor all messages');
        console.log('='.repeat(50) + '\n');
        
        // Start heartbeat to keep bot alive
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            console.log(`💓 Bot is alive - ${new Date().toLocaleTimeString()} - Monitoring ${knownContacts.size} contacts`);
        }, 300000); // Every 5 minutes
        
        // Try to get bot info
        try {
            const info = await client.info;
            console.log(`🤖 Bot connected as: ${info.wid.user}`);
        } catch (err) {
            console.log('Could not get bot info');
        }
    });
    
    client.on('message', async (message) => {
        try {
            // Skip if it's a status message
            if (message.from === 'status@broadcast') {
                return;
            }
            
            // Extract phone number
            let phoneNumber = null;
            
            // Method 1: Get from chat
            try {
                const chat = await message.getChat();
                if (chat && chat.id && chat.id.user) {
                    const raw = chat.id.user;
                    if (raw && raw.includes('@')) {
                        phoneNumber = raw.split('@')[0].replace(/[^0-9]/g, '');
                    }
                }
            } catch (err) {}
            
            // Method 2: Get from message.from
            if (!phoneNumber && message.from) {
                const raw = message.from;
                if (raw && raw.includes('@')) {
                    phoneNumber = raw.split('@')[0].replace(/[^0-9]/g, '');
                }
            }
            
            // Method 3: Get from raw data
            if (!phoneNumber && message._data && message._data.author) {
                const raw = message._data.author;
                if (raw && raw.includes('@')) {
                    phoneNumber = raw.split('@')[0].replace(/[^0-9]/g, '');
                }
            }
            
            // Skip invalid numbers
            if (!phoneNumber || phoneNumber.length < 8 || phoneNumber === 'status') {
                console.log(`⚠️ Skipping message from invalid number: ${phoneNumber}`);
                return;
            }
            
            // Get contact name
            let contactName = phoneNumber;
            try {
                const contact = await message.getContact();
                contactName = contact.pushname || contact.name || phoneNumber;
            } catch (err) {}
            
            console.log(`\n📨 Message from: ${contactName} (${phoneNumber})`);
            if (message.body) {
                console.log(`📝 Message: "${message.body.substring(0, 100)}"`);
            }
            
            await saveNewContact(contactName, phoneNumber);
            
        } catch (error) {
            console.error('Message processing error:', error);
        }
    });
    
    client.on('disconnected', (reason) => {
        console.log('\n⚠️ Disconnected:', reason);
        console.log('🔄 Bot will attempt to reconnect...');
        
        // Clear heartbeat
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
// MAIN FUNCTION
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

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n🛑 Shutting down bot...');
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n\n🛑 Bot terminated...');
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
    }
    process.exit(0);
});

main().catch(console.error);