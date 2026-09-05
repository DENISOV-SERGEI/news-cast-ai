// src/deploySite.js
// Автодеплой сгенерированных файлов сайта business_card на хостинг по SFTP/SSH.
//
// После exportSiteNews() + exportSiteArticles() на диске готовы:
//   - news.json
//   - articles.html
//   - articles/<slug>.html
//
// Этот модуль заливает их на удалённый хостинг (например Beget) по SFTP/SSH
// (ssh2-sftp-client, порт 22). При подключении мы попадаем в корень сайта
// (например ~/public_html) — база берётся из sftp.cwd(),
// поэтому DEPLOY_FTP_REMOTE_DIR для SFTP не используется.
//
// Включается только если заданы все три переменные
// DEPLOY_FTP_HOST / DEPLOY_FTP_USER / DEPLOY_FTP_PASS (см. config.features.deploySite).
//
// Best-effort: вызывается из scheduler в try/catch — ошибка не должна ронять
// прогон (как siteNews / siteArticles). Дополнительно обёрнут в retryWithBackoff
// (2 повтора) — сеть моргнула, деплой повторится, а не потеряется до следующего прогона.
//
// После заливки — проверка успешности: размер каждого файла на сервере сверяется
// с локальным. Если задан DEPLOY_SITE_URL — дополнительная HTTP-проверка:
// fetch к <url>/news.json и сверка, что сайт отдаёт свежие данные.

import SftpClient from 'ssh2-sftp-client';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { config, log } from './config.js';
import { retryWithBackoff } from './retry.js';
import { fetchWithTimeout } from './http.js';

/**
 * Заливает news.json, articles.html и все articles/*.html на удалённый хостинг.
 * Возвращает { skipped, uploadedFiles, deletedFiles, error? }.
 * Если фича отключена — { skipped: true }.
 */
export async function deploySiteFiles() {
  if (!config.features.deploySite) {
    return { skipped: true, uploadedFiles: 0, deletedFiles: 0 };
  }

  try {
    // 2 повтора (всего 3 попытки) на сетевые/транзиентные ошибки.
    return await retryWithBackoff(() => deployOnce(), {
      retries: 2,
      baseMs: 2000,
      factor: 2,
      maxMs: 10_000,
      label: 'deploy-site',
    });
  } catch (err) {
    log('warn', `[deploy-site] Автодеплой не удался: ${err.message}`);
    return { skipped: false, uploadedFiles: 0, deletedFiles: 0, error: err.message };
  }
}

/**
 * Одна попытка деплоя. Все ошибки помечаем retryable=true — повтор безопасен,
 * потому что заливка идемпотентна (перезапись файлов).
 */
async function deployOnce() {
  const sftp = new SftpClient();
  let uploadedFiles = 0;
  let deletedFiles = 0;

  try {
    await sftp.connect({
      host: config.deployFtpHost,
      port: config.deploySftpPort,
      username: config.deployFtpUser,
      password: config.deployFtpPass,
    });

    // Корень сайта на сервере (куда мы попадаем при подключении).
    const baseDir = await sftp.cwd();

    // 1) news.json
    await uploadWithCheck(sftp, baseDir, config.businessCardNewsPath, 'news.json');
    uploadedFiles++;

    // 2) articles.html
    await uploadWithCheck(sftp, baseDir, config.siteArticlesListPath, 'articles.html');
    uploadedFiles++;

    // 3) Каталог articles/: заливаем актуальные, удаляем устаревшие.
    const articlesDir = path.posix.join(baseDir, 'articles');
    await sftp.mkdir(articlesDir, true);

    const localFiles = (await readdir(config.siteArticlesDir)).filter((f) => f.endsWith('.html'));
    const remoteFiles = await sftp.list(articlesDir);
    const remoteHtml = remoteFiles.map((f) => f.name).filter((n) => n.endsWith('.html'));

    for (const f of localFiles) {
      await uploadWithCheck(sftp, articlesDir, path.join(config.siteArticlesDir, f), f);
      uploadedFiles++;
    }

    // Удаляем на сервере те статьи, которых больше нет на диске (регламент
    // «топ-10 за 14 дней» удаляет устаревшие страницы и локально, и на сервере).
    for (const rname of remoteHtml) {
      if (!localFiles.includes(rname)) {
        try {
          await sftp.delete(path.posix.join(articlesDir, rname));
          deletedFiles++;
        } catch (e) {
          log('warn', `[deploy-site] Не удалось удалить ${rname}: ${e.message}`);
        }
      }
    }

    log('info', `[deploy-site] Залито на ${config.deployFtpHost}: ${uploadedFiles} файлов, удалено устаревших: ${deletedFiles}`);

    // 4) HTTP-проверка: сайт реально отдаёт свежие данные.
    await verifySite();

    return { skipped: false, uploadedFiles, deletedFiles };
  } catch (err) {
    // Любая ошибка деплоя — транзиентная (сеть, сервер). Повтор безопасен.
    err.retryable = true;
    throw err;
  } finally {
    try {
      await sftp.end();
    } catch {
      /* соединение уже закрыто или не было открыто */
    }
  }
}

/**
 * Загружает файл и сверяет размер на сервере с локальным.
 * Если размеры не совпали — бросает ошибку (деплой повторится).
 * Экспортируется для тестов (sftp — любой объект с fastPut/stat).
 */
export async function uploadWithCheck(sftp, remoteDir, localPath, remoteName) {
  const remotePath = path.posix.join(remoteDir, remoteName);
  await sftp.fastPut(localPath, remotePath);
  const localSize = (await stat(localPath)).size;
  const remoteStat = await sftp.stat(remotePath);
  if (remoteStat.size !== localSize) {
    throw new Error(
      `Размер ${remoteName} не совпал после заливки: локально ${localSize}, на сервере ${remoteStat.size}`,
    );
  }
}

/**
 * HTTP-проверка после деплоя: fetch к <DEPLOY_SITE_URL>/news.json и сверка,
 * что сайт отдаёт свежие данные. Best-effort — ошибка только логируется.
 * Экспортируется для тестов.
 */
export async function verifySite() {
  if (!config.deploySiteUrl) return;
  try {
    const res = await fetchWithTimeout(`${config.deploySiteUrl}/news.json`, {}, { timeoutMs: 15_000 });
    if (!res.ok) {
      log('warn', `[deploy-site] HTTP-проверка: сайт вернул ${res.status} ${res.statusText}`);
      return;
    }
    const data = await res.json();
    const items = Array.isArray(data) ? data : data.items || [];
    log(
      'info',
      `[deploy-site] HTTP-проверка: ${config.deploySiteUrl} отдаёт ${items.length} новостей (updated_at=${data.updated_at || 'n/a'})`,
    );
  } catch (e) {
    log('warn', `[deploy-site] HTTP-проверка не удалась: ${e.message}`);
  }
}
