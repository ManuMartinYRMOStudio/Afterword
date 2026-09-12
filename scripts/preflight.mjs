import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { performance } from 'node:perf_hooks';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = ['TG_TOKEN', 'TG_CHAT', 'ENGINE_URL'];
let env = {};
let secrets = [];

// Only externally supplied display fields pass here. Never print error messages,
// response descriptions, request URLs, chat IDs, command lines, or env values.
function display(value) {
  let text = String(value);
  for (const secret of secrets) text = text.split(secret).join('[oculto]');
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0,80);
}

function result(ok, detail) {
  return { ok, detail };
}

async function checkEnv() {
  try {
    const text = await readFile(join(ROOT, '.env'), 'utf8');
    // Node 22 can consume the next line after an unquoted empty value with spaces.
    // Normalize only empty required settings; preserve quoted values and other keys.
    env = parseEnv(text.replace(
      /^([ \t]*(?:export[ \t]+)?(?:TG_TOKEN|TG_CHAT|ENGINE_URL)[ \t]*=)[ \t]+(?=\r?$)/gm, '$1'));

    secrets = [...new Set(Object.values(env).filter(Boolean).flatMap(value => [
      value, encodeURIComponent(value),
    ]))].sort((a, b) => b.length - a.length);
    const lengths = REQUIRED.map(key => key + '.length=' + (env[key]?.length ?? 0)).join(', ');
    const missing = REQUIRED.filter(key => !env[key]?.trim());
    return result(missing.length === 0, 'presente; ' + lengths +
      (missing.length ? '; faltan o están vacías: ' + missing.join(', ') : ''));
  } catch (error) {
    return result(false, (error.code === 'ENOENT' ? 'no existe' : 'no se puede leer o interpretar') +
      '; TG_TOKEN.length=0, TG_CHAT.length=0, ENGINE_URL.length=0 (no verificadas)');
  }
}

async function telegram(method, parameters = {}) {
  try {
    const response = await fetch('https://api.telegram.org/bot' + env.TG_TOKEN + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parameters),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      return result(false, 'HTTP ' + response.status + '; respuesta JSON no válida');
    }
    if (!response.ok || data?.ok !== true) {
      return result(false, 'HTTP ' + response.status + '; Telegram rechazó la solicitud');
    }
    return { ok: true, data: data.result };
  } catch (error) {
    return result(false, error.name === 'TimeoutError'
      ? 'Telegram no respondió en 10000 ms' : 'no se pudo conectar con Telegram');
  }
}

async function checkBot() {
  if (!env.TG_TOKEN?.trim()) return result(false, 'sin comprobar: falta TG_TOKEN');
  const response = await telegram('getMe');
  if (!response.ok) return response;
  const bot = response.data;
  if (bot?.is_bot !== true || typeof bot.username !== 'string' ||
      !/^[A-Za-z0-9_]+$/.test(bot.username)) {
    return result(false, 'getMe no devolvió una identidad de bot válida');
  }
  return result(true, 'bot @' + display(bot.username));
}

async function checkChat() {
  if (!env.TG_TOKEN?.trim() || !env.TG_CHAT?.trim()) {
    return result(false, 'sin comprobar: falta TG_TOKEN o TG_CHAT');
  }
  const response = await telegram('getChat', { chat_id: env.TG_CHAT });
  if (!response.ok) {
    return result(false, response.detail + '; revisa TG_CHAT y que el usuario haya iniciado el bot con /start');
  }
  const type = response.data?.type;
  if (!['private', 'group', 'supergroup', 'channel'].includes(type)) {
    return result(false, 'getChat no devolvió un tipo de chat válido');
  }
  // Resolution does not prove delivery permission. This check sends no messages.
  return result(true, 'tipo=' + type +
    (type === 'private' ? '; el usuario debe haber iniciado el bot con /start; no se prueba el envío' : ''));
}

