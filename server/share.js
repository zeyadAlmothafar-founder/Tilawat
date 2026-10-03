// Sharing helpers: server address info (for share links) and QR codes.
import express from 'express';
import QRCode from 'qrcode';
import { lanAddresses } from './lib/net.js';
import { httpError } from './lib/errors.js';

export const router = express.Router();

const MAX_QR_TEXT = 1000;

function port() {
  return Number(process.env.PORT) || 4700;
}

function publicBaseUrl() {
  const raw = (process.env.PUBLIC_BASE_URL || '').trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

export function serverInfo() {
  const p = port();
  const lanUrls = lanAddresses().map((ip) => `http://${ip}:${p}`);
  const pub = publicBaseUrl();
  return {
    port: p,
    lanUrls,
    publicBaseUrl: pub,
    shareBaseUrl: pub || lanUrls[0] || `http://localhost:${p}`,
  };
}

function isHttpUrl(text) {
  try {
    const { protocol } = new URL(text);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

router.get('/server-info', (req, res) => {
  res.set('Cache-Control', 'no-store').json(serverInfo());
});

router.get('/qr.svg', async (req, res) => {
  const text = typeof req.query.text === 'string' ? req.query.text.trim() : '';
  if (!text || text.length > MAX_QR_TEXT || !isHttpUrl(text)) {
    throw httpError(400, 'invalid_text', `text must be an http(s) URL of at most ${MAX_QR_TEXT} characters`);
  }
  const svg = await QRCode.toString(text, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#0b2e28', light: '#ffffff' },
  });
  res.set('Content-Type', 'image/svg+xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});
