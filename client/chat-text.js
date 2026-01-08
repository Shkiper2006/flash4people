const state = {
  clientId: `client-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  messages: [],
  ws: null,
};

const selectors = {
  form: '#message-form',
  input: '#message-input',
  messages: '#messages',
};

function getDomElements() {
  const form = document.querySelector(selectors.form) || document.querySelector('form');
  const input = document.querySelector(selectors.input) || form?.querySelector('input');
  const messagesList = document.querySelector(selectors.messages);
  return { form, input, messagesList };
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function renderMessages() {
  const { messagesList } = getDomElements();
  if (!messagesList) return;
  messagesList.innerHTML = state.messages
    .map((message) => {
      const author = message.author || message.from || message.clientId || 'Аноним';
      const time = formatTime(message.ts || message.timestamp);
      const text = message.text || '';
      return `
        <li class="message">
          <div class="message-header">
            <span class="message-author">${author}</span>
            <span class="message-time">${time}</span>
          </div>
          <p class="message-text">${text}</p>
        </li>
      `;
    })
    .join('');
}

function addMessage(message) {
  state.messages.push(message);
  renderMessages();
}

function sendPayload(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
    return Promise.resolve();
  }

  return fetch('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch((error) => {
    console.error('Failed to send message via HTTP', error);
  });
}

function sendMessage(text) {
  const payload = {
    type: 'text',
    text,
    clientId: state.clientId,
    ts: Date.now(),
  };
  addMessage({ ...payload, author: 'Вы' });
  sendPayload(payload);
}

function handleFormSubmit(event) {
  event.preventDefault();
  const { input } = getDomElements();
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  sendMessage(text);
  input.value = '';
}

function handleIncomingPayload(payload) {
  if (!payload) return;
  if (payload.type === 'message' && payload.message) {
    addMessage(payload.message);
    return;
  }
  if (payload.type === 'text' || payload.text) {
    addMessage(payload);
  }
}

function connectWebSocket() {
  if (!('WebSocket' in window)) return;
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${protocol}://${window.location.host}/ws`;
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.addEventListener('message', (event) => {
    try {
      const payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      handleIncomingPayload(payload);
    } catch (error) {
      console.error('Failed to parse incoming message', error);
    }
  });
}

function bindEvents() {
  const { form } = getDomElements();
  if (form) {
    form.addEventListener('submit', handleFormSubmit);
  }
}

function init() {
  bindEvents();
  connectWebSocket();
}

init();
