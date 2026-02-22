const form        = document.getElementById('chatForm');
const msgInput    = document.getElementById('msg');
const messagesEl  = document.getElementById('messages');
const typingEl    = document.getElementById('typingIndicator');
const sendBtn     = document.getElementById('sendBtn');
const suggestions = document.getElementById('suggestions');

let isLoading = false;

// Conversation memory: array of { role: 'user'|'assistant', content: string }
const conversationHistory = [];

// ── Helpers ────────────────────────────────────────────────────────────────

function now() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendMessage(text, role) {
  const row = document.createElement('div');
  row.className = `msg-row ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = role === 'bot' ? '🦷' : '🙂';

  const col = document.createElement('div');

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (role === 'bot') {
    bubble.classList.add('bot-bubble');
    bubble.innerHTML = marked.parse(text);
  } else {
    bubble.textContent = text;
  }

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = now();

  col.appendChild(bubble);
  col.appendChild(time);
  row.appendChild(avatar);
  row.appendChild(col);

  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Creates an empty bot bubble for streaming into, returns the bubble element
function createStreamingBotBubble() {
  const row = document.createElement('div');
  row.className = 'msg-row bot';

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = '🦷';

  const col = document.createElement('div');

  const bubble = document.createElement('div');
  bubble.className = 'bubble bot-bubble';

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = now();

  col.appendChild(bubble);
  col.appendChild(time);
  row.appendChild(avatar);
  row.appendChild(col);

  messagesEl.appendChild(row);
  return bubble;
}

function setLoading(on) {
  isLoading = on;
  sendBtn.disabled = on;
  typingEl.classList.toggle('visible', on);
  if (on) messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── Welcome message ─────────────────────────────────────────────────────────

window.addEventListener('load', () => {
  appendMessage(
    "Hi! 👋 I'm the MPS Dental assistant. Ask me anything about our services, hours, location, or how to book an appointment.",
    'bot'
  );
});

// ── Send logic ───────────────────────────────────────────────────────────────

async function sendMessage(text) {
  if (!text || isLoading) return;

  appendMessage(text, 'user');
  msgInput.value = '';
  setLoading(true);

  // Snapshot history before adding the current message (server appends it itself)
  const historyToSend = [...conversationHistory];

  // Add user turn to memory now
  conversationHistory.push({ role: 'user', content: text });

  // Create the bot bubble we'll stream into
  const botBubble = createStreamingBotBubble();
  let fullText = '';
  let firstToken = false;

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history: historyToSend }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete trailing line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;

        try {
          const event = JSON.parse(raw);

          if (event.text) {
            // Hide typing indicator on first real token
            if (!firstToken) {
              setLoading(false);
              firstToken = true;
            }
            fullText += event.text;
            botBubble.innerHTML = marked.parse(fullText);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          } else if (event.error) {
            console.error('Bot error:', event.error);
            botBubble.textContent = `Sorry, something went wrong: ${event.error}`;
          }
        } catch (e) {
          console.error('SSE parse error:', e, 'raw line:', raw);
        }
      }
    }

    // Save completed assistant reply to memory
    if (fullText) {
      conversationHistory.push({ role: 'assistant', content: fullText });
    } else {
      // Stream ended with no text — likely a server/API issue
      botBubble.textContent = 'No response received. Please restart the server and try again.';
    }
  } catch (err) {
    console.error('Fetch error:', err);
    botBubble.textContent = 'Could not reach the server. Please try again.';
  } finally {
    setLoading(false);
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage(msgInput.value.trim());
});

suggestions.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  sendMessage(chip.dataset.q);
});
