const appRoot = document.getElementById('app');

const state = {
  authMode: 'login',
  isAuthed: false,
  user: null,
  rooms: [],
  users: [],
  currentRoom: null,
  messages: {},
  invitations: [],
  ws: null,
  wsStatus: 'disconnected',
  error: null,
  pendingFiles: [],
  emojiOpen: false,
  hasAuthAttempted: false,
  authToken: null,
  voice: {
    status: 'disconnected',
    joined: false,
    muted: false,
    isSharingScreen: false,
    devices: [],
    activeDeviceId: '',
    micLevel: 0,
    peers: 0,
  },
};

const INVITE_TTL_MS = 5 * 60 * 1000;
const INVITE_SWEEP_MS = 15 * 1000;
const EMOJI_LIST = [
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

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function getRoomLabel(room) {
  return room?.title || room?.name || room?.id || 'Без названия';
}

function getUserLabel(user) {
  return user?.nickname || user?.name || user?.id || 'Пользователь';
}

function setError(message) {
  state.error = message;
  render();
}

function clearError() {
  state.error = null;
}

function sendWs(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    setError('WebSocket не подключён. Попробуйте ещё раз.');
    return;
  }
  state.ws.send(JSON.stringify(payload));
}

function connectWebSocket(authPayload) {
  if (state.ws) {
    state.ws.close();
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const tokenParam = authPayload?.token ? `?token=${encodeURIComponent(authPayload.token)}` : '';
  const wsUrl = `${protocol}://${window.location.host}/ws${tokenParam}`;
  const ws = new WebSocket(wsUrl);
  state.ws = ws;
  state.wsStatus = 'connecting';

  ws.addEventListener('open', () => {
    state.wsStatus = 'connected';
    clearError();
    if (authPayload && authPayload.mode) {
      sendWs({ type: 'auth', ...authPayload });
    }
    render();
  });

  ws.addEventListener('close', () => {
    state.wsStatus = 'disconnected';
    render();
  });

  ws.addEventListener('error', () => {
    if (state.hasAuthAttempted) {
      setError('Ошибка подключения WebSocket.');
    }
  });

  ws.addEventListener('message', (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleWsMessage(payload);
    } catch (err) {
      console.error('WS parse error', err);
    }
  });
}

let voiceChat;
let micLevelRaf = null;
let latestMicLevel = 0;

function queueMicLevelUpdate(level) {
  latestMicLevel = level;
  if (micLevelRaf) return;
  micLevelRaf = requestAnimationFrame(() => {
    micLevelRaf = null;
    state.voice.micLevel = latestMicLevel;
    const indicator = document.getElementById('mic-level');
    if (indicator) {
      indicator.style.setProperty('--level', state.voice.micLevel.toFixed(2));
    }
  });
}

function attachRemoteStream(peerId, stream) {
  const container = document.getElementById('voice-remote');
  if (!container) return;
  let audio = container.querySelector(`[data-peer=\"${peerId}\"]`);
  if (!audio) {
    audio = document.createElement('audio');
    audio.autoplay = true;
    audio.dataset.peer = peerId;
    container.appendChild(audio);
  }
  audio.srcObject = stream;
}

function removeRemoteStream(peerId) {
  const container = document.getElementById('voice-remote');
  if (!container) return;
  if (!peerId) {
    container.innerHTML = '';
    return;
  }
  const audio = container.querySelector(`[data-peer=\"${peerId}\"]`);
  if (audio) {
    audio.remove();
  }
}

function initVoiceChat() {
  if (voiceChat) return;
  voiceChat = new VoiceChat({
    onStatusChange: (status) => {
      state.voice.status = status;
      render();
    },
    onPeersChange: (count) => {
      state.voice.peers = count;
      render();
    },
    onMicLevel: (level) => {
      queueMicLevelUpdate(level);
    },
    onRemoteStream: (peerId, stream) => {
      attachRemoteStream(peerId, stream);
    },
    onRemoteStreamRemoved: (peerId) => {
      removeRemoteStream(peerId);
    },
  });
}

async function refreshVoiceDevices() {
  if (!voiceChat) return;
  try {
    const devices = await voiceChat.listInputDevices();
    state.voice.devices = devices;
    if (!state.voice.activeDeviceId && devices.length > 0) {
      state.voice.activeDeviceId = devices[0].deviceId;
    }
  } catch (error) {
    console.error('Device list error', error);
  }
}

