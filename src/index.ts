import { Server } from "socket.io";
import http from "http";
import crypto from "crypto";
import { URL } from "url";
import { initDatabase, saveMessage, getRecentMessages, updateMessageReactions, cleanupOldMessages, deleteMessage, getBlockedIPs, addBlockedIP, removeBlockedIP } from "./database.js";

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
  
  // Админ API endpoints
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  
  // Проверка аутентификации для админ роутов
  if (url.pathname.startsWith('/admin/')) {
    if (!checkAdminAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }
  
  // Админ логин
  if (url.pathname === "/admin/login" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, message: "Authenticated" }));
    return;
  }
  
  // Получить все сообщения для админки
  if (url.pathname === "/admin/messages" && req.method === "GET") {
    try {
      const messages = await getRecentMessages(1000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(messages));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to get messages" }));
    }
    return;
  }
  
  // Удалить сообщение
  if (url.pathname === "/admin/messages/delete" && req.method === "POST") {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { messageId } = JSON.parse(body);
        await deleteMessage(messageId);
        
        // Уведомляем всех клиентов об удалении
        io.emit("messageDeleted", { messageId });
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to delete message" }));
      }
    });
    return;
  }
  
  // Получить заблокированные IP
  if (url.pathname === "/admin/blocked-ips" && req.method === "GET") {
    try {
      const blockedIPs = await getBlockedIPs();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(blockedIPs));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to get blocked IPs" }));
    }
    return;
  }
  
  // Заблокировать IP
  if (url.pathname === "/admin/block-ip" && req.method === "POST") {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { ip, reason } = JSON.parse(body);
        await addBlockedIP(ip, reason || "Blocked by admin");
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to block IP" }));
      }
    });
    return;
  }
  
  // Разблокировать IP
  if (url.pathname === "/admin/unblock-ip" && req.method === "POST") {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { ip } = JSON.parse(body);
        await removeBlockedIP(ip);
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to unblock IP" }));
      }
    });
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

// Админ учетные данные
const ADMIN_EMAIL = "ruslansereduk@gmail.com";
const ADMIN_PASSWORD = "EnekValli123!";

// Простая функция аутентификации
function checkAdminAuth(req: http.IncomingMessage): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return false;
  }
  
  const base64Credentials = authHeader.slice('Basic '.length);
  const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
  const [email, password] = credentials.split(':');
  
  return email === ADMIN_EMAIL && password === ADMIN_PASSWORD;
}

// Получение IP адреса клиента
function getClientIP(req: http.IncomingMessage): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress || 
         'unknown';
}

// Инициализируем базу данных при запуске
initDatabase().catch(console.error);

// Очищаем старые сообщения каждые 24 часа
setInterval(cleanupOldMessages, 24 * 60 * 60 * 1000);

io.on("connection", async socket => {
  const clientIP = getClientIP(socket.request);
  console.log("Client connected from:", clientIP);
  
  // Проверяем, заблокирован ли IP
  try {
    const blockedIPs = await getBlockedIPs();
    if (blockedIPs.some(blocked => blocked.ip === clientIP)) {
      console.log("Blocked IP attempted to connect:", clientIP);
      socket.emit("blocked", { message: "Your IP is blocked" });
      socket.disconnect(true);
      return;
    }
  } catch (error) {
    console.error("Error checking blocked IPs:", error);
  }
  
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
