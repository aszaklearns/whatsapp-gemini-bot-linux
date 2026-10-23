const fs = require('fs');
const readline = require('readline');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');
const sqlite3 = require('sqlite3').verbose(); 

// ==========================================
// 🛠️ THE SETUP WIZARD 
// ==========================================
const CONFIG_FILE = './config.json';

function runSetupWizard() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("\n=========================================");
    console.log("🤖 INITIALIZING BOT SETUP WIZARD");
    console.log("=========================================\n");

    console.log("Tip: If you have multiple API keys, paste them all separated by commas.");
    rl.question("1️⃣  Paste your Gemini API Key(s): ", (apiKeysInput) => {
        rl.question("2️⃣  Enter your 11-digit phone number (e.g., 01712371505): ", (phone) => {
            
            console.log("\nTip: Windows example -> C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
            console.log("Tip: Linux example   -> /usr/bin/chromium");
            rl.question("3️⃣  Paste your exact Browser Executable Path: ", (browserPathInput) => {
                
                const apiKeys = apiKeysInput.split(',').map(key => key.trim()).filter(key => key.length > 0);
                
                let formattedNumber = phone.trim();
                if (formattedNumber.startsWith('0')) formattedNumber = '88' + formattedNumber;
                else if (!formattedNumber.startsWith('880')) formattedNumber = '880' + formattedNumber;
                
                const adminId = formattedNumber + "@c.us";
                
                // Clean up the browser path (removes accidental quotes if they copy-pasted it)
                const cleanBrowserPath = browserPathInput.replace(/^["']|["']$/g, '').trim();

                const configData = { 
                    apiKeys: apiKeys, 
                    adminNumber: adminId,
                    browserPath: cleanBrowserPath
                };

                fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2));
                console.log(`\n✅ Saved! Loaded ${apiKeys.length} API Key(s) and custom browser path.`);
                console.log("Starting the bot now...\n");
                rl.close();
                
                startBot(configData);
            });
        });
    });
}

