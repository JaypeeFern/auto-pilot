// fb-followers-collector — operator-run Puppeteer service for the
// "Facebook Giveaway Followers Collector" n8n workflow.
//
// Why this exists: the n8n container has no Chromium and Code nodes have no
// network access, so Puppeteer cannot run inside n8n. This tiny service runs
// on the operator machine (the same machine where interactive Facebook login
// is possible) with a PERSISTENT Chromium profile. n8n drives it over HTTP.
//
// Security rules (non-negotiable):
// - Bind loopback only by default. Never expose this service publicly.
// - Facebook login is ALWAYS manual in the headed browser window, including
//   password, 2FA, CAPTCHA, checkpoints, and device confirmations.
// - This service never accepts, stores, logs, or forwards Facebook
//   credentials. Authentication state lives only in the profile directory.
// - Only visibly accessible follower data is collected. Nothing hidden,
//   private, or access-controlled is bypassed.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const BIND = process.env.COLLECTOR_BIND || '0.0.0.0';
const PORT = Number(process.env.COLLECTOR_PORT || '5679');
const PROFILE_DIR = process.env.COLLECTOR_PROFILE_DIR || '/profile';
const HEADLESS = String(process.env.COLLECTOR_HEADLESS || 'false') === 'true';
const NAV_TIMEOUT_MS = Number(process.env.COLLECTOR_NAV_TIMEOUT_MS || '60000');
// PUPPETEER_* envs are honored by puppeteer; CHROME_PATH selects the system
// Chromium installed in the browser image (local runs omit it and use the
// bundled Chromium instead).
const CHROME_PATH = process.env.CHROME_PATH || undefined;

// Network posture: loopback is the safe default for local runs. Inside the
// browser container the API must bind the container network so n8n can reach
// it — that case sets COLLECTOR_ALLOW_NON_LOOPBACK=true in Compose (the port
// is never published and never routed publicly; see docs/ARCHITECTURE.md).
// Any other non-loopback bind without the explicit opt-in refuses to start.
const ALLOW_NON_LOOPBACK =
  String(process.env.COLLECTOR_ALLOW_NON_LOOPBACK || 'false') === 'true';
if (BIND !== '127.0.0.1' && BIND !== 'localhost' && BIND !== '0.0.0.0' && !ALLOW_NON_LOOPBACK) {
  console.error(
    'Refusing to bind ' + BIND + ': loopback only unless ' +
    'COLLECTOR_ALLOW_NON_LOOPBACK=true is set explicitly.');
  process.exit(1);
}
if (BIND === '0.0.0.0' && !ALLOW_NON_LOOPBACK) {
  console.error(
    'Refusing to bind 0.0.0.0 without COLLECTOR_ALLOW_NON_LOOPBACK=true.');
  process.exit(1);
}

let browser = null;
let collectBusy = false;

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function clampInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(body);
}

async function getBrowser() {
  if (browser && browser.connected) return browser;
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  browser = await puppeteer.launch({
    headless: HEADLESS ? 'new' : false,
    userDataDir: PROFILE_DIR,
    ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1366,900'],
  });
  return browser;
}

// Fail-safe auth probe: uncertain means NOT authenticated, so the workflow
// stops at AUTH_REQUIRED instead of scraping a login wall.
async function checkAuth(page) {
  let reachable = true;
  await page.goto('https://www.facebook.com/', {
    waitUntil: 'networkidle2',
    timeout: NAV_TIMEOUT_MS,
  }).catch(function () { reachable = false; });
  await sleep(2500);
  const url = page.url();
  if (/login|checkpoint|two_step|captcha/i.test(url)) {
    return { authenticated: false, reachable: reachable, message: 'Facebook shows a login/checkpoint page.' };
  }
  const state = await page.evaluate(function () {
    const html = document.documentElement.innerHTML;
    const hasLoginForm = /name="email"/i.test(html) && /name="pass"/i.test(html);
    // Positive logged-in markers only. NOTE: the bare aria-label="Facebook"
    // (site logo link) renders on logged-OUT pages too, so it must never
    // count as proof of a session — uncertain means NOT authenticated.
    const hasLoggedInChrome =
      /aria-label="Your profile"/i.test(html) ||
      (/data-testid="royal_login_button"/i.test(html) === false &&
        /data-pagelet="LeftRail"/i.test(html));
    return { hasLoginForm: hasLoginForm, hasLoggedInChrome: hasLoggedInChrome };
  });
  if (state.hasLoginForm && !state.hasLoggedInChrome) {
    return { authenticated: false, reachable: reachable, message: 'Facebook login form is showing.' };
  }
  if (!state.hasLoggedInChrome) {
    return { authenticated: false, reachable: reachable, message: 'Could not verify a logged-in session.' };
  }
  return { authenticated: true, reachable: reachable, message: 'Logged-in session verified.' };
}