function handleWsMessage(payload) {
  switch (payload.type) {
    case 'auth_ok':
      state.isAuthed = true;
      state.user = payload.user || state.user;
      state.rooms = payload.rooms || [];
      state.users = payload.users || [];
      state.currentRoom = payload.currentRoom || null;
      state.messages = {};
      state.pendingFiles = [];
      state.emojiOpen = false;
      state.hasAuthAttempted = false;
      clearError();
      break;
    case 'rooms_update':
      state.rooms = payload.rooms || [];
      if (state.currentRoom) {
        const updated = state.rooms.find((room) => room.id === state.currentRoom.id);
        if (updated) {
          state.currentRoom = updated;
        }
      }
      break;
    case 'users_update':
      state.users = payload.users || [];
      break;
    case 'invitation':
      addInvitation(payload.invitation);
      break;
    case 'invitation_expired':
      removeInvitation(payload.invitationId);
      break;
    case 'invitation_response':
      removeInvitation(payload.invite?.id || payload.invite?.invitationId);
      break;
    case 'message':
      appendMessage(payload.roomId, payload.message);
      break;
    case 'room_joined':
      state.currentRoom = payload.room || state.rooms.find((room) => room.id === payload.roomId) || null;
      if (payload.roomId && Array.isArray(payload.messages)) {
        state.messages[payload.roomId] = payload.messages;
      }
      break;
    case 'status_update':
      updateUserStatus(payload.userId, payload.status);
      break;
    case 'error':
      setError(payload.message || 'Неизвестная ошибка.');
      break;
    default:
      console.warn('Unknown WS payload', payload);
  }
  render();
}

function appendMessage(roomId, message) {
  if (!roomId || !message) return;
  if (!state.messages[roomId]) {
    state.messages[roomId] = [];
  }
  state.messages[roomId].push({
    ...message,
    timestamp: message.timestamp || Date.now(),
  });
}

function updateUserStatus(userId, status) {
  state.users = state.users.map((user) =>
    user.id === userId ? { ...user, status } : user
  );
}

function addInvitation(invitation) {
  if (!invitation) return;
  const expiresAt = invitation.expiresAt ? new Date(invitation.expiresAt).getTime() : Date.now() + INVITE_TTL_MS;
  const normalized = {
    id: invitation.id || `${invitation.roomId}-${invitation.fromId || Date.now()}`,
    roomId: invitation.roomId,
    roomTitle: invitation.roomTitle || invitation.roomName,
    from: invitation.from,
    expiresAt,
  };
  state.invitations = [normalized, ...state.invitations].slice(0, 6);
}

function removeInvitation(invitationId) {
  state.invitations = state.invitations.filter((invite) => invite.id !== invitationId);
}

function sweepInvitations() {
  const now = Date.now();
  const expired = state.invitations.filter((invite) => invite.expiresAt <= now);
  if (expired.length === 0) return;
  state.invitations = state.invitations.filter((invite) => invite.expiresAt > now);
  expired.forEach((invite) => {
    sendWs({ type: 'invitation_response', invitationId: invite.id, action: 'expired' });
  });
  render();
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const nickname = data.get('nickname')?.toString().trim();
  const password = data.get('password')?.toString();
  if (!nickname || !password) {
    setError('Введите логин и пароль.');
    return;
  }
  clearError();
  state.hasAuthAttempted = true;
  state.user = { nickname };
  const authPayload = { mode: state.authMode, nickname, password };
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    connectWebSocket(authPayload);
  } else {
    sendWs({ type: 'auth', ...authPayload });
  }
  render();
}

async function handleRoomSelect(room) {
  if (state.voice.joined && state.currentRoom?.id !== room?.id) {
    await handleVoiceLeave();
  }
  state.currentRoom = room;
  if (room?.id) {
    sendWs({ type: 'join_room', roomId: room.id });
  }
  render();
}

async function handleVoiceJoin() {
  initVoiceChat();
  if (!state.currentRoom?.id) {
    setError('Сначала выберите комнату для голосового чата.');
    return;
  }
  try {
    await voiceChat.join(state.currentRoom.id, state.voice.activeDeviceId);
    state.voice.joined = true;
    state.voice.muted = false;
    await refreshVoiceDevices();
    render();
  } catch (error) {
    console.error(error);
    setError('Не удалось подключиться к голосовому чату.');
  }
}

