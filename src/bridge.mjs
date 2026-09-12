import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
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

// Confirmed POST /extract contract.
export function buildExtractRequest(text, principal) {
  return { transcript: text, principal };
}


function validateSnapshot(value) {
  if (!value || !Object.hasOwn(value, 'transcript') || !Array.isArray(value.actions) ||
      value.actions.some(action => !action || typeof action.auto_execute !== 'boolean')) {
    throw new Error('Invalid snapshot: expected transcript and actions with boolean auto_execute');
  }
  return { transcript: value.transcript, actions: value.actions };
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
    return json(response, 400, { error: 'Invalid path' });
  }
  if (!pathname.startsWith('/') || pathname.includes('\0') ||
      pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) {
    return json(response, 403, { error: 'Access denied' });
  }

  if (pathname.startsWith('/api/')) {
    const match = /^\/api\/status\/([^/]+)$/.exec(pathname);
    if (!match) return json(response, 404, { error: 'Route not found' });
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      return json(response, 405, { error: 'Method not allowed' });
    }
    // actions.json can expose an ID before sendProposal registers it.
    // Unknown IDs return 404; never invent a pending status.
    const status = await getStatus(match[1]);
    return status == null
      ? json(response, 404, { error: 'Proposal not found' })
      : json(response, 200, status);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return json(response, 405, { error: 'Method not allowed' });
  }

  try {
    const root = await realpath(WEB);
    let path = await realpath(resolve(root, '.' + pathname));
    if (!inside(root, path)) return json(response, 403, { error: 'Access denied' });
    let info = await stat(path);
    if (info.isDirectory()) {
      path = await realpath(join(path, 'index.html'));
      if (!inside(root, path)) return json(response, 403, { error: 'Access denied' });
      info = await stat(path);
    }
    if (!info.isFile()) return json(response, 404, { error: 'File not found' });

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
      return json(response, 404, { error: 'File not found' });
    }
    if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'ELOOP') {
      return json(response, 403, { error: 'Access denied' });
    }
    throw error;
  }
}

async function extract(url, text, principal, signal) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    if (signal.aborted) return null;
    console.log('[engine] Attempt ' + attempt + '/6');
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(buildExtractRequest(text, principal)),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('HTTP ' + response.status);
      }
      return validateSnapshot(await response.json());
    } catch (error) {
      if (signal.aborted) return null;
      // Do not print response bodies, configuration values, or Telegram credentials.
      const reason = error.name === 'TimeoutError' ? 'request timed out'
        : error.message.startsWith('HTTP ') ? error.message : 'response unavailable or invalid';
      console.error('[engine] Attempt ' + attempt + '/6 failed: ' + reason);
      if (attempt < 6) await delay(2_000, undefined, { signal }).catch(() => {});
    }
  }
  return null;
}

function manualFallback() {
  console.error('The web server is still available. You can write web/actions.json manually as { transcript, actions }.');
}


function startCommands({ proposalIds, getStatus, tamperTest, shutdown, signal, secrets }) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const help = 'Commands: tamper <id> | list | quit';
  let tampering = false;
  const display = value => {
    let text = String(value);
    for (const secret of secrets) text = text.split(secret).join('[redacted]');
    return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  };
  console.log(help);

  async function command(line) {
    if (signal.aborted) return;
    const words = line.trim().split(/\s+/);
    const [verb, id] = words;
    if (!verb) return;
    if (verb === 'quit' && words.length === 1) {
      shutdown();
      return;
    }
    if (verb === 'list' && words.length === 1) {
      let count = 0;
      for (const proposalId of proposalIds) {
        const status = await getStatus(proposalId);
        if (signal.aborted) return;
        // A rejected send may never have registered a proposal in hold.mjs.
        if (status == null) continue;
        console.log(display(proposalId) + ': ' + display(status));
        count += 1;
      }
      if (count === 0) console.log('No proposals yet.');
      return;
    }
    if (verb === 'tamper') {
      if (words.length !== 2) {
        console.log('Usage: tamper <id>');
        return;
      }
      if (tampering) {
        console.log('A tamper test is already running. You can still use list or quit.');
        return;
      }
      tampering = true;
      try {
        const result = await tamperTest(id);
        if (signal.aborted) return;
        // Show the verdict and both hashes, never the returned canonical payloads.
        console.log('Tamper ' + display(id) + ': ' + display(result.status));
        console.log('Expected hash: ' + display(result.expected));
        console.log('Actual hash: ' + display(result.actual));
      } catch {
        if (!signal.aborted) console.error('Tamper test failed. Check the proposal ID and Telegram connection.');
      } finally {
        tampering = false;
      }
      return;
    }
    console.log('Unknown command. ' + help);
  }

  // Independent handlers keep quit responsive during a slow Telegram request.
  input.on('line', line => {
    void command(line).catch(() => {
      if (!signal.aborted) console.error('Unable to run the command. Try again or type quit.');
    });
  });
  input.on('SIGINT', shutdown);
  return input;
}

