const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

// Import node-fetch dengan benar
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const SCRIPT_DIR = 'C:/sikasep_wa';
const SESSION_FOLDER = path.join(SCRIPT_DIR, 'sessions');
const SESSION_BACKUP = path.join(SCRIPT_DIR, 'sessions_backup');
const BOT_FLAG = path.join(SCRIPT_DIR, 'bot_running.flag');
const LOG_FILE = path.join(SCRIPT_DIR, 'log.txt');
const PORT = 8000;
const LOOP_INTERVAL = 30000;
const API_HOSTING = 'https://sch.sikasep.id/api/get_pending_wa.php';
const API_UPDATE = 'https://sch.sikasep.id/api/update_status.php';
const API_WA_LOCAL = `http://localhost:${PORT}/send-message`;

// Nilai akan diambil dari environment variables yang diset di run.bat
const ID_SEKOLAH = process.env.ID_SEKOLAH ? process.env.ID_SEKOLAH.split(',') : [];
const TOKEN = process.env.TOKEN || '';

// ==============================
// GLOBALS
// ==============================
let clientInstance = null;
let serverInstance = null;
let isShuttingDown = false;
let sentIds = new Set();
let currentStatus = 'idle'; // idle | processing | ready

function log(msg, showConsole = false) {
    const ts = new Date().toISOString().replace('T',' ').split('.')[0];
    try { 
        fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`); 
        // Hanya tampilkan di console jika parameter showConsole true
        if (showConsole) {
            console.log(msg);
        }
    } catch(e) {}
}

// ==============================
// LOAD SENT IDS
// ==============================
try {
    const f = path.join(SCRIPT_DIR, 'sent_ids.json');
    if (fs.existsSync(f)) sentIds = new Set(JSON.parse(fs.readFileSync(f, 'utf8')));
} catch(e) { log('❌ Error load sent IDs: ' + e.message, true); }

// ==============================
// GRACEFUL SHUTDOWN
// ==============================
const gracefulShutdown = async (exitCode = 0) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log('🛑 Shutdown initiated...', true);
    currentStatus = 'idle';

    try {
        if (serverInstance) await new Promise(r => serverInstance.close(() => r()));
        if (clientInstance) await clientInstance.destroy();
        if (fs.existsSync(SESSION_FOLDER)) {
            fs.mkdirSync(SESSION_BACKUP, { recursive: true });
            require('child_process').execSync(`xcopy /E /I /Y "${SESSION_FOLDER}" "${SESSION_BACKUP}"`);
            log('💾 Session backup done', true);
        }
        if (fs.existsSync(BOT_FLAG)) fs.unlinkSync(BOT_FLAG);
        fs.writeFileSync(path.join(SCRIPT_DIR, 'sent_ids.json'), JSON.stringify(Array.from(sentIds)));
    } catch(e) { log('❌ Error during shutdown: ' + e.message, true); }
    finally { setTimeout(() => process.exit(exitCode), 500); }
};

process.on('SIGINT', () => gracefulShutdown());
process.on('SIGTERM', () => gracefulShutdown());
process.on('uncaughtException', (err) => { log('❌ ' + err.message, true); gracefulShutdown(1); });
process.on('unhandledRejection', (r) => { log('❌ ' + r, true); gracefulShutdown(1); });

// ==============================
// SETUP FOLDERS
// ==============================
if (!fs.existsSync(SESSION_FOLDER)) fs.mkdirSync(SESSION_FOLDER, { recursive: true });
if (!fs.existsSync(SESSION_BACKUP)) fs.mkdirSync(SESSION_BACKUP, { recursive: true });
fs.writeFileSync(BOT_FLAG, 'running');

// ==============================
// WHATSAPP-WEB.JS CLIENT
// ==============================
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'sikasep',
        dataPath: SESSION_FOLDER
    }),
    puppeteer: {
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
});

client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    log('QR code generated', true);
});

client.on('ready', () => {
    clientInstance = client;
    currentStatus = 'ready';
    log('✅ WhatsApp ready', true);
});

client.on('message', msg => {
    if (isShuttingDown) return;
    if (msg.body.toLowerCase() === 'halo') {
        msg.reply('Hai! Bot aktif 🚀').catch(() => {});
    }
});

client.on('auth_failure', () => {
    log('❌ Authentication failed', true);
});

client.initialize().catch(err => {
    log('❌ Client initialization error: ' + err.message, true);
    gracefulShutdown(1);
});

// ==============================
// EXPRESS SERVER
// ==============================
const app = express();
app.use(bodyParser.json());
app.use((req, res, next) => {
    if (isShuttingDown) return res.status(503).json({ status: false, message: 'Server shutting down' });
    next();
});

// send-message endpoint
app.post('/send-message', async (req, res) => {
    if (isShuttingDown) return res.status(503).json({ status: false });
    const { phone, message } = req.body;
    if (!clientInstance) return res.status(500).json({ status: false, message: 'WA belum siap' });
    const target = phone.includes('@c.us') ? phone : phone + '@c.us';
    try {
        await clientInstance.sendMessage(target, message);
        res.json({ status: true, target });
        log('✅ Message sent to ' + target);
    } catch(e) { 
        res.status(500).json({ status: false, message: e.message }); 
        log('❌ Error sending message: ' + e.message, true);
    }
});

// status endpoint
app.get('/status', (req, res) => {
    res.json({
        status: currentStatus,
        clientReady: clientInstance ? true : false,
        pendingIds: sentIds.size,
        timestamp: new Date().toISOString(),
        sekolah: ID_SEKOLAH
    });
});

serverInstance = app.listen(PORT, () => log(`🚀 Server running at http://localhost:${PORT}`, true));

// ==============================
// PROCESS PENDING LOOP
// ==============================
async function processPending() {
    if (isShuttingDown || !clientInstance) return;
    currentStatus = 'processing';
    log('🔄 Processing pending messages...'); // Tidak ditampilkan di console

    try {
        for (const sekolahId of ID_SEKOLAH) {
            const resp = await fetch(`${API_HOSTING}?id_sekolah=${sekolahId}`);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            const newData = data.filter(d => !sentIds.has(d.id));

            for (const d of newData) {
                if (isShuttingDown) break;

                const payload = { phone: d.nohp, message: d.pesan };
                try {
                    const res = await fetch(API_WA_LOCAL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-auth': TOKEN },
                        body: JSON.stringify(payload)
                    });
                    const hasil = await res.json();
                    const status = hasil.status ? 'terkirim' : 'pending';
                    await fetch(`${API_UPDATE}?id=${d.id}&status=${status}&id_sekolah=${sekolahId}`);
                    log(`${status === 'terkirim' ? '✅' : '⏳'} Sekolah:${sekolahId} | ID:${d.id} | No:${d.nohp}`);
                    sentIds.add(d.id);

                    const delay = 1000 + Math.floor(Math.random() * 7000);
                    await new Promise(r => setTimeout(r, delay));

                } catch(e) { log('❌ ' + e.message, true); } // Error ditampilkan di console
            }
        }
    } catch(e) { log('❌ ' + e.message, true); } // Error ditampilkan di console
    finally { currentStatus = 'ready'; }
}

// start loop
processPending();
setInterval(processPending, LOOP_INTERVAL);
