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

// QR code web interface
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

// ============================================
// GOOGLE SHEETS SETUP
// ============================================
async function setupGoogleSheet() {
    try {
        let creds;
        
        // Use environment variables first (for Railway)
        if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
            console.log('📊 Using Google credentials from environment variables');
            creds = {
                client_email: process.env.GOOGLE_CLIENT_EMAIL,
                private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
            };
        } 
        // Fallback to file (for local development)
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

        // ========== SHOW WHICH SHEET WE'RE CONNECTED TO ==========
        console.log(`📊 Connected to sheet: "${doc.title}"`);
        console.log(`📊 Sheet URL: https://docs.google.com/spreadsheets/d/${SHEET_ID}`);
        console.log(`📊 Sheet ID: ${SHEET_ID}`);
        
        // ========== LIST ALL AVAILABLE TABS ==========
        console.log('📑 Available tabs in this sheet:');
        for (let i = 0; i < doc.sheetsByIndex.length; i++) {
            const sheetTab = doc.sheetsByIndex[i];
            console.log(`   ${i + 1}. "${sheetTab.title}"`);
        }
        
        // ========== JUST USE THE FIRST TAB ==========
        let sheet = doc.sheetsByIndex[0];
        console.log(`📊 Using tab: "${sheet.title}"`);
        
        // Check if the sheet has the correct headers
        const rows = await sheet.getRows();
        
        // If sheet is empty OR doesn't have the phone column, set headers
        if (rows.length === 0 || (rows.length > 0 && !rows[0].hasOwnProperty('الموبايل'))) {
            // Clear existing headers if any
            if (rows.length > 0 && sheet.headerValues.length > 0) {
                console.log('📋 Updating headers...');
            }
            await sheet.setHeaderRow([
                'رقم',
                'الاسم',
                'الموبايل',
                'التاريخ'
            ]);
            console.log('📋 Set headers: رقم, الاسم, الموبايل, التاريخ');
        }
        
        // Load existing contacts
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

async function findLastRowWithData() {
    try {
        const rows = await googleSheet.getRows();
        if (rows.length === 0) return 0;
        
        let lastRowIndex = -1;
        for (let i = 0; i < rows.length; i++) {
            const phone = rows[i]['الموبايل'];
            if (phone && phone !== '') lastRowIndex = i;
        }
        return lastRowIndex + 1;
    } catch (error) {
        console.error('Error finding last row:', error.message);
        return null;
    }
}

async function saveNewContact(contactName, phoneNumber) {
    if (!googleSheet) return false;
    if (knownContacts.has(phoneNumber.trim())) {
        console.log(`⏭️ Contact already exists: ${contactName} (${phoneNumber})`);
        return false;
    }
    
    try {
        const date = new Date().toLocaleDateString('ar-EG');
        
        // Add row with the contact data
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

function extractPhoneNumber(contact) {
    if (contact.number) return contact.number;
    if (contact.id && contact.id.user) return contact.id.user;
    return 'Unknown';
}

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
        }
    });
    
    client.on('qr', (qr) => {
        currentQR = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
        console.log(`\n📱 QR Code available at: https://your-app.railway.app/qr\n`);
        console.log('\n' + '='.repeat(50));
        console.log('📱 SCAN THIS QR CODE WITH WHATSAPP:');
        console.log('='.repeat(50));
        qrcode.generate(qr, { small: true });
        console.log('\nInstructions:');
        console.log('1. Open WhatsApp on your phone');
        console.log('2. Go to Settings → Linked Devices');
        console.log('3. Tap "Link a Device"');
        console.log('4. Scan the QR code above OR visit /qr endpoint');
        console.log('='.repeat(50) + '\n');
    });
    
    client.on('ready', () => {
        console.log('\n' + '='.repeat(50));
        console.log('✅ WHATSAPP BOT IS READY!');
        console.log('='.repeat(50));
        console.log('📡 Monitoring for NEW contacts only...');
        console.log('📊 New contacts will be saved to the first tab in your sheet');
        console.log('\n💡 To stop the bot: Press Ctrl+C\n');
    });
    
    client.on('message', async (message) => {
        try {
            const contact = await message.getContact();
            const phoneNumber = extractPhoneNumber(contact);
            const contactName = contact.pushname || contact.name || phoneNumber;
            console.log(`\n📨 Message from: ${contactName} (${phoneNumber})`);
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