async function main() {
  let env;
  try {
    env = parseEnv(await readFile(join(ROOT, '.env'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error('Missing .env in the AfterWord root. Create it with TG_TOKEN, TG_CHAT, ENGINE_URL and PRINCIPAL; TRANSCRIPT_PATH is optional.');
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
      if (!response.headersSent) json(response, 500, { error: 'Unable to handle the request' });
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
  server.on('error', () => console.error('Local HTTP server error.'));
  console.log('AfterWord is available at http://127.0.0.1:8080');
  // README must also state this; the bridge only simulates execution by logging.
  console.log('Demo mode: [executed] only logs the action; it does not execute tasks or send emails.');
  const controller = new AbortController();
  const proposalIds = new Set();
  let stopPolling;
  let input;
  let processing = Promise.resolve();
  const shutdown = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    input?.close();
    process.stdin.pause();
    try {
      stopPolling?.();
    } catch {
      console.error('Unable to stop Telegram polling.');
    }
    console.log('Shutting down AfterWord.');
    process.exitCode = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      process.exit(0);
    };
    // hold.mjs has no cancellation argument for sendProposal or tamperTest.
    // Allow current file work to finish, but never wait indefinitely for Telegram.
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, 1_000);
    server.close(() => { void processing.then(finish, finish); });
  };
  // Start polling once before any proposal can expose buttons in Telegram.
  try {
    stopPolling = startPolling();
  } catch {
    console.error('Unable to start Telegram polling.');
  }
  const secrets = Object.values(env).filter(Boolean).sort((a, b) => b.length - a.length);
  input = startCommands({ proposalIds, getStatus, tamperTest, shutdown, signal: controller.signal, secrets });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const sendTrackedProposal = action => {
    if (typeof action.id === 'string') proposalIds.add(action.id);
    return sendProposal(action);
  };
  processing = processTranscript(env, sendTrackedProposal, controller.signal);
  await processing;
}

async function readEngineResult(env, signal) {
  const transcriptPath = resolve(ROOT, env.TRANSCRIPT_PATH || 'web/sample.txt');
  let text;
  try {
    text = await readFile(transcriptPath, 'utf8');
  } catch (error) {
    if (signal.aborted) return;
    console.error(error.code === 'ENOENT'
      ? 'Missing transcript: ' + transcriptPath + '. Check TRANSCRIPT_PATH in .env.'
      : 'Unable to read the transcript. Check TRANSCRIPT_PATH and file permissions.');
    return null;
  }
  if (signal.aborted) return;
  if (!env.PRINCIPAL?.trim()) {
    console.error('Missing PRINCIPAL in .env. Set the speaker name.');
    return null;
  }
  try {
    const url = new URL(env.ENGINE_URL);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Protocol');
  } catch {
    console.error('ENGINE_URL in .env must be an HTTP(S) URL for the /extract endpoint.');
    return null;
  }

  const result = await extract(env.ENGINE_URL, text, env.PRINCIPAL, signal);
  if (signal.aborted) return;
  if (!result) {
    console.error('The engine failed on all six attempts.');
    return null;
  }

  return result;
}

async function processTranscript(env, sendProposal, signal) {
  let result = await readEngineResult(env, signal);
  if (signal.aborted) return;

  if (result) {
    try {
      await mkdir(WEB, { recursive: true });
      if (signal.aborted) return;
      // Persist the FULL engine result before logging or proposing any action.
      // JSON serialization is only transport/storage; no canonicalization or hashing occurs here.
      await writeFile(join(WEB, 'actions.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
    } catch {
      if (signal.aborted) return;
      console.error('Unable to save web/actions.json. No actions have been processed.');
      manualFallback();
      return;
    }
  } else {
    try {
      const saved = await readFile(join(WEB, 'actions.json'), 'utf8');
      if (signal.aborted) return;
      result = validateSnapshot(JSON.parse(saved));
    } catch {
      if (signal.aborted) return;
      console.error('No engine result or usable web/actions.json is available. The web server is still running; write web/actions.json manually.');
      return;
    }
    console.log('Running from web/actions.json, not from the engine.');
  }

  for (const action of result.actions) {
    if (signal.aborted) return;
    if (action.auto_execute === true) {
      console.log('[executed] ' + action.title);
    } else if (action.auto_execute === false) {
      try {
        await sendProposal(action);
      } catch {
        if (!signal.aborted) {
          console.error('Unable to send a Telegram proposal. The web server is still running; use the page approval fallback.');
        }
      }
    }
  }
}

void main().catch(error => {
  console.error(error.code === 'EADDRINUSE'
    ? 'Unable to start AfterWord: 127.0.0.1:8080 is already in use.'
    : 'Unable to start AfterWord. Check .env and the availability of src/hold.mjs.');
  process.exitCode = 1;
});
