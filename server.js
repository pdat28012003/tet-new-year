const path = require('path');
const { Readable } = require('stream');

const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
require('dotenv').config();

const Upload = require('./models/upload');

const app = express();

const port = Number(process.env.PORT || 8080);
const mongoUrl = process.env.MONGO_URL;
const uploadDir = process.env.UPLOAD_DIR;
const maxFileSize = Number(process.env.MAX_FILE_SIZE || 10 * 1024 * 1024);

if (!mongoUrl) {
  throw new Error('Missing MONGO_URL in .env');
}

let isConnected = false;
let gfsBucket = null;

async function ensureDb() {
  if (!isConnected) {
    await mongoose.connect(mongoUrl);
    isConnected = true;
  }
  if (!gfsBucket) {
    gfsBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: 'uploads'
    });
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxFileSize },
  fileFilter: function (_req, file, cb) {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      cb(new Error('Only image uploads are allowed'));
      return;
    }
    cb(null, true);
  }
});

app.use(express.json());

if (uploadDir) {
  app.use('/uploads', express.static(path.resolve(process.cwd(), uploadDir)));
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/client', (_req, res) => {
  res.sendFile(path.join(__dirname, 'client.html'));
});

app.post('/api/uploads', upload.single('image'), async (req, res) => {
  try {
    await ensureDb();

    const envelopeIdRaw = req.body && req.body.envelopeId !== undefined ? req.body.envelopeId : undefined;
    const envelopeId = Number(envelopeIdRaw);
    if (!Number.isInteger(envelopeId) || envelopeId < 0) {
      res.status(400).json({ error: 'Invalid envelopeId' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const existing = await Upload.findOne({ envelopeId }).lean();
    if (existing && existing.fileId) {
      try {
        gfsBucket.delete(new mongoose.Types.ObjectId(existing.fileId), () => {
        });
      } catch (_e) {
      }
    }

    const uploadStream = gfsBucket.openUploadStream(req.file.originalname, {
      contentType: req.file.mimetype,
      metadata: { envelopeId }
    });

    const readable = Readable.from(req.file.buffer);
    const fileId = await new Promise((resolve, reject) => {
      readable
        .pipe(uploadStream)
        .on('error', reject)
        .on('finish', () => resolve(String(uploadStream.id)));
    });

    const url = `/api/files/${fileId}`;
    const doc = await Upload.findOneAndUpdate(
      { envelopeId },
      {
        envelopeId,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        fileId,
        url
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json({
      id: String(doc._id),
      envelopeId: doc.envelopeId,
      url: doc.url,
      originalName: doc.originalName,
      mimeType: doc.mimeType,
      size: doc.size,
      createdAt: doc.createdAt
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

app.get('/api/uploads', async (_req, res) => {
  await ensureDb();
  const docs = await Upload.find().sort({ createdAt: -1 }).limit(200).lean();
  res.json(
    docs
      .filter((d) => {
        if (!uploadDir && !d.fileId) return false;
        return true;
      })
      .map((d) => ({
        id: String(d._id),
        envelopeId: d.envelopeId,
        url: d.url,
        originalName: d.originalName,
        mimeType: d.mimeType,
        size: d.size,
        createdAt: d.createdAt
      }))
  );
});

app.get('/api/envelopes', async (_req, res) => {
  await ensureDb();
  const docs = await Upload.find().lean();
  const byEnvelopeId = {};
  docs.forEach((d) => {
    if (!Number.isInteger(d.envelopeId) || d.envelopeId < 0) {
      return;
    }
    if (!uploadDir && !d.fileId) {
      return;
    }
    byEnvelopeId[d.envelopeId] = {
      id: String(d._id),
      envelopeId: d.envelopeId,
      url: d.url,
      originalName: d.originalName,
      mimeType: d.mimeType,
      size: d.size,
      createdAt: d.createdAt
    };
  });
  res.json(byEnvelopeId);
});

app.delete('/api/envelopes/:envelopeId', async (req, res) => {
  try {
    await ensureDb();
    const envelopeId = Number(req.params.envelopeId);
    if (!Number.isInteger(envelopeId) || envelopeId < 0) {
      res.status(400).json({ error: 'Invalid envelopeId' });
      return;
    }

    const doc = await Upload.findOneAndDelete({ envelopeId }).lean();
    if (!doc) {
      res.json({ ok: true, deleted: false });
      return;
    }

    if (doc.fileId) {
      try {
        gfsBucket.delete(new mongoose.Types.ObjectId(doc.fileId), () => {
        });
      } catch (_e) {
      }
    }

    res.json({ ok: true, deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Delete failed' });
  }
});

app.get('/api/files/:id', async (req, res) => {
  try {
    await ensureDb();
    const id = req.params.id;
    if (!id) {
      res.status(400).end('Missing id');
      return;
    }

    const objectId = new mongoose.Types.ObjectId(id);
    const files = await mongoose.connection.db
      .collection('uploads.files')
      .find({ _id: objectId })
      .limit(1)
      .toArray();

    if (!files || files.length === 0) {
      res.status(404).end('Not found');
      return;
    }

    const file = files[0];
    if (file && file.contentType) {
      res.setHeader('Content-Type', file.contentType);
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    const stream = gfsBucket.openDownloadStream(objectId);
    stream.on('error', () => res.status(404).end('Not found'));
    stream.pipe(res);
  } catch (_e) {
    res.status(400).end('Bad request');
  }
});

app.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: `File too large. MAX_FILE_SIZE=${maxFileSize}` });
    return;
  }
  res.status(400).json({ error: err.message || 'Bad Request' });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

module.exports = app;
