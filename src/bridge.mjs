import { createServer } from 'node:http';
import { readFile, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// PROVISIONAL pending Tomer: change only this function when POST /extract is confirmed.
export function buildExtractRequest(text, principal) {
  return { transcript: text, principal };
}

function json(response, code, body) {
  response.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function inside(root, path) {
  const difference = relative(root, path);
  return difference !== '..' && !difference.startsWith('../') && !isAbsolute(difference);
}

async function serve(request, response, getStatus) {
  let pathname;
  try {
    // Inspect the original path: URL normalization would erase traversal segments.
    pathname = decodeURIComponent((request.url ?? '/').split('?')[0]);
  } catch {
    return json(response, 400, { error: 'Ruta no válida' });
  }
  if (!pathname.startsWith('/') || pathname.includes('\0') ||
      pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) {
    return json(response, 403, { error: 'Acceso denegado' });
  }

  if (pathname.startsWith('/api/')) {
    const match = /^\/api\/status\/([^/]+)$/.exec(pathname);
    if (!match) return json(response, 404, { error: 'Ruta no encontrada' });
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      return json(response, 405, { error: 'Método no permitido' });
    }
    // Pass through the complete status, including any hashes supplied by hold.mjs.
    const status = await getStatus(match[1]);
    return status == null
      ? json(response, 404, { error: 'Propuesta no encontrada' })
      : json(response, 200, status);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return json(response, 405, { error: 'Método no permitido' });
  }

  try {
    const root = await realpath(WEB);
    let path = await realpath(resolve(root, '.' + pathname));
    if (!inside(root, path)) return json(response, 403, { error: 'Acceso denegado' });
    let info = await stat(path);
    if (info.isDirectory()) {
      path = await realpath(join(path, 'index.html'));
      if (!inside(root, path)) return json(response, 403, { error: 'Acceso denegado' });
      info = await stat(path);
    }
    if (!info.isFile()) return json(response, 404, { error: 'Archivo no encontrado' });

    const body = request.method === 'HEAD' ? null : await readFile(path);
    response.writeHead(200, {
      'Content-Type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body?.length ?? info.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return json(response, 404, { error: 'Archivo no encontrado' });
    }
    if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'ELOOP') {
      return json(response, 403, { error: 'Acceso denegado' });
    }
    throw error;
  }
}

async function extract(url, text, principal) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    console.log('[motor] Intento ' + attempt + '/6');
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(buildExtractRequest(text, principal)),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('HTTP ' + response.status);
      }
      const result = await response.json();
      if (!result || !Object.hasOwn(result, 'transcript') || !Array.isArray(result.actions) ||
          result.actions.some(action => !action || typeof action.auto_execute !== 'boolean')) {
        throw new Error('Respuesta incompatible: se esperan transcript y actions con auto_execute booleano');
      }
      return { transcript: result.transcript, actions: result.actions };
    } catch (error) {
      // Do not print response bodies, configuration values, or Telegram credentials.
      const reason = error.name === 'TimeoutError' ? 'tiempo de espera agotado'
        : error.message.startsWith('HTTP ') ? error.message : 'respuesta no disponible o no válida';
      console.error('[motor] Intento ' + attempt + '/6 fallido: ' + reason);
      if (attempt < 6) await delay(2_000);
    }
  }
  return null;
}

function manualFallback() {
  console.error('El servidor web sigue disponible. Puedes escribir web/actions.json a mano como { transcript, actions }.');
}

async function main() {
  let env;
  try {
    env = parseEnv(await readFile(join(ROOT, '.env'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error('Falta .env en la raíz de AfterWord. Créalo con TG_TOKEN, TG_CHAT, ENGINE_URL y PRINCIPAL; TRANSCRIPT_PATH es opcional.');
      return;
    }
    throw error;
  }

  // Load configuration BEFORE importing hold.mjs, which may read it at module initialization.
  for (const key of ['TG_TOKEN', 'TG_CHAT', 'ENGINE_URL', 'PRINCIPAL', 'TRANSCRIPT_PATH']) {
    if (env[key] !== undefined) process.env[key] = env[key];
  }
  const { sendProposal, getStatus, startPolling, tamperTest } = await import('./hold.mjs');
  // tamperTest is provided by hold.mjs; the bridge exposes no extra mutation endpoint.

  const server = createServer((request, response) => {
    void serve(request, response, getStatus).catch(() => {
      if (!response.headersSent) json(response, 500, { error: 'No se pudo atender la petición' });
      else response.destroy();
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(8080, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  server.on('error', () => console.error('Error del servidor HTTP local.'));
  console.log('AfterWord disponible en http://127.0.0.1:8080');
  // README must also state this; the bridge only simulates execution by logging.
  console.log('Modo demostración: [ejecutado] solo registra la acción; no ejecuta tareas ni envía correos.');
  try {
    await processTranscript(env, sendProposal);
  } finally {
    // Start once, after dispatch or fallback; never await the indefinite polling loop.
    void Promise.resolve().then(() => startPolling()).catch(() => {
      console.error('No se pudo mantener el polling de Telegram.');
    });
  }
}

async function processTranscript(env, sendProposal) {
  const transcriptPath = resolve(ROOT, env.TRANSCRIPT_PATH || 'web/sample.txt');
  let text;
  try {
    text = await readFile(transcriptPath, 'utf8');
  } catch (error) {
    console.error(error.code === 'ENOENT'
      ? 'Falta la transcripción: ' + transcriptPath + '. Revisa TRANSCRIPT_PATH en .env.'
      : 'No se pudo leer la transcripción. Revisa TRANSCRIPT_PATH y sus permisos.');
    manualFallback();
    return;
  }
  if (!env.PRINCIPAL?.trim()) {
    console.error('Falta PRINCIPAL en .env. Indica el nombre del hablante.');
    manualFallback();
    return;
  }
  try {
    const url = new URL(env.ENGINE_URL);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Protocolo');
  } catch {
    console.error('ENGINE_URL debe ser una URL HTTP(S) del endpoint /extract en .env.');
    manualFallback();
    return;
  }

  const result = await extract(env.ENGINE_URL, text, env.PRINCIPAL);
  if (!result) {
    console.error('El motor falló en los seis intentos.');
    manualFallback();
    return;
  }

  try {
    await mkdir(WEB, { recursive: true });
    // Persist the FULL engine result before logging or proposing any action.
    // JSON serialization is only transport/storage; no canonicalization or hashing occurs here.
    await writeFile(join(WEB, 'actions.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  } catch {
    console.error('No se pudo guardar web/actions.json. No se han tramitado las acciones.');
    manualFallback();
    return;
  }

  for (const action of result.actions) {
    if (action.auto_execute === true) {
      console.log('[ejecutado] ' + action.title);
    } else if (action.auto_execute === false) {
      try {
        await sendProposal(action);
      } catch {
        console.error('No se pudo enviar la propuesta: ' + action.title);
      }
    }
  }
}

void main().catch(error => {
  console.error(error.code === 'EADDRINUSE'
    ? 'No se puede iniciar AfterWord: 127.0.0.1:8080 ya está ocupado.'
    : 'No se pudo iniciar AfterWord. Revisa .env y la disponibilidad de src/hold.mjs.');
  process.exitCode = 1;
});
