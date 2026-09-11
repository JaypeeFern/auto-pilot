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
// /status is also the Docker healthcheck target (compose: interval 60s), and
// a live check navigates to facebook.com every call. Without caching that
// means an automated hit to Facebook every 60s forever, even with no
// giveaway running. Cache the auth result so the frequent healthcheck stays
// cheap; only the first call in each 24h window actually opens the page.
const STATUS_CACHE_MS = Number(process.env.COLLECTOR_STATUS_CACHE_MS || '86400000');
// PUPPETEER_* envs are honored by puppeteer; CHROME_PATH selects the system
// Chromium installed in the browser image (local runs omit it and use the
// bundled Chromium instead).
const CHROME_PATH = process.env.CHROME_PATH || undefined;
// Must not exceed the Xvfb virtual display resolution (entrypoint.sh SCREEN,
// default 1366x900x24 — keep that default in sync with these two if either
// changes) — a headed Chromium window cannot render larger than the X11
// display behind it. Facebook's follower list is virtualized (only mounts
// DOM nodes near/in the viewport), so a larger viewport surfaces more rows
// per scroll and cuts down on redundant re-scanning between scroll cycles —
// but 1920x1080 OOM-crashed Chromium inside the browser container's 640m
// mem_limit mid-collection (Chrome "Aw, Snap!" error code 9, observed in
// production), so the default is back to the known-safe 1366x900 until
// either mem_limit is raised or a smaller bump is verified against actual
// container memory headroom. clampInt (defined below; hoisted) guards
// against non-numeric/zero/negative overrides producing invalid Chromium
// launch args.
const VIEWPORT_WIDTH = clampInt(process.env.COLLECTOR_VIEWPORT_WIDTH, 1366, 320, 3840);
const VIEWPORT_HEIGHT = clampInt(process.env.COLLECTOR_VIEWPORT_HEIGHT, 900, 240, 2160);

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
let cancelRequested = false;
let statusCache = null; // { at: number, body: object }
// Bumped whenever /collect finishes, so a live /status check that was
// already in flight (its checkAuth navigation is a long series of awaits)
// can detect that a collection ran underneath it and skip writing a
// now-possibly-stale result into the cache.
let statusCacheEpoch = 0;

// In-memory progress state for GET /progress, polled by the Control Panel
// GUI so an operator can watch a run without opening noVNC. Counts only —
// same "never log follower names, URLs, or page content" rule as everywhere
// else in this file applies to every log line pushed here.
const PROGRESS_LOG_MAX = 200;
let progress = {
  active: false,
  runId: null,
  phase: 'idle',
  startedAt: null,
  updatedAt: null,
  scrollAttempts: 0,
  totalEncountered: 0,
  uniqueFollowers: 0,
  stopReason: null,
  error: null,
  log: [],
};

function resetProgress(runId) {
  progress = {
    active: true,
    runId: runId || null,
    phase: 'starting',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    scrollAttempts: 0,
    totalEncountered: 0,
    uniqueFollowers: 0,
    stopReason: null,
    error: null,
    log: [],
  };
}

function logProgress(phase, message, extra) {
  progress.phase = phase;
  progress.updatedAt = Date.now();
  if (extra) Object.assign(progress, extra);
  progress.log.push({ at: Date.now(), phase: phase, message: message });
  if (progress.log.length > PROGRESS_LOG_MAX) {
    progress.log.splice(0, progress.log.length - PROGRESS_LOG_MAX);
  }
}

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
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=' + VIEWPORT_WIDTH + ',' + VIEWPORT_HEIGHT],
  });
  return browser;
}

