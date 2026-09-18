/**
 * Sahayak Desk — embeddable support widget loader.
 *
 * Kisi bhi website ke <body> me ye ek line daal dein:
 *   <script src="https://YOUR-HELPDESK-URL/widget.js" defer></script>
 *
 * Optional attributes:
 *   data-accent="#0f766e"   launcher ka colour
 *   data-position="right"   right | left
 *   data-label="Help"       launcher ka text
 *   data-greeting="1"       pehli baar greeting bubble dikhayein
 */
(function () {
  if (window.__sahayakDeskLoaded) return;
  window.__sahayakDeskLoaded = true;

  var script =
    document.currentScript ||
    (function () {
      var all = document.getElementsByTagName('script');
      for (var i = all.length - 1; i >= 0; i--) {
        if (all[i].src && all[i].src.indexOf('widget.js') > -1) return all[i];
      }
      return null;
    })();

  var src = (script && script.src) || '';
  var base = src.replace(/\/widget\.js.*$/, '');
  var attr = function (name, fallback) {
    var v = script && script.getAttribute('data-' + name);
    return v === null || v === undefined || v === '' ? fallback : v;
  };

  var accent = attr('accent', '#0f766e');
  var position = attr('position', 'right') === 'left' ? 'left' : 'right';
  var label = attr('label', 'Help');
  var greeting = attr('greeting', '1') === '1';

  var host = document.createElement('div');
  host.id = 'sahayak-desk-root';
  host.setAttribute('aria-live', 'polite');
  document.body.appendChild(host);

  var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  var style = document.createElement('style');
  style.textContent = [
    ':host { all: initial; }',
    '.sd-wrap{position:fixed;bottom:20px;' + position + ':20px;z-index:2147483000;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;}',
    '.sd-btn{display:flex;align-items:center;gap:8px;border:0;cursor:pointer;color:#fff;background:' +
      accent +
      ';padding:13px 18px;border-radius:999px;font-size:14px;font-weight:600;box-shadow:0 10px 26px rgba(0,0,0,.22);transition:transform .18s cubic-bezier(.16,1,.3,1),box-shadow .18s;}',
    '.sd-btn:hover{transform:translateY(-2px);box-shadow:0 14px 32px rgba(0,0,0,.26);}',
    '.sd-btn:focus-visible{outline:3px solid rgba(255,255,255,.6);outline-offset:2px;}',
    '.sd-btn svg{width:18px;height:18px;flex:none;}',
    '.sd-panel{position:fixed;bottom:88px;' +
      position +
      ':20px;width:390px;max-width:calc(100vw - 32px);height:620px;max-height:calc(100vh - 120px);border:0;border-radius:18px;overflow:hidden;background:#fff;box-shadow:0 24px 64px rgba(0,0,0,.28);opacity:0;transform:translateY(12px) scale(.98);pointer-events:none;transition:opacity .2s ease,transform .22s cubic-bezier(.16,1,.3,1);z-index:2147483000;}',
    '.sd-panel.sd-open{opacity:1;transform:none;pointer-events:auto;}',
    '.sd-tip{position:fixed;bottom:82px;' +
      position +
      ':20px;max-width:250px;background:#fff;color:#18201f;border-radius:14px;padding:11px 13px;font-size:13px;line-height:1.45;box-shadow:0 14px 34px rgba(0,0,0,.18);z-index:2147482999;}',
    '.sd-tip b{display:block;font-size:13px;margin-bottom:2px;}',
    '.sd-tip button{position:absolute;top:5px;' +
      (position === 'left' ? 'right' : 'right') +
      ':7px;border:0;background:transparent;cursor:pointer;color:#8a8f8e;font-size:15px;line-height:1;}',
    '@media (max-width:520px){.sd-panel{width:calc(100vw - 24px);height:calc(100vh - 110px);' + position + ':12px;} .sd-tip{display:none;}}',
  ].join('\n');
  shadow.appendChild(style);

  var wrap = document.createElement('div');
  wrap.className = 'sd-wrap';

  var btn = document.createElement('button');
  btn.className = 'sd-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Support widget kholein');
  var iconChat =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/></svg>';
  var iconClose =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  btn.innerHTML = iconChat + '<span>' + label + '</span>';
  wrap.appendChild(btn);
  shadow.appendChild(wrap);

  var frame = null;
  var tip = null;
  var open = false;

  function ensureFrame() {
    if (frame) return frame;
    frame = document.createElement('iframe');
    frame.className = 'sd-panel';
    frame.title = 'Support';
    frame.setAttribute('allow', 'clipboard-write');
    frame.src = base + '/index.html#/widget';
    shadow.appendChild(frame);
    return frame;
  }

  function setOpen(next) {
    open = next;
    var f = ensureFrame();
    // force style flush so the transition runs on first open
    void f.offsetHeight;
    if (open) f.classList.add('sd-open');
    else f.classList.remove('sd-open');
    btn.innerHTML = (open ? iconClose : iconChat) + '<span>' + (open ? 'Close' : label) + '</span>';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (tip) {
      tip.remove();
      tip = null;
    }
  }

  btn.addEventListener('click', function () {
    setOpen(!open);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && open) setOpen(false);
  });

  // Widget se aane wale messages (e.g. "close" button) handle karein
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.source !== 'sahayak-desk') return;
    if (e.data.type === 'close') setOpen(false);
  });

  if (greeting) {
    setTimeout(function () {
      if (open) return;
      tip = document.createElement('div');
      tip.className = 'sd-tip';
      tip.innerHTML =
        // '<b>Koi dikkat aa rahi hai?</b>Yahan se ticket raise karein — hum jaldi reply karte hain.<button aria-label="Band karein">&times;</button>';
        '</b>Having trouble with something?</b>Raise a ticket here — we’ll reply as soon as possible.<button aria-label="Close">&times;</button>';
      tip.querySelector('button').addEventListener('click', function (ev) {
        ev.stopPropagation();
        tip.remove();
        tip = null;
      });
      tip.addEventListener('click', function () {
        setOpen(true);
      });
      shadow.appendChild(tip);
    }, 1600);
  }

  window.SahayakDesk = {
    open: function () {
      setOpen(true);
    },
    close: function () {
      setOpen(false);
    },
    toggle: function () {
      setOpen(!open);
    },
  };
})();
