const state = {
  clientId: `client-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  messages: [],
  ws: null,
};

const selectors = {
  form: '#message-form',
  input: '#message-input',
  fileInput: '#file-input',
  attachButton: '#attach-button',
  emojiButton: '#emoji-button',
  emojiPanel: '#emoji-panel',
  messages: '#messages',
};

const emojiList = [
  '🙂',
  '😀',
  '😁',
  '😂',
  '🤣',
  '😉',
  '😊',
  '😍',
  '😘',
  '😎',
  '😇',
  '🤗',
  '🤔',
  '🤩',
  '😜',
  '😢',
  '😭',
  '😡',
  '👍',
  '🙏',
  '👏',
  '💪',
  '🎉',
  '🔥',
  '❤️',
];

function getDomElements() {
  const form = document.querySelector(selectors.form) || document.querySelector('form');
  const input =
    document.querySelector(selectors.input) ||
    form?.querySelector('input') ||
    form?.querySelector('textarea');
  const fileInput = document.querySelector(selectors.fileInput);
  const attachButton = document.querySelector(selectors.attachButton);
  const emojiButton = document.querySelector(selectors.emojiButton);
  const emojiPanel = document.querySelector(selectors.emojiPanel);
  const messagesList = document.querySelector(selectors.messages);
  return { form, input, fileInput, attachButton, emojiButton, emojiPanel, messagesList };
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
      const file = message.file;
      const isImage = file?.mime?.startsWith('image/');
      const fileMarkup = file
        ? `
          <div class="message-file">
            <a href="${file.url}" target="_blank" rel="noopener">
              ${isImage ? `<img src="${file.url}" alt="${file.name}" />` : file.name}
            </a>
            ${file.size ? `<span class="message-file-size">${formatFileSize(file.size)}</span>` : ''}
          </div>
        `
        : '';
      return `
        <li class="message">
          <div class="message-header">
            <span class="message-author">${author}</span>
            <span class="message-time">${time}</span>
          </div>
          <p class="message-text">${text}</p>
          ${fileMarkup}
        </li>
      `;
    })
    .join('');
}

function addMessage(message) {
  state.messages.push(message);
  renderMessages();
}

function formatFileSize(size) {
  if (!size && size !== 0) return '';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
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

function createFallbackUrl(file) {
  try {
    return URL.createObjectURL(file);
  } catch (error) {
    console.warn('Failed to create preview URL', error);
    return '#';
  }
}

async function uploadFile(file) {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch('/upload', {
    method: 'POST',
    body: form,
  });
  if (!response.ok) {
    throw new Error('Upload failed');
  }
  const data = await response.json().catch(() => null);
  return {
    url: data?.url || data?.path || data?.href || createFallbackUrl(file),
    name: data?.name || file.name,
    size: data?.size || file.size,
    mime: data?.mime || file.type,
  };
}

async function handleFiles(files) {
  if (!files || files.length === 0) return;
  const queue = Array.from(files);
  for (const file of queue) {
    try {
      const uploaded = await uploadFile(file);
      addMessage({
        type: 'file',
        clientId: state.clientId,
        author: 'Вы',
        ts: Date.now(),
        text: `Файл: ${uploaded.name}`,
        file: uploaded,
      });
    } catch (error) {
      console.error('Upload error', error);
    }
  }
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

function handleFileInputChange(event) {
  const { files } = event.target;
  handleFiles(files);
  event.target.value = '';
}

function handleDrop(event) {
  event.preventDefault();
  if (event.dataTransfer?.files?.length) {
    handleFiles(event.dataTransfer.files);
  }
}

function handleDragOver(event) {
  event.preventDefault();
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

function ensureFileControls(form) {
  if (!form || document.querySelector(selectors.fileInput)) return;
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.id = selectors.fileInput.replace('#', '');
  fileInput.style.display = 'none';

  const attachButton = document.createElement('button');
  attachButton.type = 'button';
  attachButton.id = selectors.attachButton.replace('#', '');
  attachButton.textContent = '📎';
  attachButton.title = 'Прикрепить файл';
  attachButton.className = 'attach-button';
  attachButton.addEventListener('click', () => fileInput.click());

  form.appendChild(fileInput);
  form.appendChild(attachButton);
}

function insertEmoji(emoji) {
  const { input } = getDomElements();
  const activeElement = document.activeElement;
  const target =
    activeElement && activeElement.matches?.('input, textarea') ? activeElement : input;
  if (!target) return;
  const value = target.value ?? '';
  const start = Number.isInteger(target.selectionStart) ? target.selectionStart : value.length;
  const end = Number.isInteger(target.selectionEnd) ? target.selectionEnd : value.length;
  const nextValue = `${value.slice(0, start)}${emoji}${value.slice(end)}`;
  target.value = nextValue;
  const cursor = start + emoji.length;
  if (target.setSelectionRange) {
    target.setSelectionRange(cursor, cursor);
  }
  target.focus();
}

function ensureEmojiControls(form) {
  if (!form || document.querySelector(selectors.emojiButton)) return;
  const emojiButton = document.createElement('button');
  emojiButton.type = 'button';
  emojiButton.id = selectors.emojiButton.replace('#', '');
  emojiButton.textContent = '🙂';
  emojiButton.title = 'Эмодзи';
  emojiButton.className = 'emoji-button';

  const emojiPanel = document.createElement('div');
  emojiPanel.id = selectors.emojiPanel.replace('#', '');
  emojiPanel.className = 'emoji-panel';
  emojiPanel.hidden = true;
  emojiPanel.setAttribute('role', 'menu');

  const emojiListContainer = document.createElement('div');
  emojiListContainer.className = 'emoji-list';
  emojiList.forEach((emoji) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'emoji-item';
    button.textContent = emoji;
    button.addEventListener('click', () => insertEmoji(emoji));
    emojiListContainer.appendChild(button);
  });

  emojiPanel.appendChild(emojiListContainer);

  emojiButton.addEventListener('click', () => {
    emojiPanel.hidden = !emojiPanel.hidden;
  });

  form.appendChild(emojiButton);
  form.appendChild(emojiPanel);
}

function bindEvents() {
  const { form } = getDomElements();
  if (form) {
    ensureFileControls(form);
    ensureEmojiControls(form);
    form.addEventListener('submit', handleFormSubmit);
    form.addEventListener('drop', handleDrop);
    form.addEventListener('dragover', handleDragOver);
  }
  const updated = getDomElements();
  if (updated.fileInput) {
    updated.fileInput.addEventListener('change', handleFileInputChange);
  }
}

function init() {
  bindEvents();
  connectWebSocket();
}

init();