// Fail-safe auth probe: uncertain means NOT authenticated, so the workflow
// stops at AUTH_REQUIRED instead of scraping a login wall.
//
// navigateUrl controls where this navigates before checking: default is the
// bare facebook.com homepage (used by /status, a general liveness/auth
// probe with no other target page in mind). Pass null to skip navigation
// entirely and check whatever page is already loaded — used by
// runCollection, which already navigated to the followers page itself and
// would otherwise cause a second, redundant open/navigate/close cycle to
// the homepage before ever reaching the actual target (visibly showing as
// Facebook opening, closing, and reopening for every single run).
async function checkAuth(page, navigateUrl) {
  let reachable = true;
  const target = navigateUrl === null ? null : (navigateUrl || 'https://www.facebook.com/');
  if (target) {
    await page.goto(target, {
      waitUntil: 'networkidle2',
      timeout: NAV_TIMEOUT_MS,
    }).catch(function () { reachable = false; });
    await sleep(2500);
  }
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
    '/photo.php', '/video.php', '/reel', '/stories', '/hashtag',
    // Page-chrome links that render inside the same scope as the followers
    // list on a Page's Followers tab (cover photo, professional dashboard) —
    // not follower profiles, confirmed against a real collection run.
    '/photo/', '/professional_dashboard'];
  for (const b of banned) {
    // Match as a whole path segment, not a bare substring, and check every
    // occurrence (not just the first) — otherwise a legitimate
    // username/slug that happens to start with a banned token (e.g.
    // "/aboutme123") could pass, or a later genuine occurrence of that same
    // token elsewhere in the URL could be missed (independent review
    // findings: "/aboutme123/about" must still be banned via its second,
    // boundary-anchored "/about").
    if (b.endsWith('/')) {
      if (low.includes(b)) return false; // already segment-anchored
      continue;
    }
    const escaped = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(escaped + '(?:[/?#]|$)', 'i').test(low)) return false;
  }
  return true;
}

