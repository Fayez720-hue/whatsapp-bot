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

healthApp.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

healthApp.get('/', (req, res) => {
    res.send('WhatsApp Bot is running!');
});

healthApp.listen(healthPort, () => {
    console.log(`✅ Health check server running on port ${healthPort}`);
});

// ============================================
// CONFIGURATION - YOUR SHEET ID
// ============================================
const SHEET_ID = '1oZMWwvTHATw4Eoehm6URoysFwp3ylm8Bb0udy-qG1zg';

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
        
        // Get the first sheet
        let sheet = doc.sheetsByIndex[0];
        if (!sheet) {
            sheet = await doc.addSheet({ title: 'WhatsApp Leads' });
            console.log('📊 Created new worksheet');
        }
        
        // Add headers starting from column B if sheet is empty
        const rows = await sheet.getRows();
        if (rows.length === 0) {
            await sheet.setHeaderRow([
                '',      // Column A - empty
                'الاسم', // Column B
                'الموبايل', // Column C
                'التاريخ'   // Column D
            ]);
            console.log('📋 Added headers: Column B (الاسم), Column C (الموبايل), Column D (التاريخ)');
        }
        
        // Load existing contacts to avoid duplicates
        const existingRows = await sheet.getRows();
        for (const row of existingRows) {
            const phoneNumber = row['الموبايل'];
            if (phoneNumber && phoneNumber !== '') {
                knownContacts.add(phoneNumber);
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
// FIND LAST ROW WITH DATA IN COLUMN C
// ============================================
async function findLastRowWithData() {
    try {
        const rows = await googleSheet.getRows();
        
        if (rows.length === 0) {
            console.log(`   No existing rows, will add at row 1`);
            return 0;
        }
        
        let lastRowIndex = -1;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const phone = row['الموبايل'];
            if (phone && phone !== '') {
                lastRowIndex = i;
            }
        }
        
        const nextRowIndex = lastRowIndex + 1;
        console.log(`   Last data row: ${lastRowIndex + 1}, next empty row: ${nextRowIndex + 1}`);
        return nextRowIndex;
        
    } catch (error) {
        console.error('Error finding last row:', error.message);
        return null;
    }
}

// ============================================
// SAVE NEW CONTACT AFTER LAST ENTRY IN COLUMN C
// ============================================
async function saveNewContact(contactName, phoneNumber) {
    if (!googleSheet) {
        console.log('⚠️ Google Sheet not ready');
        return false;
    }
    
    if (knownContacts.has(phoneNumber)) {
        console.log(`⏭️ Contact already exists: ${contactName} (${phoneNumber})`);
        return false;
    }
    
    try {
        const now = new Date();
        const date = now.toLocaleDateString('ar-EG');
        const targetRowIndex = await findLastRowWithData();
        
        if (targetRowIndex === null) {
            console.log('❌ Could not find target row');
            return false;
        }
        
        const rows = await googleSheet.getRows();
        
        if (targetRowIndex < rows.length) {
            const existingRow = rows[targetRowIndex];
            const existingPhone = existingRow['الموبايل'];
            
            if (!existingPhone || existingPhone === '') {
                existingRow['الاسم'] = contactName;
                existingRow['الموبايل'] = phoneNumber;
                existingRow['التاريخ'] = date;
                await existingRow.save();
                console.log(`✅ NEW CONTACT SAVED in existing row ${targetRowIndex + 2}:`);
            } else {
                await googleSheet.addRow({
                    '': '',
                    'الاسم': contactName,
                    'الموبايل': phoneNumber,
                    'التاريخ': date
                });
                console.log(`✅ NEW CONTACT SAVED as new row ${targetRowIndex + 2}:`);
            }
        } else {
            await googleSheet.addRow({
                '': '',
                'الاسم': contactName,
                'الموبايل': phoneNumber,
                'التاريخ': date
            });
            console.log(`✅ NEW CONTACT SAVED as new row ${targetRowIndex + 2}:`);
        }
        
        knownContacts.add(phoneNumber);
        
        console.log(`   👤 Name (Column B): ${contactName}`);
        console.log(`   📱 Phone (Column C): ${phoneNumber}`);
        console.log(`   📅 Date (Column D): ${date}`);
        return true;
    } catch (error) {
        console.error('❌ Save error:', error.message);
        return false;
    }
}

// ============================================
// EXTRACT PHONE NUMBER
// ============================================
function extractPhoneNumber(contact) {
    if (contact.number) return contact.number;
    if (contact.id && contact.id.user) return contact.id.user;
    return 'Unknown';
}

// ============================================
// WHATSAPP SETUP - RAILWAY OPTIMIZED
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
        }
    });
    
    client.on('qr', (qr) => {
        console.log('\n' + '='.repeat(50));
        console.log('📱 SCAN THIS QR CODE WITH WHATSAPP:');
        console.log('='.repeat(50));
        qrcode.generate(qr, { small: true });
        console.log('\nInstructions:');
        console.log('1. Open WhatsApp on your phone');
        console.log('2. Go to Settings → Linked Devices');
        console.log('3. Tap "Link a Device"');
        console.log('4. Scan the QR code above');
        console.log('='.repeat(50) + '\n');
    });
    
    client.on('ready', () => {
        console.log('\n' + '='.repeat(50));
        console.log('✅ WHATSAPP BOT IS READY!');
        console.log('='.repeat(50));
        console.log('📡 Monitoring for NEW contacts only...');
        console.log('📊 New contacts will be added AFTER the last entry in Column C');
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

process.on('SIGINT', () => {
    console.log('\n\n🛑 Shutting down bot...');
    process.exit(0);
});

main().catch(console.error);