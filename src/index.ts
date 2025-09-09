import { Server } from "socket.io";
import http from "http";
import crypto from "crypto";
import { initDatabase, saveMessage, getRecentMessages, updateMessageReactions, cleanupOldMessages } from "./database.js";

const server = http.createServer((req, res) => {
  // CORS заголовки
  const allow = process.env.ALLOW_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Health check endpoint
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  
  // 404 для остальных запросов
  res.writeHead(404);
  res.end("Not Found");
});

const io = new Server(server, {
  cors: {
    origin: (process.env.ALLOW_ORIGIN || "*").split(",").map(s => s.trim())
  }
});

type Msg = { 
  id: string; 
  text: string; 
  nick: string; 
  ts: number; 
  reactions?: { [emoji: string]: number };
  userColor?: string;
  userStatus?: string;
};

// Инициализируем базу данных при запуске
initDatabase().catch(console.error);

// Очищаем старые сообщения каждые 24 часа
setInterval(cleanupOldMessages, 24 * 60 * 60 * 1000);

io.on("connection", async socket => {
  console.log("Client connected");
  
  // Загружаем последние сообщения из базы данных
  try {
    const recentMessages = await getRecentMessages(30);
    socket.emit("recent", recentMessages);
  } catch (error) {
    console.error("Error loading recent messages:", error);
    socket.emit("recent", []);
  }

  socket.on("msg", async (payload: { text?: string; nick?: string; userColor?: string; userStatus?: string }) => {
    const text = String(payload?.text || "").slice(0, 500).trim();
    if (!text) return;
    const nick = String(payload?.nick || "Аноним").slice(0, 24);
    const userColor = payload?.userColor;
    const userStatus = payload?.userStatus;
    const msg: Msg = { 
      id: crypto.randomUUID(), 
      text, 
      nick, 
      ts: Date.now(),
      userColor,
      userStatus
    };
    
    // Сохраняем в базу данных
    try {
      await saveMessage(msg);
      io.emit("msg", msg);
    } catch (error) {
      console.error("Error saving message:", error);
    }
  });

  socket.on("react", async (payload: { msgId: string; emoji: string }) => {
    const { msgId, emoji } = payload;
    
    try {
      // Получаем сообщение из базы данных
      const recentMessages = await getRecentMessages(1000); // Получаем больше сообщений для поиска
      const msg = recentMessages.find(m => m.id === msgId);
      if (!msg) return;

      if (!msg.reactions) msg.reactions = {};
      msg.reactions[emoji] = (msg.reactions[emoji] || 0) + 1;

      // Ограничим реакции до 99
      if (msg.reactions[emoji] > 99) msg.reactions[emoji] = 99;

      // Сохраняем обновленные реакции в базу данных
      await updateMessageReactions(msgId, msg.reactions);

      io.emit("reaction", { msgId, emoji, count: msg.reactions[emoji] });
    } catch (error) {
      console.error("Error updating reaction:", error);
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected");
  });
});

const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, "0.0.0.0", () => {
  console.log("chat up on", PORT);
});