// The follower list can finish loading its link hrefs before the name text
// (and image alt text) next to each link has painted — extracting at that
// moment yields real profile URLs with blank displayName for every entry,
// which then never gets fixed later since re-sighting the same URL on a
// later scroll is recorded as a plain duplicate, not a name upgrade.
// Wait for at least one visible, text-bearing profile link before reading,
// bounded so a genuinely empty/slow-to-load page still proceeds eventually.
async function waitForNamedProfiles(page, timeoutMs) {
  await page.waitForFunction(function () {
    // Simplified, browser-context readiness heuristic (page.evaluate/
    // waitForFunction predicates can't call back into Node functions, so
    // this can't reuse isProfileHref directly) — without it, the wait is
    // satisfied instantly by any already-text-bearing nav/chrome link
    // (independent review finding), never actually waiting for a
    // follower's name to paint. A URL-shape denylist/allowlist is a losing
    // game here — Facebook has many nav routes (notifications, home,
    // photos, bookmarks, ...) and protocol-relative "//host/..." hrefs slip
    // past a naive same-origin check (independent review findings). Use a
    // structural signal instead: an actual follower row always shows an
    // avatar image next to the name, while nav/chrome icons are almost
    // always inline SVG, not <img> — requiring one avoids needing to
    // enumerate Facebook's routes at all. This is only a gate for *when*
    // to read; the real, boundary-aware isProfileHref still does the
    // authoritative filtering on the actual extracted data afterward.
    function looksLikeProfile(a, href) {
      const s = String(href || '');
      if (!s || s.startsWith('//')) return false; // empty or protocol-relative external
      if (/^https?:\/\//i.test(s)) {
        const m = s.match(/^https?:\/\/([^/:?#]+)/i);
        const h = m ? m[1].toLowerCase() : '';
        if (h !== 'facebook.com' && !h.endsWith('.facebook.com') && h !== 'fb.com' && !h.endsWith('.fb.com')) return false;
      } else if (!s.startsWith('/')) {
        return false;
      }
      return !!a.querySelector('img');
    }
    const scope =
      document.querySelector('[role="dialog"]') ||
      document.querySelector('[role="main"]') ||
      document.body;
    const links = scope.querySelectorAll('a[href]');
    for (const a of links) {
      const rect = a.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (!looksLikeProfile(a, a.getAttribute('href') || '')) continue;
      // Trim each candidate independently before falling back — a
      // whitespace-only innerText would otherwise win over a populated
      // aria-label and read as empty, wasting the full timeout
      // (independent review finding).
      const text = (a.innerText || '').trim() || (a.getAttribute('aria-label') || '').trim();
      if (text) return true;
    }
    return false;
  }, { timeout: timeoutMs }).catch(function () {});
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

  // The page/profile being collected always appears in its own followers
  // list on Facebook's UI (a "N followers" self-link, and sometimes other
  // self-referential chrome) — exclude it by identifier, not DOM position,
  // so it can never masquerade as a follower. Covers numeric-id URLs
  // (facebook.com/profile.php?id=...), plain slug URLs (facebook.com/<page>/
  // followers/), and route-style URLs (facebook.com/people/<name>/<id>/,
  // where the leading "people" segment is a generic route prefix, not part
  // of the identity, and the trailing numeric segment is the real id —
  // independent review finding: naively using the first path segment
  // collapsed every /people/... profile to the same identity).
  function identityOf(url) {
    const s = String(url || '');
    const idm = s.match(/[?&]id=(\d+)/i);
    if (idm) return 'id:' + idm[1];
    try {
      const parts = new URL(s, 'https://www.facebook.com').pathname.split('/').filter(Boolean);
      if (!parts.length) return '';
      const last = parts[parts.length - 1];
      if (/^\d+$/.test(last)) return 'id:' + last;
      if (parts[0] === 'people' && parts.length > 1) return 'slug:' + parts[1].toLowerCase();
      return 'slug:' + parts[0].toLowerCase();
    } catch (err) {
      return '';
    }
  }
  const selfId = identityOf(followersUrl);

  resetProgress(opts.runId);
  logProgress('loading', 'Opening followers page...');

  const b = await getBrowser();
  const page = await b.newPage();
  await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
  try {
    // Single navigation for the whole run: go straight to the followers
    // page (never the bare homepage first) and check auth on that same
    // already-loaded page. Avoids a second, redundant Facebook open/close
    // cycle before ever reaching the actual target.
    let loaded = false;
    let loadError = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto(followersUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
        loaded = true;
        break;
      } catch (err) {
        loadError = String((err && err.message) || err);
        logProgress('loading', 'Navigation attempt ' + attempt + ' failed, retrying...');
        await sleep(3000);
      }
    }
    if (!loaded) {
      logProgress('error', 'Could not load followers page.', { active: false, error: loadError });
      return { ok: false, authenticated: true, error: 'Could not load followers page: ' + loadError };
    }
    await sleep(postScrollWaitMs);

    logProgress('auth', 'Checking Facebook login state...');
    const auth = await checkAuth(page, null);
    if (!auth.authenticated) {
      logProgress('error', 'Not authenticated.', { active: false, error: auth.message });
      return { ok: false, authenticated: false, error: 'AUTH_REQUIRED: ' + auth.message };
    }
    logProgress('scrolling', 'Authenticated. Starting scroll and capture...');

    const seen = new Set();
    const profiles = [];
    let totalEncountered = 0;
    let emptyStreak = 0;
    let scrollAttempts = 0;
    let stopReason = 'max-attempts-reached';

    while (scrollAttempts < maxScrolls) {
      if (cancelRequested) {
        stopReason = 'canceled';
        break;
      }
      const url = page.url();
      if (/login|checkpoint|two_step|captcha/i.test(url)) {
        logProgress('error', 'Session challenged mid-run.', { active: false, error: 'AUTH_REQUIRED: session challenged mid-run.' });
        return { ok: false, authenticated: false, error: 'AUTH_REQUIRED: session challenged mid-run.', stats: { totalEncountered: totalEncountered, scrollAttempts: scrollAttempts, stopReason: 'auth-lost' } };
      }
      await waitForNamedProfiles(page, 4000);
      const found = await extractVisibleProfiles(page);
      let fresh = 0;
      for (const f of found) {
        if (!isProfileHref(f.profileUrl)) continue;
        const key = normalizeUrl(f.profileUrl);
        if (!key) continue;
        if (selfId && identityOf(f.profileUrl) === selfId) continue;
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
      scrollAttempts++;
      logProgress(
        'scrolling',
        'Scroll ' + scrollAttempts + ': +' + fresh + ' new (total unique ' + seen.size + ', encountered ' + totalEncountered + ')',
        { scrollAttempts: scrollAttempts, totalEncountered: totalEncountered, uniqueFollowers: seen.size }
      );
      if (emptyStreak >= emptyThreshold) {
        stopReason = 'empty-threshold-reached';
        break;
      }
      const target = await findScrollTarget(page);
      await scrollOnce(page, target);
      await sleep(scrollDelayMs);
      await sleep(postScrollWaitMs);
    }
    logProgress('done', 'Finished: ' + seen.size + ' unique followers (' + stopReason + ').', { active: false, stopReason: stopReason, uniqueFollowers: seen.size });
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
    if (req.method === 'GET' && req.url.split('?')[0] === '/status') {
      // ?fresh=1 forces a live Facebook check, bypassing the cache below —
      // used by the real collector run so it never acts on a stale auth
      // result. The Docker healthcheck (and any other caller) hits the
      // plain path and gets the cache, so a repeated 60s healthcheck
      // doesn't repeatedly hit facebook.com.
      const forceFresh = /(^|[?&])fresh=1(&|$)/.test(req.url);
      if (!forceFresh && statusCache && (Date.now() - statusCache.at) < STATUS_CACHE_MS) {
        sendJson(res, 200, Object.assign({}, statusCache.body, { cached: true }));
        return;
      }
      const epochAtStart = statusCacheEpoch;
      const b = await getBrowser();
      const page = await b.newPage();
      try {
        const auth = await checkAuth(page);
        const body = {
          ok: true,
          authenticated: auth.authenticated,
          profileDir: PROFILE_DIR,
          facebookReachable: auth.reachable,
          message: auth.message,
        };
        // Only cache if no /collect ran while this check was in flight —
        // otherwise this result may already be stale relative to the
        // collection's own invalidation, and caching it would mask that.
        if (statusCacheEpoch === epochAtStart) {
          statusCache = { at: Date.now(), body: body };
        }
        sendJson(res, 200, Object.assign({}, body, { cached: false }));
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
      cancelRequested = false;
      try {
        const body = await readBody(req);
        const result = await runCollection(body || {});
        sendJson(res, result.ok ? 200 : result.authenticated === false ? 401 : 500, result);
      } catch (err) {
        logProgress('error', 'Collection crashed.', { active: false, error: String((err && err.message) || err) });
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
      } finally {
        // A collection run may have changed auth state (session expired or
        // got challenged mid-run) — drop the cache so the next /status
        // reflects reality instead of a stale pre-run result. Bumping the
        // epoch also stops any /status check already in flight from
        // re-populating the cache with a result that predates this run.
        statusCache = null;
        statusCacheEpoch++;
        collectBusy = false;
      }
      return;
    }
    if (req.method === 'GET' && req.url.split('?')[0] === '/progress') {
      sendJson(res, 200, Object.assign({}, progress, { collectBusy: collectBusy }));
      return;
    }
    if (req.method === 'POST' && req.url === '/cancel') {
      if (!collectBusy) {
        sendJson(res, 200, { ok: false, error: 'No collection is currently in progress.' });
        return;
      }
      cancelRequested = true;
      sendJson(res, 200, { ok: true, message: 'Cancel requested — the run will stop after its current scroll cycle.' });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'Unknown endpoint. Use GET /status, GET /progress, POST /collect, or POST /cancel.' });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
  }
});

server.listen(PORT, BIND, function () {
  // Counts only — never log follower names, URLs, or page content.
  console.log('fb-followers-collector listening on http://' + BIND + ':' + PORT);
  console.log('profile: ' + PROFILE_DIR + ' headless: ' + HEADLESS);
});
