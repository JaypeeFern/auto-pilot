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
// display behind it. A larger viewport surfaces more follower rows per
// scroll, which would mean fewer scroll cycles overall — but 1920x1080
// OOM-crashed Chromium inside the browser container's former 640m
// mem_limit mid-collection (Chrome "Aw, Snap!" error code 9, observed in
// production), so the default remains the known-safe 1366x900 even with the
// staged 768m browser ceiling. clampInt (defined below; hoisted) guards
// against non-numeric/zero/negative overrides producing invalid Chromium
// launch args.
const VIEWPORT_WIDTH = clampInt(process.env.COLLECTOR_VIEWPORT_WIDTH, 1366, 320, 3840);
const VIEWPORT_HEIGHT = clampInt(process.env.COLLECTOR_VIEWPORT_HEIGHT, 900, 240, 2160);
const CAPTURE_QUEUE_LIMIT = clampInt(process.env.COLLECTOR_CAPTURE_QUEUE_LIMIT, 4096, 256, 20000);
const CAPTURE_MUTATION_NODE_LIMIT = clampInt(process.env.COLLECTOR_CAPTURE_MUTATION_NODE_LIMIT, 512, 64, 4000);
const CAPTURE_INITIAL_NODE_LIMIT = clampInt(process.env.COLLECTOR_CAPTURE_INITIAL_NODE_LIMIT, 10000, 1024, 50000);
const CAPTURE_MUTATION_RECORD_LIMIT = clampInt(process.env.COLLECTOR_CAPTURE_MUTATION_RECORD_LIMIT, 2048, 128, 10000);
const CAPTURE_ROW_LIMIT = clampInt(process.env.COLLECTOR_CAPTURE_ROW_LIMIT, 20000, 512, 100000);
const MAX_CANONICAL_PROFILES = clampInt(process.env.COLLECTOR_MAX_CANONICAL_PROFILES, 20000, 1000, 100000);

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
  anchorSightings: 0,
  anchorRepeats: 0,
  profileCapSkipped: 0,
  nameUpgrades: 0,
  uniqueFollowers: 0,
  stopReason: null,
  error: null,
  telemetry: null,
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
    anchorSightings: 0,
    anchorRepeats: 0,
    profileCapSkipped: 0,
    nameUpgrades: 0,
    uniqueFollowers: 0,
    stopReason: null,
    error: null,
    telemetry: null,
    log: [],
  };
}

function safeText(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .slice(0, maxLength || 240);
}