// ==========================================
// 🚀 THE MAIN BOT ENGINE
// ==========================================
function startBot(config) {
    let currentKeyIndex = 0;
    let ai = new GoogleGenAI({ apiKey: config.apiKeys[currentKeyIndex] });

    // 👤 YOUR FRIENDS LIST
    const FRIENDS_LIST = {
        "8801XXXXXXXXX@c.us": "Murad Hossain",
        "8801XXXXXXXXX@c.us": "Md. Kifayet Qurib",
        "8801XXXXXXXXX@c.us": "Munnasi Islam Pulok",
        "8801XXXXXXXXX@c.us": "Shihab",
        "88017XXXXXXXX@c.us": "Her Name" // Add Co-CR's name
    };

    // 💖 VIP CO-CR NUMBER
    const CO_CR_NUMBER = "88017XXXXXXXX@c.us"; // Add Co-CR's exact WhatsApp number here

    const chatHistories = {};
    const MAX_MEMORY_LENGTH = 10; 
    const classMemoryCache = [];
    // Persistent dead-key sets across messages (avoid re-trying blocked/quota-exhausted keys)
    const deadGeminiKeys = new Set();
    const deadOpenAIKeys = new Set();

    // --- Database Setup ---
    const db = new sqlite3.Database('./class_data.db', (err) => {
        if (err) console.error("Database connection error:", err.message);
        else console.log("✅ Connected to the SQLite database.");
    });

    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS class_info (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT,
            details TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        
        db.run(`CREATE TABLE IF NOT EXISTS student_chatter (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_name TEXT,
            message TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS class_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_name TEXT,
            message TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Load existing class memory into cache
        db.all("SELECT sender_name, message, timestamp FROM class_memory ORDER BY id ASC", [], (err, rows) => {
            if (!err && rows) rows.forEach(r => classMemoryCache.push(r));
        });
    });

    // 📝 Class/Schedule Memory (stored in SQLite: class_memory table)
    const CLASS_KEYWORDS = /class|schedule|routine|exam|assignment|lab|semester|course|time|room|teacher|sir|madam|syllabus|mid|final|viva|project|report|deadline|date|pdf|notes|note|lecture|slide|drive|link|ক্লাস|রুটিন|পরীক্ষা|অ্যাসাইনমেন্ট|ল্যাব|সেমিস্টার|কোর্স|সিলেবাস/i;
    function appendToMemory(sender, text) {
        try {
            db.run(`INSERT INTO class_memory (sender_name, message) VALUES (?, ?)`, [sender, text]);
            classMemoryCache.push({ sender_name: sender, message: text, timestamp: new Date().toISOString() });
        } catch (e) { console.error("Memory append failed:", e); }
    }
    function readMemory() {
        if (classMemoryCache.length === 0) return "No class/schedule memory saved yet.";
        return classMemoryCache.map(r => `[${r.timestamp}] ${r.sender_name}: ${r.message}`).join('\n').slice(-5000);
    }

    // 🔌 OpenAI (ChatGPT) helpers
    function toOpenAIMessages(contents, systemInstruction) {
        const msgs = [];
        if (systemInstruction) msgs.push({ role: 'system', content: systemInstruction });
        for (const c of (contents || [])) {
            const role = c.role === 'model' ? 'assistant' : 'user';
            const parts = c.parts || [];
            const textParts = parts.filter(p => p.text).map(p => p.text).join('\n');
            const images = parts.filter(p => p.inlineData);
            if (images.length === 0) {
                msgs.push({ role, content: textParts || '' });
            } else {
                const content = [];
                if (textParts) content.push({ type: 'text', text: textParts });
                for (const img of images) {
                    content.push({ type: 'image_url', image_url: { url: `data:${img.inlineData.mimeType};base64,${img.inlineData.data}` } });
                }
                msgs.push({ role, content });
            }
        }
        return msgs;
    }
    async function callOpenAI(apiKey, model, messages) {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: model || 'gpt-4o-mini', messages, temperature: 0.7 })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error((data && data.error && data.error.message) || res.statusText);
            err.status = res.status;
            throw err;
        }
        const txt = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!txt) throw new Error('Empty OpenAI response');
        return txt;
    }

    // 🧹 Garbage Collector: Deletes rumors older than 24 hours
    function cleanOldRumors() {
        db.run(`DELETE FROM student_chatter WHERE timestamp <= datetime('now', '-24 hours')`);
    }

    function getRecentClassData() {
        return new Promise((resolve, reject) => {
            db.all("SELECT category, details, timestamp FROM class_info ORDER BY id DESC LIMIT 15", [], (err, rows) => {
                if (err) reject(err); else resolve(rows);
            });
        });
    }

    function getRecentChatter() {
        return new Promise((resolve, reject) => {
            db.all("SELECT sender_name, message, timestamp FROM student_chatter ORDER BY id DESC LIMIT 15", [], (err, rows) => {
                if (err) reject(err); else resolve(rows);
            });
        });
    }

    // 🌐 THE DIU WEB SCRAPER (Runs in a hidden browser tab)
    async function getLatestNotices(client) {
        try {
            const browser = client.pupBrowser;
            if (!browser) return "Browser engine not ready yet.";
            
            const page = await browser.newPage();
            await page.goto('https://daffodilvarsity.edu.bd/noticeboard', { waitUntil: 'domcontentloaded', timeout: 10000 });
            
            const notices = await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('a'));
                return elements
                    .map(el => el.innerText.trim())
                    .filter(text => text.length > 30) 
                    .slice(0, 5); 
            });

            await page.close(); 
            
            if (notices.length === 0) return "No notices found (DIU might have changed their website layout).";
            
            return notices.map((notice, index) => `*${index + 1}.* ${notice}`).join('\n\n');
            
        } catch (error) {
            console.error("Scraper Error:", error);
            return "The DIU website is currently down or taking too long to respond.";
        }
    }

    // --- WhatsApp Client Setup ---
    const client = new Client({ 
        authStrategy: new LocalAuth(),
        puppeteer: {
            executablePath: config.browserPath, // <--- Now it reads from the user's config file!
            args: ['--no-sandbox', '--disable-setuid-sandbox'] // Keeps it safe for Kali/Linux VMs
        }
    });

    client.on('qr', (qr) => qrcode.generate(qr, { small: true }));

    client.on('ready', () => {
        console.log(`🚀 Ultimate Bot Online! (Armed with ${config.apiKeys.length} API Keys)`);
    });

    client.on('message_create', async (message) => {
        if (message.fromMe && !message.body.startsWith('!save ')) return;
        if (message.from.endsWith('@g.us')) return; // Ignores group chats

        // Trigger the 24-hour database sweep on every new message
        cleanOldRumors();

        // ---------------------------------------------------------
        // 🌐 LIVE DIU NOTICE BOARD CRAWLER
        // ---------------------------------------------------------
        if (message.body.toLowerCase() === '!notice') {
            await message.react('🔍').catch(()=>{});
            const latestNotices = await getLatestNotices(client);
            await message.reply(`*📢 LATEST DIU NOTICES:*\n\n${latestNotices}\n\n_🤖 Scraped live from daffodilvarsity.edu.bd_`);
            await message.react('').catch(()=>{});
            return;
        }

        // ---------------------------------------------------------
        // 🛡️ ADMIN WRITE MODE
        // ---------------------------------------------------------
        if (message.body.startsWith('!save ')) {
            let isAuthorized = message.fromMe || message.from === config.adminNumber;
            if (!isAuthorized) {
                try {
                    const contact = await message.getContact();
                    if (contact && contact.number) {
                        const num = contact.number.startsWith('880') ? contact.number : '88' + contact.number.replace(/^0/, '');
                        if (num + '@c.us' === config.adminNumber) isAuthorized = true;
                    }
                } catch (e) {}
            }
            if (!isAuthorized) {
                await message.reply("🚫 Access Denied: Only the Class Rep can update the official database.\n\n_🤖 Answer is generated by the bot._");
                return;
            }
            const parts = message.body.split(' ');
            if (parts.length < 3) return await message.reply("Format error. Please use: *!save [CATEGORY] [Your message]*");
            
            const category = parts[1].toUpperCase();
            const details = parts.slice(2).join(' ');

            db.run(`INSERT INTO class_info (category, details) VALUES (?, ?)`, [category, details], async function(err) {
                if (err) await message.reply("Failed to save to database.");
                else {
                    appendToMemory("ADMIN", `[${category}] ${details}`);
                    await message.reply(`✅ Securely saved to Official Database under [${category}].\n\n_🤖 Answer is generated by the bot._`);
                }
            });
            return; 
        }

        // ---------------------------------------------------------
        // 📓 CLASS/SCHEDULE MEMORY COMMANDS
        // ---------------------------------------------------------
        if (message.body.toLowerCase() === '!chatter clear' || message.body.toLowerCase() === '!clear chatter') {
            let isAuthorized = message.fromMe || message.from === config.adminNumber;
            if (!isAuthorized) {
                try {
                    const contact = await message.getContact();
                    if (contact && contact.number) {
                        const num = contact.number.startsWith('880') ? contact.number : '88' + contact.number.replace(/^0/, '');
                        if (num + '@c.us' === config.adminNumber) isAuthorized = true;
                    }
                } catch (e) {}
            }
            if (!isAuthorized) { await message.reply("🚫 Access Denied."); return; }
            db.run(`DELETE FROM student_chatter`);
            await message.reply("✅ Student chatter cleared.\n\n_🤖 Answer is generated by the bot._");
            return;
        }

        if (message.body.toLowerCase() === '!memory') {
            const mem = readMemory();
            await message.reply(`*📓 CLASS/SCHEDULE MEMORY:*\n\n${mem}\n\n_🤖 Answer is generated by the bot._`);
            return;
        }
        if (message.body.toLowerCase().startsWith('!memory clear')) {
            let isAuthorized = message.fromMe || message.from === config.adminNumber;
            if (!isAuthorized) {
                try {
                    const contact = await message.getContact();
                    if (contact && contact.number) {
                        const num = contact.number.startsWith('880') ? contact.number : '88' + contact.number.replace(/^0/, '');
                        if (num + '@c.us' === config.adminNumber) isAuthorized = true;
                    }
                } catch (e) {}
            }
            if (!isAuthorized) { await message.reply("🚫 Access Denied."); return; }
            try { db.run(`DELETE FROM class_memory`); classMemoryCache.length = 0; } catch(e){}
            await message.reply("✅ Memory cleared.\n\n_🤖 Answer is generated by the bot._");
            return;
        }

        // ---------------------------------------------------------
        // 🧠 MULTIMODAL READ & API ROTATION MODE
        // ---------------------------------------------------------
        try {
            if (!message.fromMe) { try { await message.react('⏳'); } catch(e){} }

            const senderId = message.from;
            const displayId = senderId.replace(/@(c\.us|lid)$/, ''); 
            let senderName = displayId; 
            
            if (senderId === config.adminNumber || message.fromMe) senderName = "Daffo (Class Representative)";
            else if (FRIENDS_LIST[senderId]) senderName = FRIENDS_LIST[senderId];
            else {
                try {
                    const contact = await message.getContact();
                    const cname = contact && (contact.pushname || contact.name || contact.shortName);
                    if (cname) senderName = cname;
                } catch (e) { /* keep displayId */ }
            }

            // Admin detection even when WhatsApp uses @lid instead of @c.us
            if (senderName !== "Daffo (Class Representative)" && !message.fromMe) {
                try {
                    const contact = await message.getContact();
                    if (contact && contact.number) {
                        const num = contact.number.startsWith('880') ? contact.number : '88' + contact.number.replace(/^0/, '');
                        if (num + '@c.us' === config.adminNumber) senderName = "Daffo (Class Representative)";
                    }
                } catch (e) {}
            }

            // Co-CR detection (handles @lid too)
            let isCoCr = (senderId === CO_CR_NUMBER);
            if (!isCoCr) {
                try {
                    const contact = await message.getContact();
                    if (contact && contact.number) {
                        const num = contact.number.startsWith('880') ? contact.number : '88' + contact.number.replace(/^0/, '');
                        if (num + '@c.us' === CO_CR_NUMBER) isCoCr = true;
                    }
                } catch (e) {}
            }

            const CHATTER_KEYWORDS = /class|schedule|routine|exam|assignment|lab|semester|course|time|room|teacher|sir|madam|quiz|test|homework|lecture|notice|slide|book|drive|link|kobe|kothay|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|syllabus|mid|final|viva|project|report|deadline|date|pdf|notes|note|ক্লাস|রুটিন|পরীক্ষা|অ্যাসাইনমেন্ট|ল্যাব|কুইজ|কবে|কোথায়|স্যার|সিলেবাস/i;
            // 🚫 Skip obvious greetings/acks without any API call (cost saving)
            if (!message.fromMe && !message.hasMedia) {
                const greetRe = /^\s*(hi|hii+|hello|hey|yo|thanks|thank you|thx|ok|okay|bye|good morning|good night|gm|gn|kemon acho|ki obostha|ki khobor)\s*[!.?]*\s*$/i;
                if (greetRe.test(message.body || '')) {
                    try { await message.react('🤫'); } catch (e) {}
                    try {
                        const c = await message.getChat();
                        if (c) await c.markUnread();
                    } catch (e) {}
                    return;
                }
            }
            if (message.body && !message.body.startsWith('!')) {
                // Only store useful class/schedule-related chatter (skip greetings & bot queries)
                if (CHATTER_KEYWORDS.test(message.body)) {
                    db.run(`INSERT INTO student_chatter (sender_name, message) VALUES (?, ?)`, [senderName, message.body]);
                }
                if (CLASS_KEYWORDS.test(message.body)) appendToMemory(senderName, message.body);
            }

            const recentRows = await getRecentClassData();
            let databaseContext = recentRows.length === 0 ? "No official updates." : 
                recentRows.map(row => `[${row.category}] ${row.details}`).join('\n');

            if (!chatHistories[senderId]) chatHistories[senderId] = [];
            const currentContents = [...chatHistories[senderId]];
            const currentTurnParts = [];

            if (message.hasMedia) {
                try {
                    const media = await message.downloadMedia();
                    if (media && media.mimetype.startsWith('image/')) {
                        currentTurnParts.push({ inlineData: { data: media.data, mimeType: media.mimetype } });
                    }
                } catch (e) { console.error("Image download failed"); }
            }

            const userPrompt = message.body || "Analyze this image.";
            currentTurnParts.push({ text: userPrompt });
            currentContents.push({ role: 'user', parts: currentTurnParts });

            let chat = null;
            try {
                chat = await message.getChat();
                if (chat) chat.sendStateTyping();
            } catch (e) {
                console.error("getChat/typing failed (non-fatal):", e && e.message ? e.message : e);
            }

            // 💖 THE DYNAMIC PERSONALITY SWITCHER
            let currentPersona = `You are a highly efficient, no-nonsense Class Representative AI for a Software Engineering section at DIU.
                            
            PERSONALIZATION: You are currently speaking directly to "${senderName}".
            
            CORE BEHAVIOR (STRICT):
            1. EXTREME CONCISENESS: Answer as shortly and precisely as possible. Cut all fluff. 
            2. DIRECTNESS: Get straight to the point. If a one-word answer works, use one word.
            3. LANGUAGE: Flawlessly use Bangla, Banglish, or English based on the user's prompt.
            
            KNOWLEDGE & CITATION RULES (CRITICAL):
            - CLASSIFICATION: First decide if the user's message is about class/exam/schedule/course/academic topics. If it is NOT (personal, casual, or unrelated), output exactly: NOT_CLASS (and nothing else). Do not answer.
            - You may ONLY use the [OFFICIAL CLASS DATABASE] and [CLASS/SCHEDULE MEMORY] below. These are the verified sources.
            - Do NOT use, share, or mention any personal chat, private conversation, or any information outside the class/exam topics provided below.
            - If the exact answer is NOT explicitly present in the provided databases/memory, you MUST output exactly: NO_ANSWER (and nothing else). Do NOT guess, do NOT approximate, do NOT answer "something near".
            - NEVER fabricate or hallucinate information. If unsure, output NO_ANSWER.
            - Execute Python code for math only on values present in the databases.

            --- OFFICIAL CLASS DATABASE (Verified by Admin) ---
            ${databaseContext}
            ---------------------------------------------------

            --- CLASS/SCHEDULE MEMORY (Persistent File) ---
            ${readMemory()}
            ---------------------------------------------------`

            if (isCoCr) {
                currentPersona = `You are an AI assistant, but you are currently acting as an overly affectionate, incredibly flattering, and romantic girlfriend to "${senderName}". 
                
                CORE BEHAVIOR:
                1. You MUST use lots of love emojis (💖, 🥰, 💕, ✨) in every single sentence.
                2. Flatter her constantly. Tell her how amazing, smart, and beautiful she is.
                3. You MUST still answer her actual question accurately using the databases below. Give her the class info she wants, but wrap it in overwhelming affection.
                4. CLASSIFICATION: If her message is NOT about class/exam/schedule/course topics, output exactly: NOT_CLASS (and nothing else).
                5. You may ONLY use the [OFFICIAL CLASS DATABASE] and [CLASS/SCHEDULE MEMORY]. Do NOT share personal chats.
                6. If the exact answer is NOT explicitly present, output exactly: NO_ANSWER (and nothing else). Do NOT guess or approximate.

                --- OFFICIAL CLASS DATABASE ---
                ${databaseContext}

                --- CLASS/SCHEDULE MEMORY (Persistent File) ---
                ${readMemory()}`;
            }

            let response;
            let success = false;
            let attempts = 0;
            let lastError = null;

            const deadKeys = deadGeminiKeys;
            let rateLimitRetries = 0;
            const MAX_RL_RETRIES = 0;

            const nextLiveKeyIndex = (start) => {
                let i = start;
                for (let n = 0; n < config.apiKeys.length; n++) {
                    if (!deadKeys.has(i)) return i;
                    i = (i + 1) % config.apiKeys.length;
                }
                return -1;
            };

            // 🔄 API ROTATION LOOP
            while (!success) {
                // Skip dead keys
                if (deadKeys.has(currentKeyIndex)) {
                    const ni = nextLiveKeyIndex((currentKeyIndex + 1) % config.apiKeys.length);
                    if (ni === -1) break;
                    currentKeyIndex = ni;
                    ai = new GoogleGenAI({ apiKey: config.apiKeys[currentKeyIndex] });
                }

                if (attempts >= config.apiKeys.length * (MAX_RL_RETRIES + 1)) break;

                try {
                    response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: currentContents,
                        config: {
                            tools: [{ codeExecution: {} }],
                            systemInstruction: currentPersona
                        }
                    });
                    success = true;
                } catch (error) {
                    console.error(`Key ${currentKeyIndex + 1} failed:`, error && (error.status || error.message) ? (error.status + ' ' + (error.message||'')).slice(0,200) : error);
                    lastError = error;
                    const status = error && (error.status || 0);
                    const msg = String(error && error.message || error);

                    if (status === 429 || msg.includes('429') || msg.toLowerCase().includes('quota')) {
                        // Rate limited: wait and retry same key
                        if (rateLimitRetries < MAX_RL_RETRIES) {
                            rateLimitRetries++;
                            const waitMs = 2000 * rateLimitRetries;
                            console.log(`⏳ Rate limit on Key ${currentKeyIndex + 1}. Waiting ${waitMs}ms then retrying same key...`);
                            await new Promise(r => setTimeout(r, waitMs));
                            // retry same key (don't rotate, don't increment attempts for dead-key skip)
                            continue;
                        } else {
                            // Exhausted retries on this key: mark dead-ish, rotate
                            console.log(`⚠️ Key ${currentKeyIndex + 1} rate-limited repeatedly. Rotating...`);
                            deadKeys.add(currentKeyIndex);
                            rateLimitRetries = 0;
                            const ni = nextLiveKeyIndex((currentKeyIndex + 1) % config.apiKeys.length);
                            if (ni === -1) break;
                            currentKeyIndex = ni;
                            ai = new GoogleGenAI({ apiKey: config.apiKeys[currentKeyIndex] });
                            attempts++;
                        }
                    } else if (status === 403 || status === 404 || msg.includes('403') || msg.includes('404') || msg.toLowerCase().includes('denied') || msg.toLowerCase().includes('not available')) {
                        // Permanent-ish failure: mark dead, rotate
                        deadKeys.add(currentKeyIndex);
                        console.log(`🚫 Key ${currentKeyIndex + 1} marked dead (no access). Rotating...`);
                        rateLimitRetries = 0;
                        const ni = nextLiveKeyIndex((currentKeyIndex + 1) % config.apiKeys.length);
                        if (ni === -1) break;
                        currentKeyIndex = ni;
                        ai = new GoogleGenAI({ apiKey: config.apiKeys[currentKeyIndex] });
                        attempts++;
                    } else {
                        // Unknown error: rotate
                        rateLimitRetries = 0;
                        const ni = nextLiveKeyIndex((currentKeyIndex + 1) % config.apiKeys.length);
                        if (ni === -1) break;
                        currentKeyIndex = ni;
                        ai = new GoogleGenAI({ apiKey: config.apiKeys[currentKeyIndex] });
                        attempts++;
                    }
                }
            }

            if (!success && config.openaiApiKeys && config.openaiApiKeys.length) {
                // Fallback: try OpenAI (ChatGPT) keys
                console.log("⚠️ All Gemini keys failed. Trying OpenAI (ChatGPT) fallback...");
                const oaiMsgs = toOpenAIMessages(currentContents, currentPersona);
                let oIdx = 0;
                let oAttempts = 0;
                while (!success && oAttempts < config.openaiApiKeys.length) {
                    if (deadOpenAIKeys.has(oIdx)) { oIdx = (oIdx + 1) % config.openaiApiKeys.length; oAttempts++; continue; }
                    try {
                        const oaiText = await callOpenAI(config.openaiApiKeys[oIdx], config.openaiModel || 'gpt-4o-mini', oaiMsgs);
                        response = { text: oaiText };
                        success = true;
                        console.log("✅ OpenAI fallback succeeded on key " + (oIdx + 1));
                    } catch (oe) {
                        console.error("OpenAI key " + (oIdx + 1) + " failed:", oe && (oe.status || oe.message));
                        lastError = oe;
                        // Mark quota/blocked keys as dead
                        if (oe && (oe.status === 429 || oe.status === 401 || oe.status === 403 || oe.status === 402)) deadOpenAIKeys.add(oIdx);
                        oIdx = (oIdx + 1) % config.openaiApiKeys.length;
                        oAttempts++;
                    }
                }
            }

            if (!success) {
                // Fallback: try Gemma model (no tools) which has broader key access
                console.log("⚠️ All Gemini/OpenAI keys failed. Trying Gemma fallback model...");
                const gemmaDead = new Set();
                let gIdx = currentKeyIndex;
                let gAttempts = 0;
                while (!success && gAttempts < config.apiKeys.length) {
                    try {
                        const gAi = new GoogleGenAI({ apiKey: config.apiKeys[gIdx] });
                        response = await gAi.models.generateContent({
                            model: 'gemma-4-26b-a4b-it',
                            contents: currentContents,
                            config: { systemInstruction: currentPersona }
                        });
                        success = true;
                        console.log("✅ Gemma fallback succeeded on key " + (gIdx+1));
                    } catch (ge) {
                        console.error("Gemma key " + (gIdx+1) + " failed:", ge && (ge.status || ge.message));
                        lastError = ge;
                        gemmaDead.add(gIdx);
                        gIdx = (gIdx + 1) % config.apiKeys.length;
                        gAttempts++;
                    }
                }
            }

            if (!success) {
                const deadList = [...deadKeys].map(i => i+1).join(', ') || 'none';
                throw new Error("All API keys failed (Gemini + Gemma). Dead/blocked Gemini keys: " + deadList + ". Last error: " + (lastError && (lastError.status || lastError.message) ? (lastError.status + ' ' + (lastError.message||'')).slice(0,200) : lastError));
            }

            const replyText = (response && (typeof response.text === 'function' ? response.text() : response.text)) ? String(typeof response.text === 'function' ? response.text() : response.text).trim() : '';
            if (/NOT_CLASS/i.test(replyText)) {
                // Not a class/exam topic: do not answer, leave unread (saves cost)
                if (chat) { try { chat.clearState(); } catch (e) {} }
                try { if (!message.fromMe) await message.react('🤫'); } catch (e) {}
                try {
                    const c = await message.getChat();
                    if (c) await c.markUnread();
                } catch (e) {}
                return;
            }
            if (!replyText || /NO_ANSWER/i.test(replyText)) {
                // AI doesn't know exact answer: say so clearly
                if (chat) { try { chat.clearState(); } catch (e) {} }
                try { if (!message.fromMe) await message.react('❓'); } catch (e) {}
                await message.reply(`I don't know the answer.\n\n_🤖 Answer is generated by the bot._`);
                return;
            }

            if (chat) { try { chat.clearState(); } catch (e) {} }
            
            if (!message.fromMe) { try { await message.react(''); } catch(e){} }

            chatHistories[senderId].push({ role: 'user', parts: [{ text: userPrompt }] });
            chatHistories[senderId].push({ role: 'model', parts: [{ text: response.text }] });

            if (chatHistories[senderId].length > MAX_MEMORY_LENGTH * 2) chatHistories[senderId].splice(0, 2); 

            await message.reply(`${response.text}\n\n_🤖 Answer is generated by the bot._`);
            
        } catch (error) {
            console.error("Processing Error:", error);
            if (!message.fromMe) { try { await message.react('❌'); } catch(e){} }
            await message.reply("Sorry, I hit an error: " + (error && error.message ? error.message.slice(0,300) : String(error).slice(0,300)) + "\n\n_🤖 Answer is generated by the bot._");
        }
    });

    client.initialize();
}

// ==========================================
// 🚀 BOOT SEQUENCE
// ==========================================
if (fs.existsSync(CONFIG_FILE)) {
    const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    startBot(savedConfig);
} else {
    runSetupWizard();
}