async function handleVoiceLeave() {
  if (!voiceChat || !state.voice.joined) return;
  await voiceChat.leave();
  state.voice.joined = false;
  state.voice.muted = false;
  state.voice.isSharingScreen = false;
  state.voice.peers = 0;
  render();
}

async function handleVoiceToggle() {
  if (!voiceChat || !state.voice.joined) return;
  const muted = await voiceChat.toggleMute();
  state.voice.muted = muted;
  render();
}

async function handleVoiceDeviceChange(deviceId) {
  if (!deviceId) return;
  state.voice.activeDeviceId = deviceId;
  if (voiceChat && state.voice.joined) {
    try {
      await voiceChat.setInputDevice(deviceId);
    } catch (error) {
      console.error(error);
    }
  }
}

async function handleScreenShareToggle() {
  if (!voiceChat || !state.voice.joined) return;
  if (state.voice.isSharingScreen) {
    voiceChat.stopScreenShare();
    state.voice.isSharingScreen = false;
  } else {
    try {
      await voiceChat.startScreenShare();
      state.voice.isSharingScreen = true;
    } catch (error) {
      console.error(error);
      setError('Не удалось запустить демонстрацию экрана.');
    }
  }
  render();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function handleFileInputChange(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  try {
    const entries = await Promise.all(
      files.map(async (file) => ({
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        dataUrl: await readFileAsDataUrl(file),
      }))
    );
    state.pendingFiles = [...state.pendingFiles, ...entries];
    render();
  } catch (error) {
    console.error(error);
    setError('Не удалось прочитать файл.');
  }
}

function handleRemovePendingFile(index) {
  state.pendingFiles = state.pendingFiles.filter((_, idx) => idx !== index);
  render();
}

async function uploadFile(file) {
  const response = await fetch('/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: file.name,
      type: file.type,
      data: file.dataUrl,
    }),
  });
  if (!response.ok) {
    throw new Error('Upload failed');
  }
  return response.json();
}

async function handleSendMessage(event) {
  event.preventDefault();
  const input = event.target.querySelector('input');
  if (!input) return;
  const text = input.value.trim();
  if (!state.currentRoom?.id) return;
  if (!text && state.pendingFiles.length === 0) return;

  if (text) {
    sendWs({
      type: 'message',
      roomId: state.currentRoom.id,
      message: { type: 'text', text },
    });
  }

  if (state.pendingFiles.length > 0) {
    try {
      const uploaded = await Promise.all(state.pendingFiles.map(uploadFile));
      uploaded.forEach((fileResponse, index) => {
        const original = state.pendingFiles[index];
        sendWs({
          type: 'message',
          roomId: state.currentRoom.id,
          message: {
            type: 'file',
            file: {
              id: fileResponse.id,
              url: fileResponse.url,
              name: original.name,
              mime: original.type,
              size: original.size,
            },
          },
        });
      });
    } catch (error) {
      console.error(error);
      setError('Не удалось отправить файлы.');
    }
  }

  input.value = '';
  state.pendingFiles = [];
  render();
}

function handleInvitationAction(invitationId, action) {
  sendWs({
    type: 'invitation_response',
    invitationId,
    action,
  });
  removeInvitation(invitationId);
  render();
}

function handleEmojiToggle() {
  state.emojiOpen = !state.emojiOpen;
  render();
}

function handleEmojiPick(emoji) {
  const input = document.getElementById('message-input');
  if (!input) return;
  const value = input.value || '';
  const start = input.selectionStart ?? value.length;
  const end = input.selectionEnd ?? value.length;
  input.value = `${value.slice(0, start)}${emoji}${value.slice(end)}`;
  const cursor = start + emoji.length;
  if (input.setSelectionRange) {
    input.setSelectionRange(cursor, cursor);
  }
  input.focus();
}

function handleInviteUser(userId) {
  if (!state.currentRoom?.id) return;
  sendWs({ type: 'invite', roomId: state.currentRoom.id, toUserId: userId });
}

