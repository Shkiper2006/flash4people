# Настройка и запуск flash4people (RU)

## 1) Установка Node.js (LTS) и базовая настройка службы

1. Установите Node.js LTS (например, с NodeSource):

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```

2. Проверьте версии:

```bash
node -v
npm -v
```

3. Подготовьте серверный каталог:

```bash
cd /workspace/flash4people/server
npm install
```

4. (Опционально) Создайте systemd-сервис для автозапуска:

`/etc/systemd/system/flash4people.service`

```ini
[Unit]
Description=flash4people Node.js server
After=network.target

[Service]
Type=simple
WorkingDirectory=/workspace/flash4people/server
ExecStart=/usr/bin/node /workspace/flash4people/server/index.js
Restart=always
Environment=NODE_ENV=production
Environment=PORT=3001
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

Примените сервис:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now flash4people
sudo systemctl status flash4people
```

> Примечание: убедитесь, что пользователь `www-data` имеет доступ на запись к `server/DB.dat` и `server/uploads`.

## 2) Конфигурация портов и брандмауэра

По умолчанию сервер запускается на `PORT=3001`. Если вы планируете публиковать клиент отдельно, например на `8080`, откройте оба порта.

### UFW (Ubuntu)

```bash
sudo ufw allow 3001/tcp
sudo ufw allow 8080/tcp
sudo ufw reload
sudo ufw status
```

### firewalld (RHEL/CentOS)

```bash
sudo firewall-cmd --permanent --add-port=3001/tcp
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --reload
sudo firewall-cmd --list-ports
```

Если меняете порт сервера, обновите `Environment=PORT=...` в systemd unit и перезапустите службу.

## 3) Запуск сервера и доступ к клиенту через браузер

### Сервер (API + WebSocket)

```bash
cd /workspace/flash4people/server
npm install
node index.js
```

Сервер должен вывести: `Server running on port 3001`.

### Клиент (статические файлы)

Клиент находится в каталоге `client/` и представляет собой статические файлы. Вы можете запустить простой HTTP-сервер:

```bash
cd /workspace/flash4people/client
npx http-server -p 8080
```

После запуска откройте в браузере:

- Клиент: `http://<host>:8080`
- Сервер API: `http://<host>:3001`

> Если клиент обращается к API на другом хосте/порту, убедитесь, что это соответствует настройкам в `client/app.js`.

## 4) Пример структуры DB.dat, бэкап и восстановление

Файл базы данных находится в `server/DB.dat` и хранится в JSON. Пример структуры:

```json
{
  "users": [
    {
      "id": "uuid",
      "username": "alice",
      "passwordHash": "...",
      "createdAt": "2024-01-01T12:00:00.000Z"
    }
  ],
  "sessions": {
    "session-token": {
      "userId": "uuid",
      "createdAt": "2024-01-01T12:05:00.000Z"
    }
  },
  "rooms": [
    {
      "id": "uuid",
      "name": "Room 1",
      "ownerId": "uuid",
      "createdAt": "2024-01-01T12:10:00.000Z"
    }
  ],
  "messages": [
    {
      "id": "uuid",
      "roomId": "uuid",
      "fromUserId": "uuid",
      "type": "text",
      "text": "Привет!",
      "fileName": null,
      "fileData": null,
      "createdAt": "2024-01-01T12:12:00.000Z"
    }
  ],
  "invites": [
    {
      "id": "uuid",
      "roomId": "uuid",
      "fromUserId": "uuid",
      "toUserId": "uuid",
      "status": "pending",
      "createdAt": "2024-01-01T12:15:00.000Z",
      "expiresAt": "2024-01-02T12:15:00.000Z"
    }
  ],
  "files": [
    {
      "id": "uuid",
      "name": "report.pdf",
      "mime": "application/pdf",
      "size": 12345,
      "path": "/workspace/flash4people/server/uploads/uuid.pdf",
      "ts": "2024-01-01T12:20:00.000Z"
    }
  ]
}
```

### Бэкап

Остановите сервер, затем скопируйте `DB.dat` и каталог `uploads`:

```bash
sudo systemctl stop flash4people
cp /workspace/flash4people/server/DB.dat /backups/DB.dat
cp -r /workspace/flash4people/server/uploads /backups/uploads
sudo systemctl start flash4people
```

### Восстановление

```bash
sudo systemctl stop flash4people
cp /backups/DB.dat /workspace/flash4people/server/DB.dat
cp -r /backups/uploads /workspace/flash4people/server/uploads
sudo systemctl start flash4people
```

> После восстановления проверьте права доступа на файлы (владелец/группа должны совпадать с пользователем сервиса).
