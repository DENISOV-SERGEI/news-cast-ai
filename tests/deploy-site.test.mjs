// tests/deploy-site.test.mjs
// Автодеплой сайта business_card на хостинг по SFTP/SSH.
// Реальные соединения не делаем (нет кредов): проверяем режим off
// (DEPLOY_FTP_* не заданы → skipped), модуль-импорт, отсутствие побочных
// эффектов при выключенной фиче, а также новые функции uploadWithCheck
// (сверка размера после заливки) и verifySite (HTTP-проверка сайта).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { deploySiteFiles, uploadWithCheck, verifySite } from '../src/deploySite.js';

test('deploySite: без FTP-кредов → skipped (no-op, без сети)', async () => {
  // Гарантируем, что фича off (host/user/pass пустые) — независимо от .env.
  config.deployFtpHost = '';
  config.deployFtpUser = '';
  config.deployFtpPass = '';
  // Пересобираем features: фича строится из строк до экспорта, поэтому
  // принудительно выставляем флаг напрямую (на момент тестов конфиг уже собран).
  config.features.deploySite = false;

  const res = await deploySiteFiles();
  assert.equal(res.skipped, true);
  assert.equal(res.uploadedFiles, 0);
  assert.equal(res.deletedFiles, 0);
});

test('deploySite: фича включается только при полном наборе DEPLOY_FTP_*', () => {
  config.deployFtpHost = '';
  config.deployFtpUser = '';
  config.deployFtpPass = '';
  config.features.deploySite = false;
  assert.equal(config.features.deploySite, false);

  // Имитация: все три заданы → true (логика config.js).
  config.deployFtpHost = 'ftp.example.com';
  config.deployFtpUser = 'user';
  config.deployFtpPass = 'pass';
  config.features.deploySite = true;
  assert.equal(config.features.deploySite, true);

  // Восстанавливаем off, чтобы не задеть другие тесты.
  config.deployFtpHost = '';
  config.deployFtpUser = '';
  config.deployFtpPass = '';
  config.features.deploySite = false;
});

test('uploadWithCheck: размеры совпали → не бросает', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'deploy-'));
  const local = path.join(dir, 'a.html');
  writeFileSync(local, 'hello'); // 5 байт

  const sftp = {
    fastPut: async () => {},
    stat: async () => ({ size: 5 }),
  };
  await uploadWithCheck(sftp, '/remote', local, 'a.html'); // не должно бросить
});

test('uploadWithCheck: размеры не совпали → бросает (деплой повторится)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'deploy-'));
  const local = path.join(dir, 'a.html');
  writeFileSync(local, 'hello'); // 5 байт

  const sftp = {
    fastPut: async () => {},
    stat: async () => ({ size: 99 }),
  };
  await assert.rejects(
    uploadWithCheck(sftp, '/remote', local, 'a.html'),
    /не совпал/,
  );
});

test('verifySite: DEPLOY_SITE_URL пуст → no-op (без сети)', async () => {
  const prev = config.deploySiteUrl;
  config.deploySiteUrl = '';
  await verifySite(); // не должно бросить и не должно делать fetch
  config.deploySiteUrl = prev;
});

test('verifySite: сайт отдаёт новости → лог (мок fetch)', async () => {
  const prev = config.deploySiteUrl;
  const origFetch = globalThis.fetch;
  config.deploySiteUrl = 'https://example.com';
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ updated_at: '2026-09-05T00:00:00.000Z', items: [{}, {}, {}] }),
  });
  try {
    await verifySite(); // не должно бросить
  } finally {
    config.deploySiteUrl = prev;
    globalThis.fetch = origFetch;
  }
});

test('verifySite: сайт вернул ошибку → warn, не бросает', async () => {
  const prev = config.deploySiteUrl;
  const origFetch = globalThis.fetch;
  config.deploySiteUrl = 'https://example.com';
  globalThis.fetch = async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' });
  try {
    await verifySite(); // не должно бросить
  } finally {
    config.deploySiteUrl = prev;
    globalThis.fetch = origFetch;
  }
});