function renderAuth() {
  return `
    <section class="auth-card">
      <div class="auth-header">
        <h1>Flash4People</h1>
        <p>Войдите или зарегистрируйтесь, чтобы продолжить.</p>
      </div>
      ${state.error ? `<div class="error">${state.error}</div>` : ''}
      <div class="auth-tabs">
        <button class="tab ${state.authMode === 'login' ? 'active' : ''}" data-mode="login">Вход</button>
        <button class="tab ${state.authMode === 'register' ? 'active' : ''}" data-mode="register">Регистрация</button>
      </div>
      <form class="auth-form" id="auth-form">
        <label>
          Никнейм
          <input name="nickname" type="text" autocomplete="username" required />
        </label>
        <label>
          Пароль
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <button type="submit" class="primary">${state.authMode === 'login' ? 'Войти' : 'Создать аккаунт'}</button>
      </form>
      <div class="auth-footer">
        <span>${state.authMode === 'login' ? 'Нет аккаунта?' : 'Уже есть аккаунт?'}</span>
        <button class="link" data-toggle>${state.authMode === 'login' ? 'Регистрация' : 'Войти'}</button>
      </div>
    </section>
  `;
}

function renderInvitations() {
  if (state.invitations.length === 0) return '';
  const items = state.invitations
    .map((invite) => {
      const expiresIn = Math.max(0, invite.expiresAt - Date.now());
      const minutes = Math.floor(expiresIn / 60000);
      const seconds = Math.floor((expiresIn % 60000) / 1000);
      const timer = `${minutes}:${seconds.toString().padStart(2, '0')}`;
      return `
        <li>
          <div>
            <strong>Приглашение в ${invite.roomTitle || 'комнату'}</strong>
            <span>от ${invite.from || 'пользователя'}</span>
          </div>
          <div class="invite-meta">
            <span class="timer">Истекает через ${timer}</span>
            <div class="invite-actions">
              <button class="secondary" data-action="accept" data-id="${invite.id}">Принять</button>
              <button class="ghost" data-action="reject" data-id="${invite.id}">Отклонить</button>
            </div>
          </div>
        </li>
      `;
    })
    .join('');
  return `
    <section class="invitations">
      <h3>Приглашения</h3>
      <ul>${items}</ul>
    </section>
  `;
}

function renderRoomsList() {
  if (!state.rooms.length) {
    return '<p class="muted">Нет доступных комнат. Ожидайте приглашение.</p>';
  }
  return state.rooms
    .map((room) => {
      const active = state.currentRoom?.id === room.id;
      return `
        <button class="room ${active ? 'active' : ''}" data-room="${room.id}">
          <span>${getRoomLabel(room)}</span>
          <span class="room-meta">${room.membersCount ?? 0} участников</span>
        </button>
      `;
    })
    .join('');
}

function renderRoomCreate() {
  return `
    <form class="room-create" id="room-create-form">
      <input type="text" name="room" placeholder="Новая комната" required />
      <button class="primary" type="submit">Создать</button>
    </form>
  `;
}

function renderUsersList() {
  if (!state.users.length) {
    return '<p class="muted">Нет пользователей.</p>';
  }
  const canInvite = state.currentRoom?.ownerId === state.user?.id;
  const currentMembers = state.currentRoom?.members || [];
  return state.users
    .map((user) => {
      const status = user.status === 'online' ? 'online' : 'offline';
      const canInviteUser =
        canInvite &&
        user.id !== state.user?.id &&
        status === 'online' &&
        !currentMembers.includes(user.id);
      return `
        <div class="user ${status}">
          <div>
            <span class="nickname">${getUserLabel(user)}</span>
            <span class="status">${status === 'online' ? 'онлайн' : 'оффлайн'}</span>
          </div>
          ${canInviteUser ? `<button class="ghost invite-button" data-invite="${user.id}">+</button>` : ''}
        </div>
      `;
    })
    .join('');
}

function renderMessages() {
  if (!state.currentRoom?.id) return '';
  const list = state.messages[state.currentRoom.id] || [];
  if (!list.length) {
    return '<p class="muted">Пока нет сообщений.</p>';
  }
  return list
    .map(
      (message) => {
        const file = message.file;
        const isImage = file?.mime?.startsWith('image/');
        const fileMarkup = file
          ? `
            <div class="message-file">
              <a href="${file.url}" target="_blank" rel="noopener">
                ${isImage ? `<img src="${file.url}" alt="${file.name}" />` : file.name}
              </a>
            </div>
          `
          : '';
        return `
          <div class="message">
            <div class="message-header">
              <span class="from">${message.from || 'Аноним'}</span>
              <span class="time">${formatTime(message.timestamp)}</span>
            </div>
            ${message.text ? `<p>${message.text}</p>` : ''}
            ${fileMarkup}
          </div>
        `;
      }
    )
    .join('');
}

