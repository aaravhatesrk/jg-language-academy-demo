(function () {
  var cfg = window.SUPPORT_CHAT_CONFIG || {};
  var WEBHOOK_URL = cfg.webhookUrl || 'http://localhost:5678/webhook/support-chat';
  var API_KEY_HEADER = cfg.apiKeyHeader || 'X-Api-Key';
  var API_KEY = cfg.apiKey || '';
  var CLIENT_ID = cfg.clientId || '';
  var BOT_NAME = cfg.botName || 'Support Assistant';
  var BRAND_NAME = cfg.brandName || BOT_NAME;
  var SITE_LABEL = cfg.siteLabel || '';
  var PRIVACY_URL = cfg.privacyUrl || '';
  var WHATSAPP_URL = cfg.whatsappUrl || '';
  var SUPPORT_PHONE = cfg.supportPhone || '';
  // Derive the feedback endpoint from the chat webhook so it always hits the same
  // reachable host (e.g. tunnel/VPS), turning any '…-chat' path into '…-feedback'.
  // e.g. /webhook/flowforge-chat → /webhook/flowforge-feedback,
  //      /webhook/support-chat   → /webhook/support-feedback.
  var FEEDBACK_URL = cfg.feedbackUrl || WEBHOOK_URL.replace(/-chat(\/?(?:\?.*)?)$/, '-feedback$1');
  var FEEDBACK_DONE_KEY = 'supportChatFeedbackDone';
  var FEEDBACK_IDLE_MS = 30000; // show the "was this helpful?" prompt once the chat has been idle this long
  var feedbackTimer = null;
  var ACCENT = cfg.accentColor || '#0f766e';
  var ACCENT_LIGHT = cfg.accentColorLight || '#14b8a6';
  var GREETING = cfg.greeting || "Hi! I'm " + BOT_NAME + ". Ask me anything.";
  var PRESET_QUESTIONS = cfg.presetQuestions || [];
  // Suggestion chips shown after EVERY bot reply when the backend doesn't return
  // its own quickReplies — so nudges like "Book a demo" keep appearing instead of
  // vanishing after the first message. Defaults to the preset questions.
  var FOLLOWUP_QUESTIONS = cfg.followUpQuestions || PRESET_QUESTIONS;
  var SESSION_KEY = 'supportChatSessionId';
  var TRANSCRIPT_KEY = 'supportChatTranscript';
  var LAST_ACTIVITY_KEY = 'supportChatLastActivity';
  var SESSION_TTL_MS = 15 * 60 * 1000; // start a fresh conversation after 15 min of inactivity
  // Per-tab storage: the conversation survives navigating from page to page, and
  // clears when the visitor closes the site tab. Falls back to in-memory if
  // sessionStorage is blocked (e.g. strict privacy mode).
  var store = (function () {
    try {
      var s = window.sessionStorage;
      s.setItem('__sc_probe', '1'); s.removeItem('__sc_probe');
      return s;
    } catch (e) {
      var mem = {};
      return {
        getItem: function (k) { return k in mem ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; }
      };
    }
  })();

  // Friendly chatbot/robot icon (white, so it reads on the accent-gradient
  // launcher, header logo and avatar). NOTE: keep the literal `width="24"
  // height="24"` — the launcher swaps it to 28 via string replace.
  var DEFAULT_LOGO_SVG =
    '<svg viewBox="0 0 40 40" width="24" height="24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<circle cx="20" cy="6" r="1.9" fill="#fff"/>' +
    '<path d="M20 7.9v3.1" stroke="#fff" stroke-width="2" stroke-linecap="round"/>' +
    '<rect x="9.5" y="11" width="21" height="16" rx="5.5" stroke="#fff" stroke-width="2.2"/>' +
    '<path d="M9.5 17.5H7.2M30.5 17.5H32.8" stroke="#fff" stroke-width="2" stroke-linecap="round"/>' +
    '<circle cx="16" cy="18.6" r="1.9" fill="#fff"/>' +
    '<circle cx="24" cy="18.6" r="1.9" fill="#fff"/>' +
    '<path d="M16.5 23h7" stroke="#fff" stroke-width="2" stroke-linecap="round"/>' +
    '</svg>';
  var LOGO_SVG = cfg.logoSvg || DEFAULT_LOGO_SVG;
  // Company-logo support: `logoImg` is a URL/data-URI raster mark (e.g. JG's
  // bubble), `logoSvg` an inline vector mark (e.g. FlowForge's F). Full-colour
  // brand marks get a white backing chip via `logoOnWhite` so they read on the
  // accent-gradient launcher/avatar (auto-on whenever a logoImg is supplied).
  var LOGO_IMG = cfg.logoImg || '';
  var LOGO_ON_WHITE = cfg.logoOnWhite || !!LOGO_IMG;
  function logoHtml() {
    return LOGO_IMG
      ? '<img class="sc-logo-img" src="' + LOGO_IMG + '" alt="" />'
      : LOGO_SVG;
  }
  var TEASER_TEXT = cfg.teaserText || "Have a question? Ask " + BOT_NAME + "!";
  var TEASER_DELAY_MS = cfg.teaserDelayMs != null ? cfg.teaserDelayMs : 2200;
  var TEASER_SESSION_KEY = 'supportChatTeaserShown';
  // Lift the launcher/panel above any fixed bottom bar the host site has
  // (e.g. JG's Enroll Now / WhatsApp buttons). Configurable via launcherBottom.
  var LAUNCHER_BOTTOM = cfg.launcherBottom != null ? cfg.launcherBottom : 20;
  var PANEL_BOTTOM = LAUNCHER_BOTTOM + 72;

  function hexToRgb(hex) {
    var h = (hex || '').replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var num = parseInt(h, 16);
    if (isNaN(num)) return '15, 118, 110';
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255].join(', ');
  }
  var ACCENT_RGB = hexToRgb(ACCENT);

  function newId() { return 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9); }
  function isExpired() {
    var la = parseInt(store.getItem(LAST_ACTIVITY_KEY) || '0', 10);
    return !la || (Date.now() - la > SESSION_TTL_MS);
  }
  function touchActivity() { store.setItem(LAST_ACTIVITY_KEY, String(Date.now())); }
  function resetSession() {
    store.removeItem(TRANSCRIPT_KEY);
    store.removeItem(FEEDBACK_DONE_KEY);
    store.setItem(SESSION_KEY, newId());
    touchActivity();
  }
  function getSessionId() {
    if (isExpired()) resetSession(); // fresh conversation + backend memory after 15 min idle
    var id = store.getItem(SESSION_KEY);
    if (!id) { id = newId(); store.setItem(SESSION_KEY, id); }
    return id;
  }
  function loadTranscript() {
    try { return JSON.parse(store.getItem(TRANSCRIPT_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveMessage(who, text) {
    var t = loadTranscript();
    t.push({ who: who, text: text });
    if (t.length > 40) t = t.slice(t.length - 40); // cap stored history
    store.setItem(TRANSCRIPT_KEY, JSON.stringify(t));
    touchActivity();
  }

  // --- Minimal, XSS-safe Markdown rendering for bot replies ---
  // HTML is escaped FIRST, then a small subset of Markdown (bold, italic,
  // inline code, links, bullet/numbered lists) is turned into safe tags.
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function renderInline(s) {
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+|tel:[^\s)]+)\)/g,
      function (m, t, u) {
        // Encode quotes so a URL can never break out of the href="" attribute.
        var safeU = u.replace(/"/g, '%22').replace(/'/g, '%27');
        return '<a href="' + safeU + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
      });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    return s;
  }
  function renderMarkdown(md) {
    var lines = escapeHtml(md).split(/\r?\n/);
    var out = '', inList = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
      if (m) {
        if (!inList) { out += '<ul>'; inList = true; }
        out += '<li>' + renderInline(m[1]) + '</li>';
      } else {
        if (inList) { out += '</ul>'; inList = false; }
        if (line.trim() === '') { out += '<br>'; } else { out += renderInline(line) + '<br>'; }
      }
    }
    if (inList) out += '</ul>';
    return out
      .replace(/(<br>)+$/, '')
      .replace(/(<br>)+(<ul>)/g, '$2')
      .replace(/(<\/ul>)(<br>)+/g, '$1');
  }

  var style = document.createElement('style');
  style.textContent = `
    .sc-launcher {
      position: fixed; bottom: ${LAUNCHER_BOTTOM}px; right: 20px; width: 60px; height: 60px;
      border-radius: 50%; background: linear-gradient(135deg, ${ACCENT}, ${ACCENT_LIGHT}); color: #fff; border: none;
      box-shadow: 0 6px 18px rgba(0,0,0,.28); cursor: pointer; z-index: 999999;
      display: flex; align-items: center; justify-content: center; font-size: 26px;
      transition: transform .15s ease;
      animation: sc-pulse-ring 2.4s ease-out infinite;
    }
    .sc-launcher:hover { transform: scale(1.06); }
    .sc-launcher.sc-launcher-quiet { animation: none; }
    @keyframes sc-pulse-ring {
      0% { box-shadow: 0 6px 18px rgba(0,0,0,.28), 0 0 0 0 rgba(${ACCENT_RGB}, .45); }
      70% { box-shadow: 0 6px 18px rgba(0,0,0,.28), 0 0 0 16px rgba(${ACCENT_RGB}, 0); }
      100% { box-shadow: 0 6px 18px rgba(0,0,0,.28), 0 0 0 0 rgba(${ACCENT_RGB}, 0); }
    }
    .sc-launcher-badge {
      position: absolute; top: -2px; right: -2px; width: 14px; height: 14px; border-radius: 50%;
      background: #22c55e; border: 2px solid #fff;
    }
    .sc-teaser {
      position: fixed; bottom: ${PANEL_BOTTOM}px; right: 20px; max-width: 230px;
      background: #fff; color: #1f2430; padding: 12px 30px 12px 14px; border-radius: 14px;
      border-bottom-right-radius: 4px; box-shadow: 0 8px 26px rgba(0,0,0,.2); font-size: 13.5px;
      line-height: 1.4; z-index: 999998; cursor: pointer; animation: sc-teaser-in .25s ease-out;
    }
    .sc-teaser-close {
      position: absolute; top: 4px; right: 6px; background: none; border: none; color: #99a3a3;
      font-size: 15px; cursor: pointer; line-height: 1; padding: 5px;
    }
    .sc-teaser-close:hover { color: #667; }
    @keyframes sc-teaser-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @media (max-width: 480px) {
      .sc-teaser { right: 16px; bottom: ${PANEL_BOTTOM}px; max-width: calc(100vw - 90px); }
    }
    .sc-panel {
      position: fixed; bottom: 24px; right: 20px; width: 380px; max-width: calc(100vw - 32px);
      height: 560px; max-height: calc(100vh - 48px); background: #fff; border-radius: 16px;
      box-shadow: 0 12px 44px rgba(0,0,0,.28); display: none; flex-direction: column;
      overflow: hidden; z-index: 999999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .sc-panel.sc-open { display: flex; }
    .sc-header {
      background: linear-gradient(135deg, ${ACCENT}, ${ACCENT_LIGHT}); color: #fff; padding: 16px 18px; display: flex;
      align-items: center; justify-content: space-between; flex-shrink: 0; gap: 10px;
    }
    .sc-header-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .sc-header-logo {
      width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,0.12);
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .sc-header-text { min-width: 0; }
    .sc-header-title { font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 6px; }
    .sc-header-online-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; display: inline-block; flex-shrink: 0; }
    .sc-header-sub { font-size: 12px; opacity: .88; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sc-header-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .sc-close, .sc-restart { background: rgba(255,255,255,0.15); border: none; color: #fff; font-size: 18px; cursor: pointer; line-height: 1; padding: 6px 10px; border-radius: 8px; flex-shrink: 0; }
    .sc-close:hover, .sc-restart:hover { background: rgba(255,255,255,0.28); }
    .sc-restart { font-size: 15px; }
    .sc-messages {
      flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 4px;
      background: #f6f8f8;
    }
    .sc-row { display: flex; align-items: flex-end; gap: 8px; margin-bottom: 6px; }
    .sc-row.user { justify-content: flex-end; }
    .sc-avatar {
      width: 24px; height: 24px; border-radius: 50%; background: linear-gradient(135deg, ${ACCENT}, ${ACCENT_LIGHT});
      display: flex; align-items: center; justify-content: center; flex-shrink: 0; overflow: hidden;
    }
    .sc-avatar svg { width: 16px; height: 16px; }
    .sc-launcher svg { width: 28px; height: 28px; }
    .sc-logo-img { width: 100%; height: 100%; object-fit: contain; display: block; }
    /* Company-logo "on white chip" treatment (full-colour brand marks) */
    .sc-launcher.sc-logo-white { background: #fff; border: 1px solid rgba(0,0,0,.08); }
    .sc-launcher.sc-logo-white svg, .sc-launcher.sc-logo-white .sc-logo-img { width: 66%; height: 66%; }
    .sc-panel.sc-logo-white .sc-header-logo { background: #fff; padding: 4px; }
    .sc-panel.sc-logo-white .sc-header-logo svg, .sc-panel.sc-logo-white .sc-header-logo .sc-logo-img { width: 100%; height: 100%; }
    .sc-panel.sc-logo-white .sc-avatar { background: #fff; border: 1px solid rgba(0,0,0,.08); }
    .sc-panel.sc-logo-white .sc-avatar svg, .sc-panel.sc-logo-white .sc-avatar .sc-logo-img { width: 82%; height: 82%; }
    .sc-msg { max-width: 78%; padding: 9px 13px; border-radius: 14px; font-size: 14px; line-height: 1.45; white-space: pre-wrap; }
    .sc-msg.bot { background: #fff; color: #1f2430; border-bottom-left-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,.09); white-space: normal; }
    .sc-msg.bot ul { margin: 4px 0; padding-left: 18px; }
    .sc-msg.bot li { margin: 2px 0; }
    .sc-msg.bot a { color: ${ACCENT}; text-decoration: underline; }
    .sc-msg.bot code { background: #eef1f6; padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
    .sc-msg.bot strong { font-weight: 700; }
    .sc-cursor { opacity: .45; font-weight: 400; }
    .sc-msg.user { background: linear-gradient(135deg, ${ACCENT}, ${ACCENT_LIGHT}); color: #fff; border-bottom-right-radius: 4px; }
    .sc-msg.typing { background: #fff; color: #999; font-style: italic; }
    .sc-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 10px 32px; }
    .sc-chips.sc-chips-start { margin-left: 0; }
    .sc-chip {
      background: #fff; border: 1.5px solid ${ACCENT}; color: ${ACCENT}; border-radius: 16px;
      padding: 6px 12px; font-size: 12.5px; cursor: pointer; font-family: inherit; white-space: nowrap;
      transition: background .12s ease, color .12s ease;
    }
    .sc-chip:hover { background: ${ACCENT}; color: #fff; }
    .sc-input-row { display: flex; padding: 10px; border-top: 1px solid #eee; gap: 8px; flex-shrink: 0; background: #fff; }
    .sc-input {
      flex: 1; border: 1px solid #ddd; border-radius: 20px; padding: 9px 14px; font-size: 14px;
      outline: none; font-family: inherit;
    }
    .sc-input:focus { border-color: ${ACCENT}; }
    .sc-send {
      background: linear-gradient(135deg, ${ACCENT}, ${ACCENT_LIGHT}); color: #fff; border: none; border-radius: 50%; width: 38px; height: 38px;
      flex-shrink: 0; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center;
    }
    .sc-send:disabled { opacity: .5; cursor: default; }
    .sc-footer {
      text-align: center; font-size: 11px; color: #6b7280; padding: 6px 0 10px; flex-shrink: 0; background: #fff;
    }
    .sc-footer a { color: inherit; text-decoration: underline; }
    .sc-feedback { display: flex; align-items: center; gap: 4px; margin: 0 0 8px 32px; font-size: 12px; color: #6b7280; }
    .sc-fb-btn { background: none; border: none; cursor: pointer; font-size: 15px; padding: 2px 5px; border-radius: 6px; line-height: 1; opacity: .7; }
    .sc-fb-btn:hover { opacity: 1; background: #eef1f6; }
    .sc-fb-btn:disabled { cursor: default; opacity: 1; }
    .sc-fb-chosen { background: #e8f0ff; }
    @media (max-width: 480px) {
      /* dvh keeps the composer above the phone browser's collapsing toolbar;
         the vh line stays first as the fallback for older mobile browsers. */
      .sc-panel { right: 0; bottom: 0; width: 100vw; height: 100vh; max-height: 100vh; border-radius: 0; }
      .sc-panel { height: 100dvh; max-height: 100dvh; }
      .sc-footer { padding-bottom: calc(10px + env(safe-area-inset-bottom)); }
      .sc-launcher { bottom: ${LAUNCHER_BOTTOM}px; right: 16px; }
    }
  `;
  document.head.appendChild(style);

  var launcher = document.createElement('button');
  launcher.className = 'sc-launcher';
  launcher.setAttribute('aria-label', 'Open chat');
  launcher.setAttribute('aria-expanded', 'false');
  launcher.innerHTML = logoHtml() + '<span class="sc-launcher-badge"></span>';
  if (LOGO_ON_WHITE) launcher.classList.add('sc-logo-white');

  var panel = document.createElement('div');
  panel.className = 'sc-panel';
  panel.innerHTML =
    '<div class="sc-header">' +
      '<div class="sc-header-left">' +
        '<div class="sc-header-logo">' + logoHtml() + '</div>' +
        '<div class="sc-header-text">' +
          '<div class="sc-header-title">' + BOT_NAME + '<span class="sc-header-online-dot"></span></div>' +
          '<div class="sc-header-sub">' + BRAND_NAME + (SITE_LABEL ? ' &middot; ' + SITE_LABEL : '') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="sc-header-actions">' +
        '<button class="sc-restart" type="button" aria-label="Restart chat" title="Start a new conversation">&#8635;</button>' +
        '<button class="sc-close" aria-label="Close chat">&times;</button>' +
      '</div>' +
    '</div>' +
    '<div class="sc-messages" role="log" aria-live="polite" aria-atomic="false"></div>' +
    '<div class="sc-input-row">' +
      '<input class="sc-input" type="text" aria-label="Type your question" placeholder="Type your question..." />' +
      '<button class="sc-send" aria-label="Send">&#10148;</button>' +
    '</div>' +
    '<div class="sc-footer">Powered by ' + BRAND_NAME + (PRIVACY_URL ? ' &middot; <a href="' + PRIVACY_URL + '" target="_blank" rel="noopener noreferrer">Privacy</a>' : '') + (WHATSAPP_URL ? ' &middot; <a href="' + WHATSAPP_URL + '" target="_blank" rel="noopener noreferrer">Talk to a human</a>' : '') + '</div>';

  if (LOGO_ON_WHITE) panel.classList.add('sc-logo-white');

  document.body.appendChild(launcher);
  document.body.appendChild(panel);

  var messagesEl = panel.querySelector('.sc-messages');
  var inputEl = panel.querySelector('.sc-input');
  var sendBtn = panel.querySelector('.sc-send');
  var closeBtn = panel.querySelector('.sc-close');
  var restartBtn = panel.querySelector('.sc-restart');

  function addMessage(text, who) {
    var row = document.createElement('div');
    row.className = 'sc-row ' + who;
    if (who === 'bot') {
      var avatar = document.createElement('div');
      avatar.className = 'sc-avatar';
      avatar.innerHTML = logoHtml();
      row.appendChild(avatar);
    }
    var el = document.createElement('div');
    el.className = 'sc-msg ' + who;
    if (who === 'bot') { el.innerHTML = renderMarkdown(text); } else { el.textContent = text; }
    row.appendChild(el);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  }

  // Reveals bot replies at a fixed, moderate pace instead of dumping the full
  // text at once (which used to force-scroll the panel straight to the bottom).
  // ~110 chars/sec regardless of length, so long replies just take longer.
  function addMessageTyped(text, onDone) {
    var row = document.createElement('div');
    row.className = 'sc-row bot';
    var avatar = document.createElement('div');
    avatar.className = 'sc-avatar';
    avatar.innerHTML = logoHtml();
    row.appendChild(avatar);
    var el = document.createElement('div');
    el.className = 'sc-msg bot';
    row.appendChild(el);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    var CHARS_PER_TICK = 2;
    var TICK_MS = 18;
    var i = 0;

    function tick() {
      var pin = isNearBottom();
      i = Math.min(text.length, i + CHARS_PER_TICK);
      // Render the Markdown of the text revealed so far, so formatting appears
      // progressively as it types — no sudden reformat/jump at the end.
      el.innerHTML = renderMarkdown(text.slice(0, i)) + (i < text.length ? '<span class="sc-cursor">▌</span>' : '');
      if (pin) messagesEl.scrollTop = messagesEl.scrollHeight;
      if (i < text.length) {
        setTimeout(tick, TICK_MS);
      } else {
        if (isNearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
        if (onDone) onDone();
      }
    }
    tick();
    return el;
  }

  function addChips(options, isStart, isFollowup) {
    if (!options || !options.length) return;
    // Only ever keep the latest follow-up suggestion row so repeated fallbacks
    // don't stack up down the transcript.
    if (isFollowup) {
      Array.prototype.forEach.call(
        messagesEl.querySelectorAll('.sc-chips-followup'),
        function (n) { n.remove(); }
      );
    }
    var wrap = document.createElement('div');
    wrap.className = 'sc-chips' + (isStart ? ' sc-chips-start' : '') + (isFollowup ? ' sc-chips-followup' : '');
    options.forEach(function (label) {
      var chip = document.createElement('button');
      chip.className = 'sc-chip';
      chip.type = 'button';
      chip.textContent = label;
      chip.addEventListener('click', function () {
        wrap.remove();
        sendMessage(label);
      });
      wrap.appendChild(chip);
    });
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Offers a one-tap retry after a failed/timed-out send, re-sending the same text.
  function addRetry(text) {
    var wrap = document.createElement('div');
    wrap.className = 'sc-chips';
    var chip = document.createElement('button');
    chip.className = 'sc-chip'; chip.type = 'button'; chip.textContent = '↻ Try again';
    chip.addEventListener('click', function () { wrap.remove(); sendMessage(text); });
    wrap.appendChild(chip);
    messagesEl.appendChild(wrap);
    if (isNearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // End-of-conversation feedback: ONE "was this helpful?" prompt, shown only once
  // the chat has gone idle (not after every reply). POSTed to the feedback endpoint.
  function showEndFeedback() {
    if (!FEEDBACK_URL || !opened) return;
    if (store.getItem(FEEDBACK_DONE_KEY)) return;
    store.setItem(FEEDBACK_DONE_KEY, '1');
    var wrap = document.createElement('div');
    wrap.className = 'sc-feedback';
    var q = document.createElement('span');
    q.className = 'sc-fb-q';
    q.textContent = 'Was this conversation helpful?';
    var up = document.createElement('button');
    up.className = 'sc-fb-btn'; up.type = 'button'; up.textContent = '👍'; up.setAttribute('aria-label', 'Helpful');
    var down = document.createElement('button');
    down.className = 'sc-fb-btn'; down.type = 'button'; down.textContent = '👎'; down.setAttribute('aria-label', 'Not helpful');
    function send(rating, chosenBtn, otherBtn) {
      up.disabled = down.disabled = true;
      otherBtn.style.display = 'none';
      chosenBtn.classList.add('sc-fb-chosen');
      q.textContent = 'Thanks for your feedback!';
      try {
        var headers = { 'Content-Type': 'application/json' };
        if (API_KEY) headers[API_KEY_HEADER] = API_KEY;
        fetch(FEEDBACK_URL, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ feedback: rating, reply: 'end-of-conversation', sessionId: getSessionId(), clientId: CLIENT_ID })
        }).catch(function () {});
      } catch (e) {}
    }
    up.addEventListener('click', function () { send('up', up, down); });
    down.addEventListener('click', function () { send('down', down, up); });
    wrap.appendChild(q); wrap.appendChild(up); wrap.appendChild(down);
    messagesEl.appendChild(wrap);
    if (isNearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // (Re)start the idle timer that reveals the end-of-conversation feedback prompt.
  function scheduleFeedback() {
    if (!FEEDBACK_URL || store.getItem(FEEDBACK_DONE_KEY)) return;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(showEndFeedback, FEEDBACK_IDLE_MS);
  }
  function cancelFeedbackTimer() {
    if (feedbackTimer) { clearTimeout(feedbackTimer); feedbackTimer = null; }
  }

  function removeTeaser() {
    var teaser = document.querySelector('.sc-teaser');
    if (teaser) teaser.remove();
  }

  var opened = false;
  var hadConversation = false; // set once the visitor has actually sent a message
  var inFlight = false; // guards against overlapping requests (rapid Enter / chip taps)
  function toggle() {
    opened = !opened;
    panel.classList.toggle('sc-open', opened);
    launcher.setAttribute('aria-expanded', opened ? 'true' : 'false');
    launcher.classList.add('sc-launcher-quiet');
    removeTeaser();
    if (opened && !messagesEl.childElementCount) {
      if (isExpired()) resetSession();
      var saved = loadTranscript();
      if (saved && saved.length) {
        // Restore the ongoing conversation (bot messages re-render Markdown).
        saved.forEach(function (m) { addMessage(m.text, m.who); });
      } else {
        addMessage(GREETING, 'bot');
        addChips(PRESET_QUESTIONS, true);
        saveMessage('bot', GREETING);
      }
    }
    if (opened) inputEl.focus();
  }

  // Clears the current conversation (and backend memory, via a fresh session id)
  // and starts over with the greeting + preset questions.
  function restartChat() {
    if (inFlight) return;
    cancelFeedbackTimer();
    resetSession();
    messagesEl.innerHTML = '';
    addMessage(GREETING, 'bot');
    addChips(PRESET_QUESTIONS, true);
    saveMessage('bot', GREETING);
    inputEl.focus();
  }

  // Closing the panel = end of conversation. The first time a visitor closes
  // after actually chatting, surface the "was this helpful?" prompt inline and
  // keep the panel open; showEndFeedback() marks it done, so the next × closes
  // normally. Idle (30s) still triggers it too, whichever comes first.
  function handleClose() {
    if (opened && hadConversation && FEEDBACK_URL && !store.getItem(FEEDBACK_DONE_KEY)) {
      cancelFeedbackTimer();
      showEndFeedback();
      return;
    }
    toggle();
  }

  launcher.addEventListener('click', toggle);
  closeBtn.addEventListener('click', handleClose);
  restartBtn.addEventListener('click', restartChat);
  // Esc closes the panel when it's open.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && opened) handleClose();
  });

  // Auto-shows a small "ask me anything" bubble next to the launcher so
  // first-time visitors notice the chat is there, instead of relying on
  // them spotting a plain icon in the corner. Once per browser session.
  setTimeout(function () {
    if (opened || store.getItem(TEASER_SESSION_KEY)) return;
    store.setItem(TEASER_SESSION_KEY, '1');
    var teaser = document.createElement('div');
    teaser.className = 'sc-teaser';
    teaser.innerHTML = TEASER_TEXT.replace(/&/g, '&amp;').replace(/</g, '&lt;') +
      '<button class="sc-teaser-close" aria-label="Dismiss">&times;</button>';
    teaser.addEventListener('click', function (e) {
      if (e.target.closest('.sc-teaser-close')) {
        teaser.remove();
        return;
      }
      teaser.remove();
      if (!opened) toggle();
    });
    document.body.appendChild(teaser);
    setTimeout(function () {
      if (teaser.parentElement) teaser.remove();
    }, 12000);
  }, TEASER_DELAY_MS);

  async function sendMessage(presetText) {
    if (inFlight) return; // ignore new sends while a reply is in flight
    var text = presetText !== undefined ? presetText : inputEl.value.trim();
    if (!text) return;
    inFlight = true;
    hadConversation = true;
    cancelFeedbackTimer(); // conversation is continuing
    addMessage(text, 'user');
    saveMessage('user', text);
    inputEl.value = '';
    sendBtn.disabled = true;
    inputEl.disabled = true;
    var typingEl = addMessage('…', 'bot');
    typingEl.classList.add('typing');

    // Reassure the user if the backend is unusually slow (e.g. an LLM fallback),
    // and abort after 60s so it can never appear frozen forever.
    var slow1 = setTimeout(function () { typingEl.textContent = 'Thinking… one moment.'; }, 7000);
    var slow2 = setTimeout(function () { typingEl.textContent = 'Still working on it…'; }, 20000);
    var controller = ('AbortController' in window) ? new AbortController() : null;
    var timeoutId = setTimeout(function () { if (controller) controller.abort(); }, 60000);
    function clearTimers() { clearTimeout(slow1); clearTimeout(slow2); clearTimeout(timeoutId); }
    function releaseInput() { inFlight = false; sendBtn.disabled = false; inputEl.disabled = false; }

    try {
      var headers = { 'Content-Type': 'application/json' };
      if (API_KEY) headers[API_KEY_HEADER] = API_KEY;
      var res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ message: text, sessionId: getSessionId(), clientId: CLIENT_ID }),
        signal: controller ? controller.signal : undefined
      });
      var data = await res.json();
      clearTimers();
      typingEl.parentElement.remove();
      var reply = data.reply || "Sorry, I didn't get a proper response. Please try again.";
      if (data.reply) saveMessage('bot', reply);
      addMessageTyped(reply, function () {
        // Prefer the backend's own quickReplies (ignoring any blank entries the
        // model sometimes emits); otherwise fall back to the configured
        // follow-up suggestions so chips never disappear mid-chat.
        var backendChips = Array.isArray(data.quickReplies)
          ? data.quickReplies.filter(function (q) { return q && String(q).trim(); })
          : [];
        var followUps = backendChips.length ? backendChips : FOLLOWUP_QUESTIONS;
        addChips(followUps, false, true);
        if (data.reply) scheduleFeedback();
        releaseInput();
        if (opened) inputEl.focus();
      });
    } catch (err) {
      clearTimers();
      typingEl.parentElement.remove();
      var msg = (err && err.name === 'AbortError')
        ? "That took longer than usual — please try again." + (SUPPORT_PHONE ? " If it keeps happening, contact us directly at " + SUPPORT_PHONE + "." : "")
        : "Sorry, I couldn't reach the assistant right now. Please try again in a moment.";
      addMessageTyped(msg, function () { releaseInput(); addRetry(text); });
    }
  }

  sendBtn.addEventListener('click', function () { sendMessage(); });
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
})();
