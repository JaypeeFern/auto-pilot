'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const path = require('node:path');

const serverSource = fs.readFileSync(
  path.join(__dirname, '..', 'server.js'),
  'utf8'
);

test('drain resets the per-drain mutation budget before returning', function () {
  const drainStart = serverSource.indexOf('state.drain = function () {');
  const drainEnd = serverSource.indexOf('\n    state.scroll = function () {', drainStart);
  assert.notEqual(drainStart, -1, 'state.drain must exist');
  assert.notEqual(drainEnd, -1, 'state.drain must end before state.scroll');

  const drainSource = serverSource.slice(drainStart, drainEnd);
  const resetOffset = drainSource.indexOf('state.mutationRecordsSinceDrain = 0;');
  const overflowResetOffset = drainSource.indexOf('state.mutationRecordOverflow = false;');
  const returnOffset = drainSource.lastIndexOf('return result;');

  assert.notEqual(resetOffset, -1, 'drain must reset mutationRecordsSinceDrain');
  assert.notEqual(overflowResetOffset, -1, 'drain must reset mutationRecordOverflow');
  assert.notEqual(returnOffset, -1, 'drain must return its captured result');
  assert.ok(resetOffset < returnOffset, 'mutationRecordsSinceDrain reset must be reachable');
  assert.ok(overflowResetOffset < returnOffset, 'mutationRecordOverflow reset must be reachable');
});

test('observer ignores presentation churn and coalesces pending anchors', function () {
  assert.match(serverSource, /pendingByAnchor: new Map\(\)/);
  assert.match(serverSource, /pending\.profileUrl = profileUrl/);
  assert.match(serverSource, /attributeFilter: \['href', 'aria-label', 'alt', 'hidden', 'aria-hidden'\]/);
  assert.doesNotMatch(serverSource, /attributeFilter: \[[^\]]*'class'/);
  assert.match(serverSource, /record\.attributeName === 'hidden'/);
  assert.match(serverSource, /record\.attributeName === 'aria-hidden'/);
});

test('drain sweeps bounded direct follower rows and ignores blank placeholders', function () {
  assert.match(serverSource, /const CAPTURE_ROW_LIMIT = clampInt\(/);
  assert.match(serverSource, /function firstFacebookLink\(row\)/);
  assert.match(serverSource, /const displayName = \(link\.textContent \|\| ''\)\.trim\(\);/);
  assert.match(serverSource, /function scanDirectRows\(container, limit\)/);
  assert.match(serverSource, /const children = container && container\.children \? container\.children : \[\];/);
  assert.match(serverSource, /truncated: children\.length > limit/);
  assert.match(serverSource, /const swept = scanDirectRows\(state\.rowContainer, config\.rowLimit\);/);
  assert.match(serverSource, /swept\.captures\.forEach\(mergeCapture\);/);
  assert.match(serverSource, /rowSweepTruncated: swept\.truncated/);
});

test('direct row sweep keeps Facebook host filtering before Node profile validation', function () {
  assert.match(serverSource, /function isFacebookHref\(href\)/);
  assert.match(serverSource, /if \(!displayName \|\| !isFacebookHref\(href\) \|\| !isVisible\(link\)\) continue;/);
  assert.match(serverSource, /if \(!isProfileHref\(sighting\.profileUrl\)\) \{ rejectedHref\+\+; continue; \}/);
  assert.match(serverSource, /if \(selfId && identityOf\(sighting\.profileUrl\) === selfId\) \{ rejectedSelf\+\+; continue; \}/);
});
