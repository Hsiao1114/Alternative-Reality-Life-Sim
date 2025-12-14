// 這是 Node.js/Express 後端伺服器程式碼。
// 在執行前，請確保您已安裝 'express', 'cors', 'body-parser'
// npm install express cors body-parser

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = 3000;

// 儲存每個使用者的聊天會話歷史與世界狀態。
// 包含 startTime 和 gameDurationSeconds
const gameSessions = {};

// --- JSON Schema 定義 ---
// AI 輸出的結構必須遵循此 Schema
const GAME_RESPONSE_SCHEMA = {
    type: "OBJECT",
    properties: {
        "narrative": {
            "type": "STRING",
            "description": "AI 輸出的豐富、生動的故事描述和情境回饋。"
        },
        "achievement_unlocked": {
            "type": "BOOLEAN",
            "description": "如果玩家的行動達成 current_goal 或一個主要子目標，設置為 true。"
        },
        "status_update": {
            "type": "OBJECT",
            "description": "結構化地向後端發送狀態變更指令。",
            "properties": {
                "health_change": {"type": "INTEGER", "description": "生命值變化 (例如：-5 受傷，+10 治癒)。"},
                "money_change": {"type": "INTEGER", "description": "貨幣或金錢變化 (例如：+1000000 中獎，-10 購買)。"},
                "new_event_description": {"type": "STRING", "description": "一個簡潔的新事件描述，將被添加到 world_events 日誌中（例如：'成功說服了公爵，獲得了許可證'）。"}
            },
            required: ["health_change", "money_change", "new_event_description"]
        },
        "game_state_change": {
            "type": "OBJECT",
            "description": "處理決定性遊戲狀態的變化。",
            "properties": {
                "game_over": {"type": "BOOLEAN", "description": "如果玩家死亡、被處決或達到無法挽回的失敗狀態，設置為 true。"},
                "critical_message": {"type": "STRING", "description": "在 Game Over 時顯示給玩家的最終訊息。"}
            },
            required: ["game_over", "critical_message"]
        }
    },
    required: ["narrative", "achievement_unlocked", "status_update", "game_state_change"]
};


// --- 中間件配置 (CORS FIX) ---
// 1. 設置一個最寬鬆的 CORS 配置，明確處理所有來源
app.use(cors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// 2. 處理 Preflight OPTIONS 請求 (FIX: 避免 PathError)
// 使用 app.use 捕獲 OPTIONS 請求並手動發送 200 回應
app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return res.sendStatus(200);
    }
    next();
});

app.use(bodyParser.json()); 