function logProgress(phase, message, extra) {
  progress.phase = phase;
  progress.updatedAt = Date.now();
  if (extra) Object.assign(progress, extra);
  if (progress.error) progress.error = safeText(progress.error);
  progress.log.push({ at: Date.now(), phase: phase, message: safeText(message) });
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

// Capture is installed once per collection. The observer remains a bounded
// event signal/fallback, while each drain also sweeps the resolved follower
// row container's direct children. Facebook appends rows without guaranteeing
// that every usable anchor arrives as a distinct mutation, so the direct-child
// sweep is the authoritative DOM snapshot for each scroll boundary.
async function installFollowerCapture(page) {
  return page.evaluate(function (config) {
    function isVisible(element) {
      if (!element || !element.isConnected) return false;
      if (element.closest('[hidden], [aria-hidden="true"]')) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function candidateScore(element, rootIndex) {
      if (!element || !element.isConnected || element.clientHeight <= 0) return -1;
      const overflow = element.scrollHeight - element.clientHeight;
      if (overflow < 40) return -1;
      const style = window.getComputedStyle(element);
      if (element !== document.scrollingElement &&
          style.overflowY !== 'auto' && style.overflowY !== 'scroll' &&
          style.overflow !== 'auto' && style.overflow !== 'scroll') return -1;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return -1;
      const dialogBonus = element.getAttribute('role') === 'dialog' ? 100000 : 0;
      const rootBonus = Math.max(0, 10000 - rootIndex * 1000);
      return dialogBonus + rootBonus + Math.min(overflow, 50000);
    }

    function boundedElements(root, limit) {
      const elements = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      let truncated = false;
      while (node && elements.length < limit) {
        elements.push(node);
        node = walker.nextNode();
      }
      if (node) truncated = true;
      return { elements: elements, truncated: truncated };
    }

    function findSurface() {
      const roots = [];
      const dialog = document.querySelector('[role="dialog"]');
      const main = document.querySelector('[role="main"]');
      if (dialog) roots.push(dialog);
      if (main && main !== dialog) roots.push(main);
      if (!roots.length) roots.push(document.body);
      let best = null;
      let bestScore = -1;
      let truncated = false;
      roots.forEach(function (root, rootIndex) {
        const candidates = [root];
        const bounded = boundedElements(root, config.surfaceNodeLimit);
        truncated = truncated || bounded.truncated;
        bounded.elements.forEach(function (element) {
          candidates.push(element);
        });
        candidates.forEach(function (candidate) {
          const score = candidateScore(candidate, rootIndex);
          if (score > bestScore) {
            best = candidate;
            bestScore = score;
          }
        });
      });
      const scrollContainer = best || document.scrollingElement || document.documentElement;
      const surface = best || roots[0] || document.body;
      return { surface: surface, scrollContainer: scrollContainer, truncated: truncated };
    }

    function textForAnchor(anchor) {
      let text = (anchor.innerText || '').trim();
      if (!text) text = (anchor.getAttribute('aria-label') || '').trim();
      if (!text) {
        const image = anchor.querySelector('img[alt]');
        if (image) text = (image.getAttribute('alt') || '').trim();
      }
      return text;
    }

    function isFacebookHref(href) {
      try {
        const parsed = new URL(href, document.location.href);
        const host = parsed.hostname.toLowerCase();
        return host === 'facebook.com' || host.endsWith('.facebook.com') ||
          host === 'fb.com' || host.endsWith('.fb.com');
      } catch (err) {
        return false;
      }
    }

    function firstFacebookLink(row) {
      if (!row || !row.querySelectorAll) return null;
      const links = row.querySelectorAll('a[href]');
      for (let index = 0; index < links.length && index < config.rowLinkLimit; index++) {
        const link = links[index];
        const href = link.getAttribute('href') || '';
        const displayName = (link.textContent || '').trim();
        if (!displayName || !isFacebookHref(href) || !isVisible(link)) continue;
        let profileUrl = '';
        try {
          profileUrl = new URL(href, document.location.href).href;
        } catch (err) {
          continue;
        }
        return { displayName: displayName, profileUrl: profileUrl };
      }
      return null;
    }

    function scanDirectRows(container, limit) {
      const children = container && container.children ? container.children : [];
      const rowLimit = Math.min(children.length, limit);
      const captures = [];
      let blankRows = 0;
      for (let index = 0; index < rowLimit; index++) {
        const capture = firstFacebookLink(children[index]);
        if (capture) captures.push(capture);
        else blankRows++;
      }
      return {
        captures: captures,
        childCount: children.length,
        namedRowCount: captures.length,
        blankRowCount: blankRows,
        truncated: children.length > limit,
      };
    }

    function findRowContainer(root) {
      if (!root) return null;
      const candidates = [root];
      const bounded = boundedElements(root, config.surfaceNodeLimit);
      bounded.elements.forEach(function (element) { candidates.push(element); });
      let best = null;
      let bestScore = -1;
      candidates.forEach(function (candidate) {
        if (!candidate.children || candidate.children.length < 4) return;
        const probe = scanDirectRows(candidate, Math.min(config.rowProbeLimit, config.rowLimit));
        if (!probe.namedRowCount) return;
        const score = probe.namedRowCount * 1000000 + Math.min(candidate.children.length, config.rowLimit);
        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      });
      return best || root;
    }

    const prior = window.__fgCaptureSession;
    if (prior && typeof prior.dispose === 'function') prior.dispose();
    const state = {
      queue: [],
      pendingByAnchor: new Map(),
      maxQueue: config.queueLimit,
      mutationNodeLimit: config.mutationNodeLimit,
      mutationRecordLimit: config.mutationRecordLimit,
      dropped: 0,
      queueOverflow: false,
      mutationRecords: 0,
      mutationRecordsSinceDrain: 0,
      mutationRecordOverflow: false,
      captureTruncated: false,
      truncationReasons: [],
      initialAnchorCount: 0,
      attachedCount: 0,
      queueHighWaterMark: 0,
      surfaceNodeCount: 0,
      waiters: [],
      observer: null,
      surface: null,
      scrollContainer: null,
      rowContainer: null,
      disposed: false,
    };

    function notifyWaiters(reason) {
      const waiters = state.waiters.splice(0);
      waiters.forEach(function (resolve) { resolve(reason); });
    }

    function enqueue(anchor) {
      if (state.disposed || !anchor || anchor.tagName !== 'A' ||
          !anchor.getAttribute('href') || !isVisible(anchor) ||
          !state.surface || !state.surface.contains(anchor)) return;
      let profileUrl = '';
      try {
        profileUrl = new URL(anchor.getAttribute('href'), document.location.href).href;
      } catch (err) {
        return;
      }
      const displayName = textForAnchor(anchor);
      const pending = state.pendingByAnchor.get(anchor);
      if (pending) {
        pending.profileUrl = profileUrl;
        if (displayName) pending.displayName = displayName;
        return;
      }
      if (state.queue.length >= state.maxQueue) {
        state.dropped++;
        state.queueOverflow = true;
        notifyWaiters('queue-overflow');
        return;
      }
      const entry = { anchor: anchor, displayName: displayName, profileUrl: profileUrl };
      state.pendingByAnchor.set(anchor, entry);
      state.queue.push(entry);
      state.queueHighWaterMark = Math.max(state.queueHighWaterMark, state.queue.length);
      notifyWaiters('capture');
    }

    function inspectAdded(node) {
      if (!node || node.nodeType !== 1) return;
      if (node.matches('a[href]')) enqueue(node);
      const bounded = boundedElements(node, state.mutationNodeLimit);
      if (bounded.truncated) {
        state.captureTruncated = true;
        if (state.truncationReasons.indexOf('mutation-subtree') < 0) state.truncationReasons.push('mutation-subtree');
      }
      bounded.elements.forEach(function (element) {
        if (element.matches('a[href]')) enqueue(element);
      });
    }

    function addMutationRoot(roots, node) {
      if (!node || node.nodeType !== 1) return;
      for (const root of roots) {
        if (root === node || root.contains(node)) return;
      }
      for (let i = roots.length - 1; i >= 0; i--) {
        if (node.contains(roots[i])) roots.splice(i, 1);
      }
      roots.push(node);
    }

    function inspectMutation(record, addedRoots) {
      state.mutationRecords++;
      state.mutationRecordsSinceDrain++;
      if (record.target) {
        const targetElement = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        const parentAnchor = targetElement && targetElement.matches('a[href]') ? targetElement : targetElement && targetElement.closest('a[href]');
        if (parentAnchor) enqueue(parentAnchor);
        if (record.type === 'attributes' && targetElement &&
            (record.attributeName === 'hidden' || record.attributeName === 'aria-hidden')) {
          inspectAdded(targetElement);
        }
      }
      if (record.type === 'childList') {
        if (record.addedNodes.length > state.mutationNodeLimit) {
          state.captureTruncated = true;
          if (state.truncationReasons.indexOf('mutation-added-nodes') < 0) state.truncationReasons.push('mutation-added-nodes');
        }
        for (let i = 0; i < record.addedNodes.length && i < state.mutationNodeLimit; i++) {
          addMutationRoot(addedRoots, record.addedNodes[i]);
        }
      }
    }

    function inspectMutations(records) {
      const addedRoots = [];
      records.forEach(function (record) { inspectMutation(record, addedRoots); });
      addedRoots.forEach(inspectAdded);
    }

    function attach() {
      const resolved = findSurface();
      if (state.surface === resolved.surface && state.scrollContainer === resolved.scrollContainer && state.observer) return;
      if (state.observer) state.observer.disconnect();
      state.surface = resolved.surface;
      state.scrollContainer = resolved.scrollContainer;
      state.rowContainer = findRowContainer(state.surface);
      if (resolved.truncated) {
        state.captureTruncated = true;
        if (state.truncationReasons.indexOf('surface-walk') < 0) state.truncationReasons.push('surface-walk');
      }
      const surfaceNodes = boundedElements(state.surface, config.surfaceNodeLimit);
      state.surfaceNodeCount = surfaceNodes.elements.length;
      if (surfaceNodes.truncated) {
        state.captureTruncated = true;
        if (state.truncationReasons.indexOf('surface-count') < 0) state.truncationReasons.push('surface-count');
      }
      state.observer = new MutationObserver(function (records) {
        if (state.mutationRecordOverflow) return;
        if (state.mutationRecordsSinceDrain + records.length > state.mutationRecordLimit) {
          state.mutationRecordOverflow = true;
          notifyWaiters('mutation-overflow');
          return;
        }
        inspectMutations(records);
      });
      state.observer.observe(state.surface, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        // Presentation churn on the append-only Facebook surface is frequent
        // and does not change profile identity. Visibility changes stay
        // observable because they can make an existing row capturable.
        attributeFilter: ['href', 'aria-label', 'alt', 'hidden', 'aria-hidden'],
      });
      let initialLimit = 0;
      const bounded = boundedElements(state.surface, config.initialNodeLimit);
      if (bounded.truncated) {
        state.captureTruncated = true;
        if (state.truncationReasons.indexOf('initial-walk') < 0) state.truncationReasons.push('initial-walk');
      }
      bounded.elements.forEach(function (element) {
        if (element.matches('a[href]')) {
          enqueue(element);
          initialLimit++;
        }
      });
      state.initialAnchorCount += initialLimit;
      state.attachedCount++;
    }

    state.waitForEvent = function (timeoutMs) {
      attach();
      if (state.queue.length) return Promise.resolve('queued');
      return new Promise(function (resolve) {
        let settled = false;
        const finish = function (reason) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const index = state.waiters.indexOf(finish);
          if (index >= 0) state.waiters.splice(index, 1);
          resolve(reason);
        };
        const timer = setTimeout(function () { finish('timeout'); }, timeoutMs);
        state.waiters.push(finish);
      });
    };

    state.drain = function () {
      attach();
      state.rowContainer = findRowContainer(state.surface) || state.rowContainer || state.surface;
      const queued = state.queue.splice(0, state.queue.length);
      queued.forEach(function (entry) { state.pendingByAnchor.delete(entry.anchor); });
      const swept = scanDirectRows(state.rowContainer, config.rowLimit);
      const capturesByUrl = new Map();
      function mergeCapture(capture) {
        if (!capture || !capture.profileUrl) return;
        const existing = capturesByUrl.get(capture.profileUrl);
        if (!existing || (!existing.displayName && capture.displayName)) {
          capturesByUrl.set(capture.profileUrl, {
            displayName: capture.displayName || '',
            profileUrl: capture.profileUrl,
          });
        }
      }
      swept.captures.forEach(mergeCapture);
      queued.forEach(function (entry) {
        mergeCapture({ displayName: entry.displayName, profileUrl: entry.profileUrl });
      });
      const captures = Array.from(capturesByUrl.values());
      const mutationRecordsSinceDrain = state.mutationRecordsSinceDrain;
      const mutationRecordOverflow = state.mutationRecordOverflow;
      const memory = performance.memory || {};
      const container = state.scrollContainer;
      const surface = state.surface;
      const result = {
        captures: captures,
        dropped: state.dropped,
        queueOverflow: state.queueOverflow,
        mutationRecords: state.mutationRecords,
        mutationRecordsSinceDrain: mutationRecordsSinceDrain,
        mutationRecordOverflow: mutationRecordOverflow,
        captureTruncated: state.captureTruncated,
        truncationReasons: state.truncationReasons.slice(),
        initialAnchorCount: state.initialAnchorCount,
        attachedCount: state.attachedCount,
        queueHighWaterMark: state.queueHighWaterMark,
        queueLength: state.queue.length,
        surfaceNodeCount: state.surfaceNodeCount,
        rowSweepChildren: swept.childCount,
        rowSweepNamedRows: swept.namedRowCount,
        rowSweepBlankRows: swept.blankRowCount,
        rowSweepTruncated: swept.truncated,
        scrollTop: container ? Math.round(container.scrollTop || 0) : 0,
        scrollHeight: container ? Math.round(container.scrollHeight || 0) : 0,
        clientHeight: container ? Math.round(container.clientHeight || 0) : 0,
        usedJSHeapSize: Number.isFinite(memory.usedJSHeapSize) ? memory.usedJSHeapSize : null,
        totalJSHeapSize: Number.isFinite(memory.totalJSHeapSize) ? memory.totalJSHeapSize : null,
        jsHeapSizeLimit: Number.isFinite(memory.jsHeapSizeLimit) ? memory.jsHeapSizeLimit : null,
      };
      state.mutationRecordsSinceDrain = 0;
      state.mutationRecordOverflow = false;
      return result;
    };

    state.scroll = function () {
      attach();
      const container = state.scrollContainer;
      if (!container) return Promise.resolve({ moved: false, atEnd: true });
      const before = Math.round(container.scrollTop || 0);
      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const nextTop = Math.min(maxTop, before + Math.max(240, Math.floor(container.clientHeight * 0.85)));
      return new Promise(function (resolve) {
        let settled = false;
        const finish = function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          container.removeEventListener('scroll', finish);
          resolve({
            moved: Math.round(container.scrollTop || 0) !== before,
            atEnd: Math.round(container.scrollTop || 0) >= maxTop - 2,
            scrollTop: Math.round(container.scrollTop || 0),
            scrollHeight: Math.round(container.scrollHeight || 0),
            clientHeight: Math.round(container.clientHeight || 0),
          });
        };
        const timer = setTimeout(finish, 250);
        container.addEventListener('scroll', finish, { once: true, passive: true });
        if (container === document.scrollingElement) {
          window.scrollTo(0, nextTop);
        } else {
          container.scrollTo({ top: nextTop, behavior: 'auto' });
        }
        if (nextTop === before) finish();
      });
    };

    state.dispose = function () {
      state.disposed = true;
      if (state.observer) state.observer.disconnect();
      notifyWaiters('disposed');
      state.queue.length = 0;
      state.pendingByAnchor.clear();
    };
    window.__fgCaptureSession = state;
    attach();
    return state.drain();
  }, {
    queueLimit: CAPTURE_QUEUE_LIMIT,
    mutationNodeLimit: CAPTURE_MUTATION_NODE_LIMIT,
    mutationRecordLimit: CAPTURE_MUTATION_RECORD_LIMIT,
    initialNodeLimit: CAPTURE_INITIAL_NODE_LIMIT,
    surfaceNodeLimit: CAPTURE_INITIAL_NODE_LIMIT,
    rowLimit: CAPTURE_ROW_LIMIT,
    rowProbeLimit: Math.min(CAPTURE_ROW_LIMIT, 64),
    rowLinkLimit: 64,
  }).catch(function () { return null; });
}

