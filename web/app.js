(function () {
  'use strict';

  var transcriptEl = document.getElementById('transcript');
  var runButton = document.getElementById('run-button');
  var workEl = document.getElementById('work');
  var emptyEl = document.getElementById('empty');
  var summaryEl = document.getElementById('summary');
  var sheetEl = document.querySelector('.sheet');
  var guardrailEl = document.getElementById('guardrail');
  var guardrailBadgeEl = document.getElementById('guardrail-badge');

  var guardrailOn = true;
  var dimEnabled = false;

  function setDim(on) {
    if (!sheetEl) return;
    sheetEl.classList.toggle('sheet--dim', dimEnabled && on);
  }

  if (sheetEl) {
    sheetEl.addEventListener('mouseenter', function () { setDim(false); });
    sheetEl.addEventListener('mouseleave', function () { setDim(true); });
  }

  function renderTranscript(turns) {
    transcriptEl.innerHTML = '';

    turns.forEach(function (turn) {
      var p = document.createElement('p');
      p.className = 'turn';
      p.id = 'turn-' + turn.id;
      p.setAttribute('data-turn-id', turn.id);

      var id = document.createElement('span');
      id.className = 'turn__id';
      id.textContent = turn.id;

      var body = document.createElement('span');
      body.className = 'turn__body';

      var speaker = document.createElement('span');
      speaker.className = 'turn__speaker';
      speaker.textContent = turn.speaker + ':';

      body.appendChild(speaker);
      body.appendChild(document.createTextNode(turn.text));

      p.appendChild(id);
      p.appendChild(body);
      transcriptEl.appendChild(p);
    });
  }

  function showTranscriptError(message) {
    transcriptEl.innerHTML = '';
    var p = document.createElement('p');
    p.className = 'transcript__status';
    p.textContent = message;
    transcriptEl.appendChild(p);
  }

  fetch('transcript.json')
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then(function (data) {
      renderTranscript(data.turns || []);
    })
    .catch(function () {
      showTranscriptError('Could not load transcript.json. Serve this folder over http (for example: python3 -m http.server).');
    });

  // ---------- actions ----------

  var statusInterval = null;

  function stopStatusPolling() {
    if (statusInterval !== null) {
      window.clearInterval(statusInterval);
      statusInterval = null;
    }
  }

  function startStatusPolling() {
    stopStatusPolling();
    if (!guardrailOn || !workEl.querySelector('li[data-action-id].card--held')) return;

    var interval = window.setInterval(function () {
      var cards = workEl.querySelectorAll('li[data-action-id].card--held');
      if (!guardrailOn || !cards.length) {
        stopStatusPolling();
        return;
      }

      Array.prototype.forEach.call(cards, function (card) {
        var id = card.getAttribute('data-action-id');
        fetch('/api/status/' + encodeURIComponent(id))
          .then(function (response) {
            if (!response.ok) return null;
            return response.json();
          })
          .then(function (status) {
            if (statusInterval !== interval || !guardrailOn ||
                !workEl.contains(card) || !card.classList.contains('card--held')) return;

            if (status === 'approved') {
              card.classList.remove('card--held');
              card.classList.add('card--done');
              card.querySelector('.card__icon').textContent = '\u2713';
              card.querySelector('.card__badge').textContent = 'DONE';
            } else if (status === 'refused') {
              card.classList.remove('card--held');
              card.classList.add('card--breach');
              card.querySelector('.card__badge').textContent = 'REFUSED';
            }

            if (!workEl.querySelector('li[data-action-id].card--held')) stopStatusPolling();
          })
          .catch(function () {
            // Leave the card held and retry on the next tick.
          });
      });
    }, 2000);
    statusInterval = interval;
  }

  var HOLD_REASON_TEXT = {
    irreversible_type: 'This cannot be undone',
    unknown_type: 'Unrecognised action — held by default',
    missing_required_parameter: 'A required value is missing'
  };

  var HOLD_REASON_FALLBACK = 'Held for your review';

  function holdReasonText(code) {
    return HOLD_REASON_TEXT[code] || HOLD_REASON_FALLBACK;
  }

  function weakParameters(parameterEvidence) {
    var weak = [];
    if (!parameterEvidence) return weak;
    Object.keys(parameterEvidence).forEach(function (name) {
      var entry = parameterEvidence[name];
      if (entry && entry.support === 'weak') weak.push(name);
    });
    return weak;
  }

  // With the guardrail off nothing is held, so a held card needs a word for
  // what already happened to it. Anything unlisted just reads DONE.
  var BREACH_BADGE = {
    email: 'SENT',
    listing_publish: 'PUBLISHED'
  };

  function buildCard(action, guardrail) {
    var done = guardrail ? action.auto_execute === true : true;
    var breach = !guardrail;

    var li = document.createElement('li');
    li.className = 'card ' + (breach ? 'card--breach' : (done ? 'card--done' : 'card--held'));
    li.setAttribute('data-action-id', action.id);

    var head = document.createElement('div');
    head.className = 'card__head';

    var icon = document.createElement('span');
    icon.className = 'card__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = done ? '\u2713' : '\u23F8';

    var text = document.createElement('div');
    text.className = 'card__text';

    var title = document.createElement('p');
    title.className = 'card__title';
    title.textContent = action.title || '';

    var summary = document.createElement('p');
    summary.className = 'card__summary';
    summary.textContent = action.summary || '';

    text.appendChild(title);
    text.appendChild(summary);

    var badge = document.createElement('span');
    badge.className = 'card__badge';
    if (breach) {
      badge.textContent = BREACH_BADGE[action.type] || 'DONE';
    } else {
      badge.textContent = done ? 'DONE' : 'WAITING FOR YOU';
    }

    head.appendChild(icon);
    head.appendChild(text);
    head.appendChild(badge);
    li.appendChild(head);

    weakParameters(action.parameter_evidence).forEach(function (name) {
      var weak = document.createElement('p');
      weak.className = 'card__weak';
      weak.textContent = name + ' \u2014 weakly supported';
      li.appendChild(weak);
    });

    if (!breach && !done) {
      var hold = document.createElement('p');
      hold.className = 'card__hold';
      hold.textContent = holdReasonText(action.hold_reason);
      li.appendChild(hold);
    }

    li.addEventListener('mouseenter', function () {
      setDim(false);
      highlightTurns(action.action_evidence);
    });
    li.addEventListener('mouseleave', function () {
      setDim(true);
      clearHighlight();
    });

    return li;
  }

  function resetWork() {
    workEl.innerHTML = '';
    summaryEl.innerHTML = '';
    runButton.classList.remove('run-button--used');
    dimEnabled = false;
    setDim(false);
    if (emptyEl) workEl.appendChild(emptyEl);
  }

  function highlightTurns(turnIds) {
    clearHighlight();
    if (!turnIds) return;
    turnIds.forEach(function (id) {
      var el = document.getElementById('turn-' + id);
      if (el) el.classList.add('turn--highlight');
    });
  }

  function clearHighlight() {
    var highlighted = transcriptEl.querySelectorAll('.turn--highlight');
    Array.prototype.forEach.call(highlighted, function (el) {
      el.classList.remove('turn--highlight');
    });
  }

  function buildCounter(actions, seconds, guardrail) {
    var total = actions.length;
    var done = actions.filter(function (a) { return a.auto_execute === true; }).length;
    var held = total - done;

    var p = document.createElement('p');
    p.className = 'counter';

    function number(value) {
      var n = document.createElement('span');
      n.className = 'counter__n';
      n.textContent = String(value);
      return n;
    }

    if (!guardrail) {
      p.className = 'counter counter--breach';
      p.appendChild(number(total));
      p.appendChild(document.createTextNode(' done. '));
      p.appendChild(number(0));
      p.appendChild(document.createTextNode(' waiting.'));

      var aftermath = document.createElement('span');
      aftermath.className = 'counter__aftermath';
      aftermath.textContent = 'A price nobody confirmed is now public.';
      p.appendChild(aftermath);

      return p;
    }

    p.appendChild(number(total));
    p.appendChild(document.createTextNode(total === 1 ? ' loose end. ' : ' loose ends. '));
    p.appendChild(number(done));
    p.appendChild(document.createTextNode(' done. '));
    p.appendChild(number(held));
    p.appendChild(document.createTextNode(held === 1 ? ' waiting on a human. ' : ' waiting on a human. '));

    var secs = document.createElement('span');
    secs.className = 'counter__seconds';
    secs.textContent = seconds + (seconds === 1 ? ' second.' : ' seconds.');
    p.appendChild(secs);

    return p;
  }

  function normalise(data) {
    if (Array.isArray(data)) {
      return { actions: data, seconds: 14 };
    }
    if (data && typeof data === 'object') {
      return {
        actions: Array.isArray(data.actions) ? data.actions : [],
        seconds: typeof data.seconds === 'number' ? data.seconds : 14
      };
    }
    return { actions: [], seconds: 14 };
  }

  function revealCards(actions, seconds, guardrail) {
    workEl.innerHTML = '';
    summaryEl.innerHTML = '';
    dimEnabled = true;
    setDim(true);

    var list = document.createElement('ul');
    list.className = 'work__list';
    workEl.appendChild(list);

    actions.forEach(function (action, index) {
      window.setTimeout(function () {
        list.appendChild(buildCard(action, guardrail));
      }, index * 400);
    });

    window.setTimeout(function () {
      summaryEl.appendChild(buildCounter(actions, seconds, guardrail));
      runButton.disabled = false;
      startStatusPolling();
    }, actions.length * 400);
  }

  function renderGuardrail() {
    guardrailEl.classList.toggle('guardrail--on', guardrailOn);
    guardrailEl.classList.toggle('guardrail--off', !guardrailOn);
    guardrailEl.setAttribute('aria-pressed', guardrailOn ? 'true' : 'false');
    guardrailBadgeEl.textContent = guardrailOn ? 'ON' : 'OFF';
  }

  guardrailEl.addEventListener('click', function () {
    stopStatusPolling();
    guardrailOn = !guardrailOn;
    renderGuardrail();
    clearHighlight();
    resetWork();
  });

  renderGuardrail();

  runButton.addEventListener('click', function () {
    stopStatusPolling();
    runButton.disabled = true;
    clearHighlight();
    resetWork();
    runButton.classList.add('run-button--used');

    fetch('actions.json')
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        var payload = normalise(data);
        revealCards(payload.actions, payload.seconds, guardrailOn);
      })
      .catch(function () {
        runButton.disabled = false;
        workEl.innerHTML = '';
        var p = document.createElement('p');
        p.className = 'transcript__status';
        p.textContent = 'Could not load actions.json.';
        workEl.appendChild(p);
      });
  });
})();