function renderVoicePanel() {
  if (!state.currentRoom?.id) return '';
  const deviceOptions = state.voice.devices
    .map((device) => {
      const label = device.label || `Микрофон ${device.deviceId.slice(0, 6)}`;
      const selected = device.deviceId === state.voice.activeDeviceId ? 'selected' : '';
      return `<option value="${device.deviceId}" ${selected}>${label}</option>`;
    })
    .join('');

  const joinButton = state.voice.joined
    ? `<button class="ghost" id="voice-leave">Выйти</button>`
    : `<button class="secondary" id="voice-join">Войти в голосовой чат</button>`;

  const micButton = state.voice.joined
    ? `<button class="secondary" id="voice-toggle-mic">${state.voice.muted ? 'Микрофон выключен' : 'Микрофон включён'}</button>`
    : '';

  const screenButton = state.voice.joined
    ? `<button class="secondary" id="voice-share-screen">${state.voice.isSharingScreen ? 'Остановить экран' : 'Демонстрация экрана'}</button>`
    : '';

  const deviceSelect = state.voice.joined
    ? `<select id="voice-device-select">${deviceOptions}</select>`
    : '';

  return `
    <section class="voice-panel">
      <div class="voice-controls">
        ${joinButton}
        ${micButton}
        ${screenButton}
        ${deviceSelect}
        <div class="mic-indicator" id="mic-level" style="--level: ${state.voice.micLevel.toFixed(2)}"></div>
      </div>
      <div class="voice-status">
        Статус: ${state.voice.status}${state.voice.joined ? ` • участников: ${state.voice.peers + 1}` : ''}
      </div>
      <div class="voice-remote" id="voice-remote"></div>
    </section>
  `;
}

function renderChat() {
  if (!state.currentRoom) {
    return `
      <section class="channel-picker">
        <h2>Комнаты</h2>
        <p class="muted">Выберите комнату, чтобы начать общение.</p>
        ${renderInvitations()}
        <div class="rooms-grid">
          ${state.rooms.map((room) => {
            return `
              <div class="room-card">
                <div>
                  <h4>${getRoomLabel(room)}</h4>
                  <p>${room.description || 'Без описания'}</p>
                </div>
                <button class="secondary" data-room="${room.id}">Открыть</button>
              </div>
            `;
          }).join('')}
        </div>
      </section>
    `;
  }

  return `
    <section class="chat">
      <header>
        <div>
          <h2>${getRoomLabel(state.currentRoom)}</h2>
          <p class="muted">${state.currentRoom.topic || 'Обсуждение и новости комнаты'}</p>
        </div>
        <button class="secondary" id="back-to-rooms">Список каналов</button>
      </header>
      ${renderVoicePanel()}
      <div class="chat-messages">
        ${renderMessages()}
      </div>
      ${state.pendingFiles.length ? `
        <div class="attachments">
          ${state.pendingFiles
            .map(
              (file, index) => `
              <div class="attachment">
                <span>${file.name}</span>
                <button class="ghost" data-remove-file="${index}">×</button>
              </div>
            `
            )
            .join('')}
        </div>
      ` : ''}
      <form class="chat-input" id="chat-form">
        <input id="message-input" type="text" placeholder="Напишите сообщение" />
        <input id="file-input" type="file" multiple hidden />
        <button type="button" class="ghost" id="emoji-toggle">😊</button>
        <button type="button" class="ghost" id="file-attach">📎</button>
        <button class="primary" type="submit">Отправить</button>
      </form>
      <div class="emoji-panel ${state.emojiOpen ? 'open' : ''}" id="emoji-panel" ${
        state.emojiOpen ? '' : 'hidden'
      }>
        ${EMOJI_LIST.map((emoji) => `<button type="button" data-emoji="${emoji}">${emoji}</button>`).join('')}
      </div>
    </section>
  `;
}

