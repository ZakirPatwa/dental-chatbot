import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

// Load clinic website content
let clinicData = "";
try {
  clinicData = fs.readFileSync(path.join(__dirname, "clinicData.txt"), "utf-8");
} catch (err) {
  console.warn("⚠️  clinicData.txt not found. Using fallback content.");
  clinicData = "No clinic information available. Please add clinicData.txt to the project root.";
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are a helpful assistant for a dental clinic. Answer clinic-related questions using the clinic information provided below. You may also use any personal information the user has shared during this conversation (such as their name). For clinic-related questions not covered by the information below, say: "I'm not sure based on the website."

CLINIC INFORMATION:
${clinicData}`;

app.get("/health", (req, res) => {
  res.json({ ok: true, model: MODEL });
});

app.post("/chat", async (req, res) => {
  const userMessage = (req.body?.message || "").toString().trim();
  // history = array of { role: "user"|"assistant", content: string } for prior turns
  const history = Array.isArray(req.body?.history) ? req.body.history : [];

  if (!userMessage) return res.status(400).json({ error: "Empty message" });

  try {
    fs.appendFileSync(
      path.join(__dirname, "chat_requests.log"),
      `[${new Date().toISOString()}] message=${JSON.stringify(userMessage)}\n`
    );
  } catch (e) {}

  // Always respond via SSE so the client code is uniform
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  function sseWrite(obj) {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }

  if (!ANTHROPIC_API_KEY) {
    sseWrite({ text: "No Anthropic API key configured. Add ANTHROPIC_API_KEY to .env." });
    sseWrite({ done: true });
    return res.end();
  }

  // Full conversation: prior history + current user message
  const messages = [...history, { role: "user", content: userMessage }];

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        system: SYSTEM_PROMPT,
        messages,
        max_tokens: 1024,
        stream: true,
      }),
    });

    if (!upstream.ok) {
      const body = await upstream.text();
      try {
        fs.appendFileSync(
          path.join(__dirname, "anthropic_error.log"),
          `[${new Date().toISOString()}] status=${upstream.status} body=${body}\n`
        );
      } catch (e) {}
      sseWrite({ error: `API error ${upstream.status}: ${body}` });
      sseWrite({ done: true });
      return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep any incomplete trailing line

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;

        try {
          const event = JSON.parse(raw);
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            sseWrite({ text: event.delta.text });
          } else if (event.type === "message_stop") {
            sseWrite({ done: true });
          } else if (event.type === "error") {
            // Anthropic stream-level error (e.g. overloaded, content filter)
            const msg = event.error?.message || JSON.stringify(event.error) || "Stream error";
            console.error("Anthropic stream error:", msg);
            sseWrite({ error: msg });
            sseWrite({ done: true });
          }
        } catch (e) {
          console.error("SSE parse error:", e, "line:", line);
        }
      }
    }

    res.end();
  } catch (err) {
    try {
      fs.appendFileSync(
        path.join(__dirname, "anthropic_error.log"),
        `[${new Date().toISOString()}] exception=${err}\n`
      );
    } catch (e) {}
    sseWrite({ error: err.message });
    sseWrite({ done: true });
    res.end();
  }
});

app.listen(3000, () => {
  console.log(`✅ Server running at http://localhost:3000 (model: ${MODEL})`);
});
