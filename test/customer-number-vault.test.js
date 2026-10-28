'use strict';

const assert = require('node:assert/strict');
const {
  emptyState, normalizePhoneNumber, upsertPhone, markGroupDeleted, stats, toCsv
} = require('../src/customer-number-vault');

let state = emptyState();
assert.equal(normalizePhoneNumber('0712 345 678', '255'), '+255712345678');
assert.equal(normalizePhoneNumber('00255-712-345-678'), '+255712345678');
assert.equal(normalizePhoneNumber('bad-number'), '');

let result = upsertPhone(state, { phone:'+255 712 345 678', sourceType:'whatsapp', accountName:'WS-01' });
assert.equal(result.ok, true);
assert.equal(result.inserted, true);
state = result.state;
result = upsertPhone(state, { phone:'00255 712 345 678', sourceType:'group', accountName:'WS-01', groupName:'学员群' });
assert.equal(result.inserted, false);
state = result.state;
assert.equal(Object.keys(state.contacts).length, 1);
assert.equal(state.contacts['+255712345678'].sources.length, 2);
assert.equal(stats(state).total, 1);
assert.equal(stats(state).groups, 1);

state = markGroupDeleted(state, { groupName:'学员群' }).state;
assert.equal(stats(state).deletedGroups, 1);
assert.equal(Object.keys(state.contacts).length, 1);
assert.match(toCsv(state), /\+255712345678/);

console.log('customer-number-vault tests passed');