async function waitForFollowerCapture(page, timeoutMs) {
  const startedAt = Date.now();
  const reason = await page.evaluate(function (timeout) {
    const state = window.__fgCaptureSession;
    if (!state || typeof state.waitForEvent !== 'function') return 'missing';
    return state.waitForEvent(timeout);
  }, timeoutMs).catch(function () { return 'error'; });
  return { reason: reason, waitMs: Date.now() - startedAt };
}

async function drainFollowerCapture(page) {
  const startedAt = Date.now();
  const data = await page.evaluate(function () {
    const state = window.__fgCaptureSession;
    return state && typeof state.drain === 'function' ? state.drain() : null;
  }).catch(function () { return null; });
  return { data: data, durationMs: Date.now() - startedAt };
}

async function scrollFollowers(page) {
  return page.evaluate(function () {
    const state = window.__fgCaptureSession;
    return state && typeof state.scroll === 'function' ? state.scroll() : null;
  }).catch(function () { return null; });
}

async function disposeFollowerCapture(page) {
  await page.evaluate(function () {
    const state = window.__fgCaptureSession;
    if (state && typeof state.dispose === 'function') state.dispose();
    delete window.__fgCaptureSession;
  }).catch(function () {});
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
        loadError = safeText((err && err.message) || err);
        logProgress('loading', 'Navigation attempt ' + attempt + ' failed, retrying...');
        await sleep(3000);
      }
    }
    if (!loaded) {
      logProgress('error', 'Could not load followers page.', { active: false, stopReason: 'navigation-failed', error: loadError });
      return { ok: false, authenticated: true, error: 'Could not load followers page: ' + loadError };
    }
    await page.waitForFunction(function () {
      return !!document.querySelector('[role="dialog"], [role="main"]');
    }, { timeout: postScrollWaitMs }).catch(function () {});

    logProgress('auth', 'Checking Facebook login state...');
    const auth = await checkAuth(page, null);
    if (!auth.authenticated) {
      logProgress('error', 'Not authenticated.', { active: false, stopReason: 'auth-required', error: auth.message });
      return { ok: false, authenticated: false, error: 'AUTH_REQUIRED: ' + auth.message };
    }
    logProgress('scrolling', 'Authenticated. Starting scroll and capture...');

    const installed = await installFollowerCapture(page);
    if (!installed) {
      logProgress('error', 'Could not attach the bounded follower capture.', { active: false, stopReason: 'capture-unavailable', error: 'CAPTURE_UNAVAILABLE' });
      return { ok: false, authenticated: true, error: 'CAPTURE_UNAVAILABLE: followers surface was not available.' };
    }

    const seen = new Map();
    let totalEncountered = 0;
    let nameUpgrades = 0;
    let emptyStreak = 0;
    let scrollAttempts = 0;
    let stopReason = 'max-attempts-reached';
    let profileCapReached = false;
    let profileCapSkippedUnique = 0;
    const telemetry = {
      captureWaitMs: 0,
      captureReadMs: 0,
      captureBatches: 0,
      captureRecords: 0,
      mutationRecords: 0,
      mutationRecordsSinceDrain: 0,
      initialAnchorCount: 0,
      attachedSurfaces: 0,
      queueHighWaterMark: 0,
      queueDrops: 0,
      queueOverflow: false,
      captureTruncated: false,
      mutationRecordOverflow: false,
      truncationReasons: [],
      surfaceNodeCount: 0,
      rowSweepChildren: 0,
      rowSweepNamedRows: 0,
      rowSweepBlankRows: 0,
      rowSweepTruncated: false,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      browserUsedJSHeapSize: null,
      browserTotalJSHeapSize: null,
      browserJsHeapSizeLimit: null,
      nodeHeapUsedBytes: 0,
      nodeRssBytes: 0,
      lastCaptureAt: null,
    };
    const waitTimeoutMs = Math.max(scrollDelayMs, postScrollWaitMs);

    function updateTelemetry(sample, readMs, waitMs) {
      if (waitMs) telemetry.captureWaitMs += waitMs;
      if (readMs) telemetry.captureReadMs += readMs;
      if (!sample) return;
      telemetry.captureBatches++;
      telemetry.captureRecords += sample.captures.length;
      telemetry.mutationRecords = sample.mutationRecords;
      telemetry.mutationRecordsSinceDrain = sample.mutationRecordsSinceDrain;
      telemetry.initialAnchorCount = sample.initialAnchorCount;
      telemetry.attachedSurfaces = sample.attachedCount;
      telemetry.queueHighWaterMark = sample.queueHighWaterMark;
      telemetry.queueDrops = sample.dropped;
      telemetry.queueOverflow = sample.queueOverflow;
      telemetry.captureTruncated = sample.captureTruncated;
      telemetry.mutationRecordOverflow = sample.mutationRecordOverflow;
      telemetry.truncationReasons = sample.truncationReasons;
      telemetry.surfaceNodeCount = sample.surfaceNodeCount;
      telemetry.rowSweepChildren = sample.rowSweepChildren;
      telemetry.rowSweepNamedRows = sample.rowSweepNamedRows;
      telemetry.rowSweepBlankRows = sample.rowSweepBlankRows;
      telemetry.rowSweepTruncated = sample.rowSweepTruncated;
      telemetry.scrollTop = sample.scrollTop;
      telemetry.scrollHeight = sample.scrollHeight;
      telemetry.clientHeight = sample.clientHeight;
      telemetry.browserUsedJSHeapSize = sample.usedJSHeapSize;
      telemetry.browserTotalJSHeapSize = sample.totalJSHeapSize;
      telemetry.browserJsHeapSizeLimit = sample.jsHeapSizeLimit;
      telemetry.nodeHeapUsedBytes = process.memoryUsage().heapUsed;
      telemetry.nodeRssBytes = process.memoryUsage().rss;
      telemetry.lastCaptureAt = Date.now();
      progress.telemetry = Object.assign({}, telemetry);
    }

    function captureFailureReason(sample) {
      if (!sample) return 'capture-unavailable';
      if (sample.mutationRecordOverflow) return 'mutation-record-overflow';
      if (sample.captureTruncated) return 'capture-truncated';
      if (sample.rowSweepTruncated) return 'capture-truncated';
      if (sample.queueOverflow || sample.dropped > 0) return 'capture-buffer-overflow';
      return '';
    }

    function processCaptures(captures) {
      let fresh = 0;
      let upgrades = 0;
      let rejectedHref = 0;
      let rejectedSelf = 0;
      for (const sighting of captures) {
        if (!isProfileHref(sighting.profileUrl)) { rejectedHref++; continue; }
        const key = normalizeUrl(sighting.profileUrl);
        if (!key) { rejectedHref++; continue; }
        if (selfId && identityOf(sighting.profileUrl) === selfId) { rejectedSelf++; continue; }
        totalEncountered++;
        const displayName = String(sighting.displayName || '').trim();
        const existing = seen.get(key);
        if (!existing) {
          if (seen.size >= MAX_CANONICAL_PROFILES) {
            profileCapReached = true;
            profileCapSkippedUnique++;
            break;
          }
          seen.set(key, { displayName: displayName, profileUrl: key });
          fresh++;
        } else if (!existing.displayName && displayName) {
          existing.displayName = displayName;
          nameUpgrades++;
          upgrades++;
        }
      }
      return { fresh: fresh, upgrades: upgrades, rejectedHref: rejectedHref, rejectedSelf: rejectedSelf, captured: captures.length };
    }

    function currentStats() {
      return {
        totalEncountered: totalEncountered,
        anchorSightings: totalEncountered,
        anchorRepeats: Math.max(0, totalEncountered - seen.size - profileCapSkippedUnique),
        profileCapSkipped: profileCapSkippedUnique,
        nameUpgrades: nameUpgrades,
        uniqueFollowers: seen.size,
        scrollAttempts: scrollAttempts,
        stopReason: stopReason,
        runLabel: String(opts.runLabel || ''),
        telemetry: Object.assign({}, telemetry, {
          elapsedMs: Date.now() - progress.startedAt,
        }),
      };
    }

    function logCapture(label, result) {
      logProgress(
        'scrolling',
        label + ': +' + result.fresh + ' new (unique ' + seen.size + ', sightings ' + totalEncountered +
          ', repeats ' + Math.max(0, totalEncountered - seen.size - profileCapSkippedUnique) + ', upgrades ' + nameUpgrades +
          ') — ' + result.captured + ' captures, ' + result.rejectedHref + ' rejected, ' + result.rejectedSelf + ' self',
        {
          scrollAttempts: scrollAttempts,
          totalEncountered: totalEncountered,
          anchorSightings: totalEncountered,
          anchorRepeats: Math.max(0, totalEncountered - seen.size - profileCapSkippedUnique),
          profileCapSkipped: profileCapSkippedUnique,
          nameUpgrades: nameUpgrades,
          uniqueFollowers: seen.size,
          telemetry: Object.assign({}, telemetry, { elapsedMs: Date.now() - progress.startedAt }),
        }
      );
    }

    const initialDrain = await drainFollowerCapture(page);
    updateTelemetry(initialDrain.data, initialDrain.durationMs, 0);
    const initialResult = processCaptures(initialDrain.data ? initialDrain.data.captures : []);
    emptyStreak = (initialResult.fresh > 0 || initialResult.upgrades > 0) ? 0 : 1;
    logCapture('Initial capture', initialResult);
    const initialCaptureFailure = captureFailureReason(initialDrain.data);
    if (initialCaptureFailure) stopReason = initialCaptureFailure;
    if (profileCapReached) stopReason = 'canonical-profile-cap-reached';

    while (scrollAttempts < maxScrolls && emptyStreak < emptyThreshold && stopReason === 'max-attempts-reached') {
      if (cancelRequested) {
        stopReason = 'canceled';
        break;
      }
      const url = page.url();
      if (/login|checkpoint|two_step|captcha/i.test(url)) {
        stopReason = 'auth-lost';
        logProgress('error', 'Session challenged mid-run.', { active: false, stopReason: 'auth-lost', error: 'AUTH_REQUIRED: session challenged mid-run.' });
        return { ok: false, authenticated: false, error: 'AUTH_REQUIRED: session challenged mid-run.', stats: currentStats() };
      }
      const scrollInfo = await scrollFollowers(page);
      scrollAttempts++;
      if (!scrollInfo) {
        stopReason = 'capture-unavailable';
        break;
      }
      const waited = await waitForFollowerCapture(page, waitTimeoutMs);
      if (waited.reason === 'missing' || waited.reason === 'error' || waited.reason === 'disposed') {
        stopReason = 'capture-unavailable';
        break;
      }
      const drained = await drainFollowerCapture(page);
      if (!drained.data) {
        stopReason = 'capture-unavailable';
        break;
      }
      updateTelemetry(drained.data, drained.durationMs, waited.waitMs);
      const result = processCaptures(drained.data.captures);
      emptyStreak = (result.fresh > 0 || result.upgrades > 0) ? 0 : emptyStreak + 1;
      logCapture('Scroll ' + scrollAttempts, result);
      const captureFailure = captureFailureReason(drained.data);
      if (captureFailure) {
        stopReason = captureFailure;
        break;
      }
      if (profileCapReached) {
        stopReason = 'canonical-profile-cap-reached';
        break;
      }
      if (cancelRequested) {
        stopReason = 'canceled';
        break;
      }
      if (emptyStreak >= emptyThreshold) {
        stopReason = 'empty-threshold-reached';
        break;
      }
    }
    if (cancelRequested && stopReason === 'max-attempts-reached') stopReason = 'canceled';
    if (stopReason === 'max-attempts-reached' && scrollAttempts < maxScrolls && emptyStreak >= emptyThreshold) {
      stopReason = 'empty-threshold-reached';
    }
    const profiles = Array.from(seen.values());
    const stats = currentStats();
    logProgress('done', 'Finished: ' + seen.size + ' unique followers (' + stopReason + ').', {
      active: false,
      stopReason: stopReason,
      uniqueFollowers: seen.size,
      telemetry: stats.telemetry,
    });
    return {
      ok: true,
      authenticated: true,
      profiles: profiles,
      stats: stats,
    };
  } finally {
    await disposeFollowerCapture(page);
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
        const safeError = safeText((err && err.message) || err);
        logProgress('error', 'Collection crashed.', { active: false, error: safeError });
        sendJson(res, 500, { ok: false, error: safeError });
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
    sendJson(res, 500, { ok: false, error: safeText((err && err.message) || err) });
  }
});

server.listen(PORT, BIND, function () {
  // Counts only — never log follower names, URLs, or page content.
  console.log('fb-followers-collector listening on http://' + BIND + ':' + PORT);
  console.log('profile: ' + PROFILE_DIR + ' headless: ' + HEADLESS);
});
