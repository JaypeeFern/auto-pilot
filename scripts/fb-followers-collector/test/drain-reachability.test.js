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
