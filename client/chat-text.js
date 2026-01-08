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
  const input = document.querySelector(selectors.input) || form?.querySelector('input');
  const input =
    document.querySelector(selectors.input) ||
    form?.querySelector('input') ||
    form?.querySelector('textarea');
  const fileInput = document.querySelector(selectors.fileInput);
  const attachButton = document.querySelector(selectors.attachButton);
  const emojiButton = document.querySelector(selectors.emojiButton);
  const emojiPanel = document.querySelector(selectors.emojiPanel);
  const messagesList = document.querySelector(selectors.messages);
  return { form, input, messagesList };
  return { form, input, fileInput, attachButton, messagesList };
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
@@ -207,46 +241,100 @@ function connectWebSocket() {
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
  const { form, fileInput } = getDomElements();
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
