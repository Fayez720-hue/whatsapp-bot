const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const fs = require('fs');

// ============================================
// CONFIGURATION - YOUR SHEET ID
// ============================================
const SHEET_ID = '1oZMWwvTHATw4Eoehm6URoysFwp3ylm8Bb0udy-qG1zg';  // <-- PASTE YOUR SHEET ID HERE

// Global variable for Google Sheet
let googleSheet = null;

// Track known contacts to avoid duplicate entries
const knownContacts = new Set();

// ============================================
// GOOGLE SHEETS SETUP
// ============================================
async function setupGoogleSheet() {
    try {
        // Check if credentials file exists
        if (!fs.existsSync('./credentials.json')) {
            console.error('❌ credentials.json file not found!');
            console.log('Please place credentials.json in:');
            console.log('C:\\Users\\original\\whatsapp-bot\\credentials.json');
            return false;
        }
        
        // Load credentials
        const creds = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
        
        // Connect to sheet
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
            // Set headers with column A empty
            await sheet.setHeaderRow([
                '',      // Column A - empty
                'الاسم', // Column B
                'الموبايل', // Column C
                'التاريخ'   // Column D
            ]);
            console.log('📋 Added headers: Column B (الاسم), Column C (الموبايل), Column D (التاريخ)');
        }
        
        // Load existing contacts to avoid duplicates (from column C - الموبايل)
        const existingRows = await sheet.getRows();
        for (const row of existingRows) {
            // Get phone number from column C
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
// FIND NEXT ROW WHERE COLUMN B AND C ARE EMPTY
// ============================================
async function findNextEmptyRow() {
    try {
        // Get all rows
        const rows = await googleSheet.getRows();
        
        // If no rows exist (only headers), return 0 (first row after headers)
        if (rows.length === 0) {
            return 0;
        }
        
        // Check each row to find where both الاسم and الموبايل are empty
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const name = row['الاسم'];
            const phone = row['الموبايل'];
            
            // Check if both columns B and C are empty
            if ((!name || name === '') && (!phone || phone === '')) {
                console.log(`   Found empty row at position ${i + 1} (Row ${i + 2} in sheet)`);
                return i; // Return the index of empty row
            }
        }
        
        // If no empty row found, return next row index after last
        console.log(`   No empty rows found, will add new row at the end`);
        return rows.length;
    } catch (error) {
        console.error('Error finding empty row:', error.message);
        return null;
    }
}

// ============================================
// SAVE NEW CONTACT TO NEXT EMPTY ROW
// ============================================
async function saveNewContact(contactName, phoneNumber) {
    if (!googleSheet) {
        console.log('⚠️ Google Sheet not ready');
        return false;
    }
    
    // Check if contact already exists
    if (knownContacts.has(phoneNumber)) {
        console.log(`⏭️ Contact already exists: ${contactName} (${phoneNumber})`);
        return false;
    }
    
    try {
        const now = new Date();
        const date = now.toLocaleDateString('ar-EG');
        
        // Find the next row where columns B and C are empty
        const emptyRowIndex = await findNextEmptyRow();
        
        if (emptyRowIndex === null) {
            console.log('❌ Could not find or create empty row');
            return false;
        }
        
        // Get all rows
        const rows = await googleSheet.getRows();
        
        if (emptyRowIndex < rows.length) {
            // Update existing empty row
            rows[emptyRowIndex]['الاسم'] = contactName;
            rows[emptyRowIndex]['الموبايل'] = phoneNumber;
            rows[emptyRowIndex]['التاريخ'] = date;
            await rows[emptyRowIndex].save();
            console.log(`✅ NEW CONTACT SAVED in existing empty row ${emptyRowIndex + 2}:`);
        } else {
            // Add new row at the end
            await googleSheet.addRow({
                '': '',
                'الاسم': contactName,
                'الموبايل': phoneNumber,
                'التاريخ': date
            });
            console.log(`✅ NEW CONTACT SAVED as new row ${emptyRowIndex + 2}:`);
        }
        
        // Add to known contacts set
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
// WHATSAPP SETUP
// ============================================
async function setupWhatsApp() {
    console.log('\n📱 Starting WhatsApp client...');
    
    const client = new Client({
        authStrategy: new LocalAuth({
    clientId: 'whatsapp-bot',
    dataPath: '/app/session-data'  // Railway volume path
}),
        puppeteer: {
    headless: true,  // Must be true on Railway
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
    ]
}
    });
    
    // QR Code handler
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
    
    // Ready handler
    client.on('ready', () => {
        console.log('\n' + '='.repeat(50));
        console.log('✅ WHATSAPP BOT IS READY!');
        console.log('='.repeat(50));
        console.log('📡 Monitoring for NEW contacts only...');
        console.log('📊 Looking for rows where BOTH columns B and C are empty:');
        console.log('   - Column B: Name (الاسم)');
        console.log('   - Column C: Phone (الموبايل)');
        console.log('   - Column D: Date (التاريخ)');
        console.log('   - Column A: Left empty');
        console.log('🔄 Existing contacts will be ignored');
        console.log('\n💡 To stop the bot: Press Ctrl+C\n');
    });
    
    // Incoming messages - check for new contacts
    client.on('message', async (message) => {
        try {
            const contact = await message.getContact();
            const phoneNumber = extractPhoneNumber(contact);
            const contactName = contact.pushname || contact.name || phoneNumber;
            
            console.log(`\n📨 Message from: ${contactName} (${phoneNumber})`);
            
            // Save only if this is a new contact
            await saveNewContact(contactName, phoneNumber);
            
        } catch (error) {
            console.error('Message processing error:', error);
        }
    });
    
    // Disconnection handler
    client.on('disconnected', (reason) => {
        console.log('\n⚠️ Disconnected:', reason);
        console.log('Restart the bot with: node index.js\n');
    });
    
    await client.initialize();
    return client;
}

// ============================================
// MAIN FUNCTION
// ============================================
async function main() {
    console.clear();
    console.log('\n' + '='.repeat(50));
    console.log('🚀 WHATSAPP NEW CONTACT TRACKER');
    console.log('='.repeat(50));
    console.log(`Started: ${new Date().toLocaleString()}`);
    console.log('='.repeat(50) + '\n');
    
    // Connect to Google Sheets
    console.log('📊 Connecting to Google Sheets...');
    const sheetConnected = await setupGoogleSheet();
    
    if (!sheetConnected) {
        console.log('\n⚠️ Cannot continue without Google Sheets');
        console.log('Please fix the credentials and try again');
        return;
    }
    
    // Start WhatsApp
    await setupWhatsApp();
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n' + '='.repeat(50));
    console.log('🛑 Shutting down bot...');
    console.log(`📊 Total contacts tracked: ${knownContacts.size}`);
    console.log('='.repeat(50) + '\n');
    process.exit(0);
});

// Run the bot
main().catch(console.error);