function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let abs = s;
  if (abs.startsWith('/')) abs = 'https://www.facebook.com' + abs;
  if (!/^https?:\/\//i.test(abs)) return '';
  let v = abs.split('#')[0];
  const q = v.indexOf('?');
  if (q >= 0) {
    const base = v.slice(0, q);
    const query = v.slice(q + 1);
    const idm = query.match(/(^|&)id=(\d+)/i);
    v = idm ? base + '?id=' + idm[2] : base;
  }
  v = v.replace(/\/+$/, '');
  return v.toLowerCase();
}

// Strict Facebook host allowlist. Substring matching is NOT enough:
// hosts like evilfacebook.com must be rejected.
function isFacebookHref(href) {
  const s = String(href || '');
  if (!s) return false;
  if (s.startsWith('/')) return true; // same-origin; absolutized later
  const m = s.match(/^https?:\/\/([^/:?#]+)/i);
  if (!m) return false;
  const h = m[1].toLowerCase();
  return h === 'facebook.com' || h.endsWith('.facebook.com') ||
    h === 'fb.com' || h.endsWith('.fb.com');
}

function isProfileHref(href) {
  const s = String(href || '');
  if (!s) return false;
  if (!isFacebookHref(s)) return false;
  const low = s.toLowerCase();
  const banned = ['/login', '/checkpoint', '/recovery', '/groups/', '/pages/',
    '/events/', '/marketplace', '/watch', '/gaming', '/help', '/policies',
    '/ads', '/business', '/sharer', '/dialog/', '/plugins/', '/connect/',
    '/privacy', '/about', '/settings', '/search', '/messages', '/friends',
    '/photo.php', '/video.php', '/reel', '/stories', '/hashtag'];
  for (const b of banned) {
    if (low.includes(b)) return false;
  }
  return true;
}

// Extracts only rendered profile links inside the followers surface: the
// followers dialog when Facebook renders one, else the main column. Anchors
// outside that surface, zero-size (hidden/unrendered) anchors, and non-profile
// hrefs are skipped. Relative hrefs are absolutized against the page URL so
// downstream validation always sees absolute http(s) URLs.
async function extractVisibleProfiles(page) {
  return page.$$eval('a[href]', function (anchors) {
    const scope =
      document.querySelector('[role="dialog"]') ||
      document.querySelector('[role="main"]') ||
      document.body;
    const out = [];
    const links = scope.querySelectorAll('a[href]');
    for (const a of links) {
      const rect = a.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const raw = a.getAttribute('href') || '';
      if (!raw) continue;
      let abs = raw;
      try {
        abs = new URL(raw, document.location.href).href;
      } catch (err) {
        continue;
      }
      let text = (a.innerText || '').trim();
      if (!text) text = (a.getAttribute('aria-label') || '').trim();
      if (!text) {
        const img = a.querySelector('img[alt]');
        if (img) text = (img.getAttribute('alt') || '').trim();
      }
      out.push({ displayName: text, profileUrl: abs });
    }
    return out;
  }).catch(function () { return []; });
}

async function findScrollTarget(page) {
  return page.evaluate(function () {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    for (const d of dialogs) {
      if (d.scrollHeight > d.clientHeight + 100) return 'dialog';
    }
    return 'page';
  }).catch(function () { return 'page'; });
}

async function scrollOnce(page, target) {
  await page.evaluate(function (t) {
    if (t === 'dialog') {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      for (const d of dialogs) {
        if (d.scrollHeight > d.clientHeight + 100) {
          d.scrollTop = d.scrollHeight;
          return;
        }
      }
    }
    window.scrollTo(0, document.body.scrollHeight);
  }, target).catch(function () {});
}

async function runCollection(opts) {
  const followersUrl = String(opts.followersUrl || '').trim();
  if (!/^https?:\/\//i.test(followersUrl)) {
    return { ok: false, authenticated: true, error: 'followersUrl must be an http(s) URL.' };
  }
  // Never open arbitrary URLs with the logged-in persistent profile.
  let followersHost = '';
  try {
    followersHost = new URL(followersUrl).hostname.toLowerCase();
  } catch (err) {
    return { ok: false, authenticated: true, error: 'followersUrl is not a valid URL.' };
  }
  if (followersHost !== 'facebook.com' && !followersHost.endsWith('.facebook.com')) {
    return { ok: false, authenticated: true, error: 'followersUrl must be a facebook.com URL.' };
  }
  const scrollDelayMs = clampInt(opts.scrollDelayMs, 2500, 500, 15000);
  const postScrollWaitMs = clampInt(opts.postScrollWaitMs, 2500, 500, 15000);
  const emptyThreshold = clampInt(opts.emptyScrollThreshold, 10, 1, 50);
  const maxScrolls = clampInt(opts.maxScrollAttempts, 500, 1, 2000);

  const b = await getBrowser();
  const page = await b.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  try {
    const auth = await checkAuth(page);
    if (!auth.authenticated) {
      return { ok: false, authenticated: false, error: 'AUTH_REQUIRED: ' + auth.message };
    }
    let loaded = false;
    let loadError = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto(followersUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
        loaded = true;
        break;
      } catch (err) {
        loadError = String((err && err.message) || err);
        await sleep(3000);
      }
    }
    if (!loaded) {
      return { ok: false, authenticated: true, error: 'Could not load followers page: ' + loadError };
    }
    await sleep(postScrollWaitMs);

    const seen = new Set();
    const profiles = [];
    let totalEncountered = 0;
    let emptyStreak = 0;
    let scrollAttempts = 0;
    let stopReason = 'max-attempts-reached';

    while (scrollAttempts < maxScrolls) {
      const url = page.url();
      if (/login|checkpoint|two_step|captcha/i.test(url)) {
        return { ok: false, authenticated: false, error: 'AUTH_REQUIRED: session challenged mid-run.', stats: { totalEncountered: totalEncountered, scrollAttempts: scrollAttempts, stopReason: 'auth-lost' } };
      }
      const found = await extractVisibleProfiles(page);
      let fresh = 0;
      for (const f of found) {
        if (!isProfileHref(f.profileUrl)) continue;
        const key = normalizeUrl(f.profileUrl);
        if (!key) continue;
        totalEncountered++;
        // Every encounter is returned, including repeats: n8n dedupes by
        // profile URL and records duplicate status per row in Raw Followers.
        // The local seen-set only measures scroll freshness for stopping.
        if (!seen.has(key)) {
          seen.add(key);
          fresh++;
        }
        profiles.push({ displayName: f.displayName || '', profileUrl: f.profileUrl });
      }
      if (fresh > 0) {
        emptyStreak = 0;
      } else {
        emptyStreak++;
      }
      if (emptyStreak >= emptyThreshold) {
        stopReason = 'empty-threshold-reached';
        break;
      }
      const target = await findScrollTarget(page);
      await scrollOnce(page, target);
      scrollAttempts++;
      await sleep(scrollDelayMs);
      await sleep(postScrollWaitMs);
    }
    return {
      ok: true,
      authenticated: true,
      profiles: profiles,
      stats: { totalEncountered: totalEncountered, scrollAttempts: scrollAttempts, stopReason: stopReason, runLabel: String(opts.runLabel || '') },
    };
  } finally {
    await page.close().catch(function () {});
  }
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let data = '';
    req.on('data', function (chunk) { data += chunk; });
    req.on('end', function () {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async function (req, res) {
  try {
    if (req.method === 'GET' && req.url === '/status') {
      const b = await getBrowser();
      const page = await b.newPage();
      try {
        const auth = await checkAuth(page);
        sendJson(res, 200, {
          ok: true,
          authenticated: auth.authenticated,
          profileDir: PROFILE_DIR,
          facebookReachable: auth.reachable,
          message: auth.message,
        });
      } finally {
        await page.close().catch(function () {});
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/collect') {
      if (collectBusy) {
        sendJson(res, 409, { ok: false, error: 'A collection run is already in progress.' });
        return;
      }
      collectBusy = true;
      try {
        const body = await readBody(req);
        const result = await runCollection(body || {});
        sendJson(res, result.ok ? 200 : result.authenticated === false ? 401 : 500, result);
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
      } finally {
        collectBusy = false;
      }
      return;
    }
    sendJson(res, 404, { ok: false, error: 'Unknown endpoint. Use GET /status or POST /collect.' });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
  }
});

server.listen(PORT, BIND, function () {
  // Counts only — never log follower names, URLs, or page content.
  console.log('fb-followers-collector listening on http://' + BIND + ':' + PORT);
  console.log('profile: ' + PROFILE_DIR + ' headless: ' + HEADLESS);
});
