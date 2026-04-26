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
            <head><title>WhatsApp QR Code</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { text-align: center; padding: 50px; font-family: Arial; }
                .qr-container { background: white; padding: 30px; border-radius: 10px; display: inline-block; }
                img { max-width: 300px; }
            </style>
            </head>
            <body>
                <div class="qr-container">
                    <h2>Scan with WhatsApp</h2>
                    <img src="${currentQR}" alt="QR Code">
                    <p>1. Open WhatsApp → Settings → Linked Devices</p>
                    <p>2. Tap "Link a Device"</p>
                    <p>3. Scan this QR code</p>
                </div>
            </body>
            </html>
        `);
    } else {
        res.send('<h2>Waiting for QR code...</h2><p>Bot starting up. Refresh in a few seconds.</p>');
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
let myBotNumber = null;

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
// EXTRACT PHONE NUMBER - ADD THIS FUNCTION HERE
// ============================================
async function extractPhoneNumber(client, message) {
    try {
        // 1. Get your bot's own number first
        const myNumber = client.info?.wid?.user || 'unknown';
        let senderNumber = 'unknown';

        // 2. Check if the message is from the bot itself
        if (message.from?.includes(myNumber) || message.from === client.info?.wid?._serialized) {
            senderNumber = myNumber;
        } else {
            try {
                // 3. Attempt to get the contact
                const contact = await client.getContactById(message.from);
                
                // 4. THE CRITICAL FIX: If contact.number fails, fall back to parsing message.from
                senderNumber = contact.number || (message.author || message.from).split('@')[0];
            } catch (e) {
                // 5. Ultimate fallback: parse the string directly
                senderNumber = (message.author || message.from).split('@')[0];
            }
        }
        
        // 6. Clean the number (remove any non-digit characters)
        let cleanedNumber = senderNumber.replace(/[^0-9]/g, '');
        
        // 7. Log which method succeeded
        if (cleanedNumber && cleanedNumber.length >= 9 && !cleanedNumber.startsWith('1')) {
            console.log(`✅ Extracted number: ${cleanedNumber} (Source: ${senderNumber === cleanedNumber ? 'Parsed from string' : 'From contact object'})`);
            return cleanedNumber;
        }
        
        console.log(`⚠️ Could not extract valid number. Raw: ${senderNumber}, Cleaned: ${cleanedNumber}`);
        return null;
        
    } catch (error) {
        console.error('Error in extractPhoneNumber:', error);
        return null;
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
        console.log(`\n📱 SCAN THIS QR CODE:`);
        qrcode.generate(qr, { small: true });
        console.log(`\n📱 Or visit: https://your-app.railway.app/qr\n`);
    });
    
    client.on('ready', async () => {
        // Get bot's own number
        const info = await client.info;
        myBotNumber = info.wid.user;
        console.log(`\n✅ WHATSAPP BOT IS READY!`);
        console.log(`🤖 Bot number: ${myBotNumber}`);
        console.log(`📡 Waiting for messages...\n`);
    });
    
       // MAIN MESSAGE HANDLER - USING extractPhoneNumber FUNCTION
    client.on('message', async (message) => {
        try {
            // Skip status messages
            if (message.from === 'status@broadcast') return;
            
            // Skip messages from the bot itself
            if (myBotNumber && message.from.includes(myBotNumber)) return;
            
            // CALL YOUR extractPhoneNumber FUNCTION HERE
            let phoneNumber = await extractPhoneNumber(client, message);
            
            if (!phoneNumber) {
                console.log(`⚠️ Could not extract phone number from: ${message.from}`);
                return;
            }
            
            // Get contact name
            let contactName = phoneNumber;
            try {
                const contact = await message.getContact();
                contactName = contact.pushname || contact.name || phoneNumber;
            } catch (err) {
                console.log('Could not get contact name, using number');
            }
            
            console.log(`\n📨 Message from: ${contactName}`);
            console.log(`📞 Extracted phone number: ${phoneNumber}`);
            console.log(`📝 Message: "${message.body?.substring(0, 100) || ''}"`);
            
            await saveNewContact(contactName, phoneNumber);
            
        } catch (error) {
            console.error('Message processing error:', error.message);
        }
    });
    
    client.on('disconnected', (reason) => {
        console.log('⚠️ Disconnected:', reason);
    });
    
    await client.initialize();
    return client;
}

// ============================================
// MAIN
// ============================================
async function main() {
    console.log('\n🚀 STARTING WHATSAPP BOT\n');
    
    console.log('📊 Connecting to Google Sheets...');
    const sheetConnected = await setupGoogleSheet();
    
    if (!sheetConnected) {
        console.log('⚠️ Cannot continue without Google Sheets');
        return;
    }
    
    await setupWhatsApp();
}

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    process.exit(0);
});

main().catch(console.error);