const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, 'DB.dat');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function parseDbContents(raw) {
  if (!raw.trim()) {
    return { mode: 'object', data: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { mode: 'array', data: parsed };
    }
    return { mode: 'object', data: parsed };
  } catch (error) {
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const entries = lines.map((line) => JSON.parse(line));
    return { mode: 'ndjson', data: entries };
  }
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    return { mode: 'object', data: {} };
  }
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  return parseDbContents(raw);
}

function writeDb(mode, data) {
  const dir = path.dirname(DB_FILE);
  const tempPath = path.join(dir, `.${path.basename(DB_FILE)}.${crypto.randomUUID()}.tmp`);
  let contents = '';
  if (mode === 'ndjson') {
    contents = data.map((entry) => JSON.stringify(entry)).join('\n');
    if (contents) {
      contents += '\n';
    }
  } else {
    contents = JSON.stringify(data, null, 2);
  }
  fs.writeFileSync(tempPath, contents);
  fs.renameSync(tempPath, DB_FILE);
}

function addFileEntry(entry) {
  const { mode, data } = loadDb();
  if (mode === 'array' || mode === 'ndjson') {
    data.push(entry);
    writeDb(mode, data);
    return;
  }
  const files = Array.isArray(data.files) ? data.files : [];
  files.push(entry);
  data.files = files;
  writeDb('object', data);
}

function findFileEntry(fileId) {
  const { mode, data } = loadDb();
  if (mode === 'array' || mode === 'ndjson') {
    return data.find((entry) => entry.id === fileId) || null;
  }
  if (!Array.isArray(data.files)) {
    return null;
  }
  return data.files.find((entry) => entry.id === fileId) || null;
}

function decodePayload(payload) {
  if (typeof payload === 'string') {
    const dataUrlMatch = payload.match(/^data:([^;]+);base64,(.*)$/);
    if (dataUrlMatch) {
      return {
        buffer: Buffer.from(dataUrlMatch[2], 'base64'),
        mime: dataUrlMatch[1],
      };
    }
    return { buffer: Buffer.from(payload, 'base64') };
  }
  if (Array.isArray(payload)) {
    return { buffer: Buffer.from(payload) };
  }
  if (Buffer.isBuffer(payload)) {
    return { buffer: payload };
  }
  return { buffer: null };
}

function attachFileRoutes({ app }) {
  app.post('/upload', (req, res) => {
    const { name, fileName, mime, type, data, fileData } = req.body || {};
    const resolvedName = name || fileName;
    const payload = data || fileData;
    if (!resolvedName || !payload) {
      res.status(400).json({ error: 'Missing file payload' });
      return;
    }

    const decoded = decodePayload(payload);
    if (!decoded.buffer) {
      res.status(400).json({ error: 'Invalid file payload' });
      return;
    }

    ensureUploadDir();
    const id = crypto.randomUUID();
    const ext = path.extname(resolvedName).replace(/[^.\w]/g, '');
    const filename = `${id}${ext}`;
    const filePath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(filePath, decoded.buffer);

    const entry = {
      id,
      name: resolvedName,
      mime: mime || type || decoded.mime || 'application/octet-stream',
      size: decoded.buffer.length,
      path: filePath,
      ts: new Date().toISOString(),
    };

    addFileEntry(entry);

    res.status(201).json({ id, url: `/files/${id}` });
  });

  app.get('/files/:id', (req, res) => {
    const entry = findFileEntry(req.params.id);
    if (!entry) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.type(entry.mime || 'application/octet-stream');
    res.sendFile(path.resolve(entry.path));
  });
}

module.exports = { attachFileRoutes };