async function checkEngine() {
  if (!env.ENGINE_URL?.trim()) return result(false, 'sin comprobar: falta ENGINE_URL');
  try {
    const url = new URL(env.ENGINE_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return result(false, 'ENGINE_URL debe ser HTTP(S), sin credenciales en la URL');
    }
  } catch {
    return result(false, 'ENGINE_URL no es una URL válida');
  }
  const started = performance.now();
  try {
    // GET checks reachability without extracting anything. /extract may require POST.
    const response = await fetch(env.ENGINE_URL, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    const elapsed = Math.round(performance.now() - started);
    await response.body?.cancel().catch(() => {});
    const reachable = response.ok || response.status === 405;
    return result(reachable, 'HTTP ' + response.status + '; ' + elapsed + ' ms' +
      (response.status === 405 ? '; responde, pero no admite GET (endpoint POST)'
        : reachable ? '' : '; el motor devolvió un estado no satisfactorio'));
  } catch (error) {
    const elapsed = Math.round(performance.now() - started);
    const refused = error.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNREFUSED' ||
      error.cause?.errors?.some(item => item.code === 'ECONNREFUSED');
    return result(false, (refused ? 'el motor no está levantado (conexión rechazada)'
      : error.name === 'TimeoutError' ? 'el motor no responde (tiempo de espera agotado)'
        : 'el motor no está disponible; revisa conexión y configuración') + '; ' + elapsed + ' ms');
  }
}

async function portOwners() {
  // lsof is optional: no npm dependencies, shell, process arguments, or raw output.
  return new Promise(resolveOwners => {
    execFile(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof',
      ['-nP', '-a', '-iTCP:8080', '-sTCP:LISTEN', '-Fpc'],
      { encoding: 'utf8', timeout: 2_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        const owners = [];
        let current;
        for (const line of (stdout ?? '').split('\n')) {
          if (/^p\d+$/.test(line)) {
            current = { pid: line.slice(1) };
            owners.push(current);
          } else if (line.startsWith('c') && current) {
            current.name = display(line.slice(1));
          }
        }
        resolveOwners(owners.length ? owners.map(owner =>
          'PID ' + owner.pid + (owner.name ? ' (' + owner.name + ')' : '')).join(', ')
          : 'proceso no identificable (lsof no disponible o sin permisos)');
      });
  });
}

async function checkPort() {
  const code = await new Promise(resolveProbe => {
    const server = createServer();
    server.once('error', error => resolveProbe(error.code || 'BIND_ERROR'));
    server.listen({ host: '127.0.0.1', port: 8080, exclusive: true }, () => {
      server.close(error => resolveProbe(error ? 'CLOSE_ERROR' : null));
    });
  });
  if (code === null) return result(true, '127.0.0.1:8080 libre');
  if (code === 'EADDRINUSE') {
    return result(false, '127.0.0.1:8080 ocupado; ' + await portOwners());
  }
  return result(false, 'no se pudo comprobar 127.0.0.1:8080; revisa permisos locales');
}

async function checkActions() {
  let data;
  try {
    data = JSON.parse(await readFile(join(ROOT, 'web', 'actions.json'), 'utf8'));
  } catch (error) {
    return result(false, error.code === 'ENOENT' ? 'no existe'
      : error instanceof SyntaxError ? 'JSON no válido' : 'no se puede leer');
  }
  if (!Array.isArray(data?.actions)) return result(false, 'falta el array actions');
  const automatic = data.actions.filter(action => action?.auto_execute === true).length;
  const held = data.actions.filter(action => action?.auto_execute === false).length;
  const invalid = data.actions.length - automatic - held;
  return result(invalid === 0, 'total=' + data.actions.length + '; auto_execute=true: ' +
    automatic + '; auto_execute=false: ' + held + '; sin booleano válido: ' + invalid);
}

async function checkModules() {
  // Existence only: do not read, import, or start either module.
  const files = ['src/hold.mjs', 'src/bridge.mjs'];
  const states = await Promise.all(files.map(async file => {
    try {
      return (await stat(join(ROOT, file))).isFile();
    } catch {
      return false;
    }
  }));
  return result(states.every(Boolean), files.map((file, index) =>
    file + ': ' + (states[index] ? 'presente' : 'ausente o no accesible')).join('; '));
}

async function safeCheck(check) {
  try {
    return await check();
  } catch {
    return result(false, 'no se pudo completar la comprobación');
  }
}

async function main() {
  let passed = 0;
  const report = (label, check) => {
    if (check.ok) passed += 1;
    console.log((check.ok ? 'OK ' : 'FAIL ') + label + ': ' + check.detail);
  };
  report('.env', await safeCheck(checkEnv));
  const checks = [
    ['Telegram getMe', checkBot],
    ['Telegram getChat', checkChat],
    ['ENGINE_URL', checkEngine],
    ['Puerto 8080', checkPort],
    ['web/actions.json', checkActions],
    ['Módulos', checkModules],
  ];
  // Run independent checks together, but print one line per check in the requested order.
  const pending = checks.map(([, check]) => safeCheck(check));
  for (let index = 0; index < checks.length; index += 1) {
    report(checks[index][0], await pending[index]);
  }
  process.exitCode = passed === 7 ? 0 : 1;
  console.log((passed === 7 ? 'OK' : 'FAIL') + ' VEREDICTO: ' + passed +
    '/7 comprobaciones correctas' + (passed === 7 ? '; listo.' : '; revisa los FAIL.'));
}

void main().catch(() => {
  process.exitCode = 1;
  console.log('FAIL VEREDICTO: no se pudo completar el preflight.');
});
