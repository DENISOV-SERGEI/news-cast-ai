// scripts/pkce-setup.mjs
// Генерация PKCE (code_verifier + code_challenge) и authorize_url для нового VK ID.
// Запуск: node scripts/pkce-setup.mjs
// Дальше: открыть authorize_url в браузере, после редиректа на oauth.vk.com/blank.html
// скопировать ПОЛНЫЙ URL из адресной строки и передать его в pkce-exchange.mjs.

import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const CLIENT_ID = '54734334'; // наше Standalone-приложение
const REDIRECT_URI = 'https://oauth.vk.com/blank.html';
const SCOPE = 'groups wall photos';

// PKCE: code_verifier — 64 символа [a-zA-Z0-9_-]
function generateCodeVerifier() {
  // randomBytes(48) → base64url → ~64 символа
  return randomBytes(48).toString('base64url').slice(0, 64);
}

// code_challenge = base64url(SHA256(code_verifier))
function codeChallengeFor(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

const codeVerifier = generateCodeVerifier();
const codeChallenge = codeChallengeFor(codeVerifier);
const state = 'random_state_' + Date.now();
const deviceId = randomBytes(16).toString('hex'); // 32 hex-символа, как у N8N-флоу

const authorizeUrl =
  `https://id.vk.com/authorize?response_type=code` +
  `&client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&state=${encodeURIComponent(state)}` +
  `&code_challenge=${codeChallenge}` +
  `&code_challenge_method=S256` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  `&device_id=${deviceId}`;

console.log('=== PKCE-сгенерировано ===');
console.log('client_id     :', CLIENT_ID);
console.log('state         :', state);
console.log('device_id     :', deviceId);
console.log('code_verifier :', codeVerifier);
console.log('code_challenge:', codeChallenge);
console.log();
console.log('=== Открой в браузере и залогинься ===');
console.log(authorizeUrl);
console.log();
console.log('=== После редиректа скопируй ПОЛНЫЙ URL из адресной строки ===');
console.log('(должен начинаться с https://oauth.vk.com/blank.html?code=...)');

// Сохраняем в файл, чтобы pkce-exchange.mjs мог прочитать.
const payload = {
  CLIENT_ID,
  REDIRECT_URI,
  SCOPE,
  codeVerifier,
  codeChallenge,
  state,
  deviceId,
  generatedAt: new Date().toISOString(),
};
await writeFile('scripts/.pkce-state.json', JSON.stringify(payload, null, 2), 'utf8');
console.log();
console.log('Состояние сохранено в scripts/.pkce-state.json');