function renderAppShell() {
  return `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand">
          <h1>Flash4People</h1>
          <span class="status-indicator ${state.wsStatus}">${state.wsStatus}</span>
        </div>
        <section>
          <h3>Комнаты</h3>
          <div class="rooms-list">
            ${renderRoomsList()}
          </div>
          ${renderRoomCreate()}
        </section>
        <section>
          <h3>Пользователи</h3>
          <div class="users-list">
            ${renderUsersList()}
          </div>
        </section>
      </aside>
      <main class="content">
        <header class="content-header">
          <div>
            <h2>Привет, ${state.user?.nickname || 'гость'}!</h2>
            <p class="muted">Онлайн чат и приглашения в один клик.</p>
          </div>
          ${state.error ? `<div class="error">${state.error}</div>` : ''}
        </header>
        ${renderChat()}
      </main>
    </div>
  `;
}

function bindEvents() {
  const authForm = document.getElementById('auth-form');
  if (authForm) {
    authForm.addEventListener('submit', handleAuthSubmit);
  }

  document.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      state.authMode = button.dataset.mode;
      clearError();
      render();
    });
  });

  const toggleButton = document.querySelector('[data-toggle]');
  if (toggleButton) {
    toggleButton.addEventListener('click', () => {
      state.authMode = state.authMode === 'login' ? 'register' : 'login';
      clearError();
      render();
    });
  }

  document.querySelectorAll('[data-room]').forEach((button) => {
    button.addEventListener('click', () => {
      const room = state.rooms.find((item) => item.id === button.dataset.room);
      handleRoomSelect(room || { id: button.dataset.room, title: button.textContent.trim() });
    });
  });

  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.action;
      const id = button.dataset.id;
      handleInvitationAction(id, action);
    });
  });

  document.querySelectorAll('[data-invite]').forEach((button) => {
    button.addEventListener('click', () => {
      handleInviteUser(button.dataset.invite);
    });
  });

  document.querySelectorAll('[data-remove-file]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.removeFile);
      if (!Number.isNaN(index)) {
        handleRemovePendingFile(index);
      }
    });
  });

  document.querySelectorAll('[data-emoji]').forEach((button) => {
    button.addEventListener('click', () => {
      handleEmojiPick(button.dataset.emoji);
    });
  });

  const backButton = document.getElementById('back-to-rooms');
  if (backButton) {
    backButton.addEventListener('click', () => {
      state.currentRoom = null;
      if (state.voice.joined) {
        handleVoiceLeave();
      }
      render();
    });
  }

  const chatForm = document.getElementById('chat-form');
  if (chatForm) {
    chatForm.addEventListener('submit', handleSendMessage);
  }

  const roomCreateForm = document.getElementById('room-create-form');
  if (roomCreateForm) {
    roomCreateForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(roomCreateForm);
      const name = data.get('room')?.toString().trim();
      if (!name) return;
      sendWs({ type: 'create_room', name });
      roomCreateForm.reset();
    });
  }

  const fileAttachButton = document.getElementById('file-attach');
  const fileInput = document.getElementById('file-input');
  if (fileAttachButton && fileInput) {
    fileAttachButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileInputChange);
  }

  const emojiToggle = document.getElementById('emoji-toggle');
  if (emojiToggle) {
    emojiToggle.addEventListener('click', handleEmojiToggle);
  }

  const voiceJoinButton = document.getElementById('voice-join');
  if (voiceJoinButton) {
    voiceJoinButton.addEventListener('click', () => {
      handleVoiceJoin();
    });
  }

  const voiceLeaveButton = document.getElementById('voice-leave');
  if (voiceLeaveButton) {
    voiceLeaveButton.addEventListener('click', () => {
      handleVoiceLeave();
    });
  }

  const voiceToggleButton = document.getElementById('voice-toggle-mic');
  if (voiceToggleButton) {
    voiceToggleButton.addEventListener('click', () => {
      handleVoiceToggle();
    });
  }

  const voiceShareButton = document.getElementById('voice-share-screen');
  if (voiceShareButton) {
    voiceShareButton.addEventListener('click', () => {
      handleScreenShareToggle();
    });
  }

  const deviceSelect = document.getElementById('voice-device-select');
  if (deviceSelect) {
    deviceSelect.addEventListener('change', () => {
      handleVoiceDeviceChange(deviceSelect.value);
    });
  }
}

function render() {
  appRoot.innerHTML = state.isAuthed ? renderAppShell() : renderAuth();
  bindEvents();
}

window.appState = state;
window.renderApp = render;
setInterval(sweepInvitations, INVITE_SWEEP_MS);
render();

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    refreshVoiceDevices();
  });
}
