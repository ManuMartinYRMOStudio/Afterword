// src/demo.mjs — ensayo del freno ante la cámara. Sin motor, sin puente, sin web.
//
//   cd /Users/yrmostudio/afterword && node src/demo.mjs
//
// 1. Manda UNA ficha fija (la del correo de la demo) al chat de TG_CHAT.
// 2. En el móvil: ✅ Aprobar → la ficha se edita en su sitio a APROBADO.
// 3. Para forzar el rechazo: ENTER en esta consola, o «/tamper a4» en el chat.
//    La ficha pasa a RECHAZADO con los dos hashes, y la consola los enseña.
//
// Lee TG_TOKEN y TG_CHAT del .env de la raíz del repo, a través de hold.mjs.

import { createHash } from 'node:crypto';
import { sendProposal, getStatus, startPolling, tamperTest } from './hold.mjs';

const ID = 'a4';

// La cadena canónica va literal, como la emitiría el motor, y su hash se
// calculó una sola vez a partir de ella. Se comprueba al arrancar.
const CANONICAL =
  '{"payload":{"body":"3% + VAT, 90 days exclusive, asking price approx. €329,000","subject":"Listing agreement — Ruzafa","to":"david.whitmore@example.com"},"type":"email"}';
const HASH = 'd5ccca115a92dfaa5da6418f91ad8c6b7dcd6c335e4221c96b33c60e90450ae2';

const ACTION = {
  id: ID,
  type: 'email',
  title: 'Send listing agreement to David Whitmore',
  summary: '3% + VAT, 90 days exclusive, approx. €329,000',
  payload: {
    to: 'david.whitmore@example.com',
    subject: 'Listing agreement — Ruzafa',
    body: '3% + VAT, 90 days exclusive, asking price approx. €329,000',
  },
  action_evidence: ['L03'],
  action_support: 'explicit',
  support: 'weak',
  confidence: 0.3,
  auto_execute: false,
  hold_reason: 'irreversible_type',
  canonical: CANONICAL,
  hash: HASH,
};

const say = (...parts) => console.log('[demo]', ...parts);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

if (createHash('sha256').update(CANONICAL, 'utf8').digest('hex') !== HASH) {
  console.error('[demo] La cadena literal y su hash no cuadran: no se manda nada. Revisa CANONICAL y HASH.');
  process.exit(1);
}

let stop = null;
const bye = (code) => {
  stop?.();
  process.exit(code);
};
process.on('SIGINT', () => {
  say('cortado.');
  bye(130);
});

try {
  stop = startPolling(); // antes de mandar la ficha, para no perder la pulsación
  await sendProposal(ACTION);
} catch (err) {
  console.error('[demo]', err?.message ?? err);
  if (/403/.test(String(err?.message))) {
    console.error('[demo] Un bot no puede escribir a quien no le ha escrito antes: abre el chat del bot en el móvil y pulsa Start.');
  }
  bye(1);
}

say('Ficha enviada. En el móvil: pulsa ✅ Aprobar (o ⛔ Retener).');

let status = 'pending';
while (status === 'pending') {
  await sleep(400);
  status = getStatus(ID);
}

if (status === 'refused') {
  say('Retenida desde el móvil. Fin.');
  bye(0);
}

say('APROBADO en el móvil: la ficha se ha editado en su sitio.');
say('Para forzar el rechazo: pulsa ENTER aquí, o escribe /tamper a4 en el chat del bot.');

const fromKeyboard = new Promise((resolve) => {
  if (!process.stdin.isTTY) return; // sin terminal, solo vale el comando del chat
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.once('data', () => resolve('teclado'));
});
const fromChat = (async () => {
  while (getStatus(ID) === 'approved') await sleep(400);
  return 'chat';
})();

const who = await Promise.race([fromKeyboard, fromChat]);
if (who === 'teclado') {
  await tamperTest(ID);
} else {
  say('Rechazo forzado desde el chat.');
}
say(`Estado final de ${ID}: ${getStatus(ID)}. Los dos hashes están en la ficha del móvil y en esta consola. Fin.`);
bye(0);