// --- 輔助函式：處理指數退避的 API 呼叫 ---
async function fetchWithRetry(apiUrl, payload, headers, retries = 3) {
    let lastError = null;
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                if (i < retries - 1) {
                    const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
                    console.warn(`API 呼叫失敗 (${response.status})，等待 ${delay}ms 後重試...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue; 
                }
                const errorText = await response.text();
                console.error(`[API Rejected] Status: ${response.status}. Raw Response: ${errorText}`);
                throw new Error(`API 錯誤: ${response.statusText} (${response.status}). 伺服器回應: ${errorText}`);
            }
            return await response.json();
        } catch (error) {
            lastError = error;
            if (i === retries - 1) throw lastError;
            const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// --- 輔助函式：使用結構化 JSON 更新長期記憶 ---
function analyzeAndUpdateContext(userId, parsedJson, message) {
    const session = gameSessions[userId];
    if (!session || !parsedJson.status_update) return;

    const { health_change, money_change, new_event_description } = parsedJson.status_update;
    let updatedBio = session.worldContext.player_bio;
    
    // Regex用於精確定位並替換狀態值
    const healthRegex = /生命值 (\d+)/;
    const moneyRegex = /金錢 (\d+)/;
    
    // 1. 處理 Health Change
    if (typeof health_change === 'number') {
        updatedBio = updatedBio.replace(healthRegex, (match, currentHealthStr) => {
            const currentHealth = parseInt(currentHealthStr);
            const newHealth = Math.max(0, currentHealth + health_change);
            // 如果血量為 0，且 AI 沒有設置 game_over: true，我們強制將其設置為 0
            if (newHealth === 0 && !parsedJson.game_state_change.game_over) {
                parsedJson.game_state_change.game_over = true;
                parsedJson.game_state_change.critical_message = "你的生命值已歸零，你因傷勢過重而死亡！";
            }
            return `生命值 ${newHealth}`;
        });
    }
    
    // 2. 處理 Money Change
    if (typeof money_change === 'number') {
        updatedBio = updatedBio.replace(moneyRegex, (match, currentMoneyStr) => {
            const currentMoney = parseInt(currentMoneyStr);
            const newMoney = Math.max(0, currentMoney + money_change);
            return `金錢 ${newMoney}`;
        });
    }

    // 3. 處理新的世界事件
    if (new_event_description && new_event_description.trim() !== "") {
        const timestamp = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
        const newEvents = [`[${timestamp}] ${new_event_description.trim()}`];
        
        // 4. 更新世界事件 (長期記憶)
        const currentEvents = session.worldContext.world_events.split('\n').filter(e => e.trim() !== '');
        const newEventsList = [...currentEvents, ...newEvents];
        session.worldContext.world_events = newEventsList.slice(-5).join('\n');
    }

    session.worldContext.player_bio = updatedBio;
}


// --- 主要 API 路由 ---
app.post('/api/simulate', async (req, res) => {
    const { apiKey, apiType, userId, worldContext, message } = req.body;
    
    console.log('\n--- 收到新的遊戲請求 ---');
    console.log(`API Type: ${apiType.toUpperCase()}`);
    console.log(`API Key Received (Length): ${apiKey ? apiKey.length : 0}`); 

    if (!apiKey || !apiType || !userId || !message || !worldContext) {
        return res.status(400).json({ error: '缺少必要的參數。' });
    }

    // 遊戲總時長：5 分鐘 (300 秒)
    const GAME_DURATION_SECONDS = 300; 
    let isTimeUp = false;

    if (!gameSessions[userId]) {
        gameSessions[userId] = { history: [], worldContext: worldContext, startTime: Date.now(), gameDurationSeconds: GAME_DURATION_SECONDS };
    } else if (message === 'INIT_CONTEXT') {
        // 確保初始狀態有金錢和生命值，以便後續解析
        gameSessions[userId].worldContext = worldContext;
        if (!gameSessions[userId].worldContext.player_bio.includes("金錢")) {
             gameSessions[userId].worldContext.player_bio += " 金錢 100";
        }
        if (!gameSessions[userId].worldContext.player_bio.includes("生命值")) {
             gameSessions[userId].worldContext.player_bio += " 生命值 100";
        }
        gameSessions[userId].history = [];
        // 設置時間
        gameSessions[userId].startTime = Date.now();
        gameSessions[userId].gameDurationSeconds = GAME_DURATION_SECONDS;
        
        // 返回一個 JSON 格式的成功回覆
        return res.json({ reply: { narrative: '世界建立完成。' }, updatedContext: gameSessions[userId].worldContext, isEnd: false });
    }
    
    const session = gameSessions[userId];
    
    // 檢查時間限制
    if (session.startTime) {
        const elapsedTimeMs = Date.now() - session.startTime;
        const elapsedTimeSec = Math.floor(elapsedTimeMs / 1000);
        
        if (elapsedTimeSec >= session.gameDurationSeconds) {
            isTimeUp = true;
        }
        // 更新剩餘時間到 Context 中，以便前端提取並顯示
        session.worldContext.time_remaining_sec = Math.max(0, session.gameDurationSeconds - elapsedTimeSec);
    }
    
    let fullPrompt = message; // 原始 prompt

    // 2. 設置系統指令 (結合長短期記憶)
    let systemInstructionText;
    let currentContents;

    // 總結模式
    if (isTimeUp) {
        // 覆寫 fullPrompt，要求 AI 總結人生
        fullPrompt = `時間已到 (遊戲總時長 ${GAME_DURATION_SECONDS} 秒已耗盡)。請根據玩家的長期記憶，總結其一生的旅程、成就和未完成的遺憾。最後，生成一個戲劇性的結局，並務必將 "game_over": true 和 "critical_message" 設置為結局總結。玩家的最後一個行動是：${message}`;
        
        const baseInstruction = `你是一位專業的異世界遊戲大師 (Game Master)。你的任務是總結玩家的整個遊戲歷程。`;
        
        systemInstructionText = `${baseInstruction}
            
            **世界狀態與玩家長期記憶 (World Context):**
            - 玩家背景與狀態: ${session.worldContext.player_bio}
            - 核心目標: ${session.worldContext.current_goal}
            - 重大世界事件: ${session.worldContext.world_events}
            
            **回應規則:**
            1. 你的回覆必須是**嚴格的 JSON 格式**。
            2. 'narrative' 字段應包含玩家一生的總結和結局描述。
            3. 務必設置 "game_over": true 和 "critical_message" 字段，總結玩家的最終命運。
            4. health_change 和 money_change 設置為 0。
            5. **禁止**在 narrative 以外的任何地方輸出非 JSON 格式的文本。`;

        currentContents = [...session.history, { role: "user", parts: [{ text: fullPrompt }] }];

    } else {
        // 正常遊戲模式
        const baseInstruction = `你是一位專業的異世界遊戲大師 (Game Master)。`;
        
        // JSON 嚴格修復: 強調 JSON 格式 and 建議下一步行動
        systemInstructionText = `${baseInstruction} 你的目標是根據玩家的行動，實時、動態地描繪一個高自由度的世界。
            
            **請始終確保你的整個回覆內容嚴格是一個單一的 JSON 對象。**
            
            **世界狀態與玩家長期記憶 (World Context):**
            - 玩家背景與狀態: ${session.worldContext.player_bio}
            - 核心目標: ${session.worldContext.current_goal}
            - 重大世界事件: ${session.worldContext.world_events || '目前世界平靜。'}
            
            **回應規則:**
            1. 你的回覆必須是**嚴格的 JSON 格式**，遵循提供的 JSON Schema。
            2. 在 'narrative' 字段中描述玩家行動的結果，並提出一個新的場景或問題，**並建議玩家下一步可行的行動選項 (至少 2 個)**。
            3. **[關鍵遊戲化反饋]**：如果玩家執行了致命行動 (例如：攻擊守衛、從高處墜落)，或生命值耗盡，務必設置 "game_over": true 並提供 "critical_message"。
            4. **[關鍵遊戲化反饋]**：如果玩家達成巨大財富變動 (例如：中彩券、巨額掠奪)，務必將其數額精確地填入 "money_change" 字段。
            5. **禁止**在 narrative 以外的任何地方輸出任何 JSON 標記符（如 \`\`\`json 或額外文本）。`;
        // ------------------------------------

        currentContents = [...session.history, { role: "user", parts: [{ text: fullPrompt }] }];
    }


    // 3. 構造 API Payload 
    let apiUrl;
    let headers;
    let apiPayload;
    let aiReply; 
    let parsedJson;

    const generationConfig = {
        responseMimeType: "application/json",
        responseSchema: GAME_RESPONSE_SCHEMA
    };

    if (apiType === 'gpt') {
        // [GPT API 配置]
        apiUrl = 'https://api.openai.com/v1/chat/completions';
        headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
        
        // FIX: 確保內容不是 null
        const gptMessages = currentContents.map(part => {
            const role = part.role === 'model' ? 'assistant' : 'user';
            const contentText = part.parts[0].text || "Empty message content."; 
            return { role: role, content: contentText };
        });

        gptMessages.unshift({ role: 'system', content: systemInstructionText });

        apiPayload = {
            model: 'gpt-3.5-turbo-1106', 
            messages: gptMessages,
            response_format: { type: "json_object" }, 
            temperature: 0.8
        };
        
        try {
            const result = await fetchWithRetry(apiUrl, apiPayload, headers);
            aiReply = result.choices[0].message.content.trim(); 
        } catch (error) {
            console.error('GPT API 呼叫失敗！', error.message);
            aiReply = JSON.stringify({
                narrative: `[系統錯誤] GPT 服務連線失敗。請檢查 API Key 或訂閱。`,
                achievement_unlocked: false,
                status_update: { health_change: 0, money_change: 0, new_event_description: "" },
                game_state_change: { game_over: true, critical_message: "時間已耗盡，但 GPT 連線失敗，無法生成結局。" }
            });
        }

    } else { // 'gemini'
        // [Gemini API 配置]
        apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
        headers = { 'Content-Type': 'application/json' };

        apiPayload = {
            contents: currentContents,
            systemInstruction: { parts: [{ text: systemInstructionText }] },
            generationConfig: generationConfig 
        };
        
        try {
            const result = await fetchWithRetry(apiUrl, apiPayload, headers);
            aiReply = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
        } catch (error) {
            console.error('Gemini API 呼叫失敗！', error.message);
            aiReply = JSON.stringify({
                narrative: `[系統錯誤] Gemini 服務連線失敗。請檢查 API Key 或訂閱。`,
                achievement_unlocked: false,
                status_update: { health_change: 0, money_change: 0, new_event_description: "" },
                game_state_change: { game_over: true, critical_message: "時間已耗盡，但 Gemini 連線失敗，無法生成結局。" }
            });
        }
    }
    
    // 4. *** 解析 JSON 字串 ***
    try {
        parsedJson = JSON.parse(aiReply);
    } catch (e) {
        console.error("==========================================");
        console.error("!!! JSON 解析失敗：AI 回覆格式不正確 !!!");
        console.error("錯誤:", e.message);
        console.error("原始 AI 回覆 (Raw AI Reply):", aiReply);
        console.error("==========================================");

        parsedJson = {
            narrative: `[AI 格式錯誤] 遊戲大師 (AI) 回覆了無效的格式，請再試一次。`,
            achievement_unlocked: false,
            status_update: { health_change: 0, money_change: 0, new_event_description: `JSON Parsing Error` },
            game_state_change: { game_over: false, critical_message: "" }
        };
    }

    // 5. 因果關係處理：更新長期記憶
    analyzeAndUpdateContext(userId, parsedJson, message);

    // 6. 更新歷史紀錄 (短期記憶)
    session.history.push({ role: "user", parts: [{ text: fullPrompt }] });
    session.history.push({ role: "model", parts: [{ text: parsedJson.narrative }] }); 
    
    if (session.history.length > 10) {
        session.history = session.history.slice(-10);
    }

    // 7. 回傳結果
    res.json({ reply: parsedJson, updatedContext: session.worldContext, isEnd: false });

});

// --- 啟動伺服器 ---
app.listen(PORT, () => {
    console.log(`後端伺服器已啟動，監聽 http://localhost:${PORT}`);
});