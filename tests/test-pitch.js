'use strict';
/* Pitch Tracker engine tests — stdlib only. Exit 0 = all pass. */
var PT = require('../pitch.js');
var fs = require('fs');
var path = require('path');

var pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL: ' + name); }
}

var GOOD = { curator: 'Test Curator', track: 'Test Track', venue: 'Test Playlist',
  status: 'sent', truth: 'VERIFIED', date_pitched: '2026-09-14', verified_on: '2026-09-17' };

// --- validation ---
ok(PT.validatePitch(GOOD).ok, 'valid pitch validates');
var bad = PT.validatePitch(Object.assign({}, GOOD, { status: 'maybe' }));
ok(!bad.ok && bad.errors.length > 0, 'bad status rejected');
ok(!PT.validatePitch(Object.assign({}, GOOD, { truth: 'MAYBE' })).ok, 'bad truth rejected');
ok(!PT.validatePitch(Object.assign({}, GOOD, { date_pitched: '14/09/2026' })).ok, 'bad date rejected');
var unv = PT.validatePitch(Object.assign({}, GOOD, { truth: 'UNVERIFIED' }));
ok(unv.ok, 'UNVERIFIED without verified_on is valid');
var miss = PT.validatePitch(Object.assign({}, GOOD, { truth: 'VERIFIED', verified_on: '' }));
ok(!miss.ok, 'VERIFIED without verified_on rejected');

// --- nudge scheduling (fixed dates, no dependence on today) ---
var p1 = PT.normalizePitch({ curator: 'A', track: 'T', status: 'sent', date_pitched: '2026-09-14', last_activity: '2026-09-14' });
ok(PT.nextNudgeDate(p1) === '2026-09-28', 'sent nudges at +14 days');
ok(PT.nudgeState(p1, '2026-09-27') === 'DUE_SOON', 'day before due = DUE_SOON');
ok(PT.nudgeState(p1, '2026-09-29') === 'OVERDUE', 'day after due = OVERDUE');
ok(PT.nudgeState(p1, '2026-09-14') === 'OK', 'pitch day = OK');
var pDead = PT.normalizePitch({ curator: 'A', track: 'T', status: 'dead', date_pitched: '2026-09-14' });
ok(PT.nextNudgeDate(pDead) === null && PT.nudgeState(pDead, '2026-10-01') === 'NONE', 'dead has no nudge');
var pHold = PT.normalizePitch({ curator: 'A', track: 'T', status: 'holding', date_pitched: '2026-09-14', last_activity: '2026-10-01' });
ok(PT.nextNudgeDate(pHold) === '2026-10-31', 'holding re-verifies at +30 days');
ok(/Re-verify/.test(PT.nudgeCopy(pHold)), 'holding nudge copy is a re-verify task');
ok(/following up/.test(PT.nudgeCopy(p1)), 'sent nudge copy is a follow-up');

// --- win-rate memory ---
var rows = [
  PT.normalizePitch({ curator: 'Eric Alper', track: 'Z', status: 'holding', date_pitched: '2026-09-14' }),
  PT.normalizePitch({ curator: 'Audiartist', track: 'S', status: 'holding', date_pitched: '2026-09-14' }),
  PT.normalizePitch({ curator: 'Audiartist', track: 'Z', status: 'holding', date_pitched: '2026-09-14' }),
  PT.normalizePitch({ curator: 'Audiartist', track: 'D', status: 'holding', date_pitched: '2026-09-14' }),
  PT.normalizePitch({ curator: 'HHS', track: 'Z', status: 'sent', date_pitched: '2026-09-14' })
];
var f = PT.funnel(rows);
ok(f.total === 5 && f.wins === 4 && f.open === 1 && f.win_rate === 0.8, 'funnel math 4/5 = 80%');
var sb = PT.scoreboard(rows);
ok(sb[0].curator === 'Audiartist' && sb[0].win_rate === 1 && sb[1].curator === 'Eric Alper' && sb[1].win_rate === 1, 'scoreboard: 1.0-rate curators first, 3/3 before 1/1 on the wins tiebreak');
ok(sb[sb.length - 1].curator === 'HHS' && sb[sb.length - 1].win_rate === 0, '0-win curator last');
var st = PT.curatorStats(rows, 'Audiartist');
ok(st.pitches === 3 && st.wins === 3 && st.open === 0, 'curator stats per curator');
ok(PT.scoreboard([]).length === 0, 'empty scoreboard is empty');

// --- dedupe / merge ---
var seed = [{ curator: 'Eric Alper', track: 'Zooted Zone', venue: '360°', status: 'holding' }];
var local = [{ curator: 'New Curator', track: 'X', venue: 'Y', status: 'sent' }];
var merged = PT.mergeLocal(seed, local);
ok(merged.length === 2 && merged[0].curator === 'New Curator', 'mergeLocal: local first, then seed');
var dup = [{ curator: 'eric alper', track: 'zooted zone', venue: '360°', status: 'sent' }];
ok(PT.mergeLocal(seed, dup).length === 1, 'case-insensitive dedupe against seed');

// --- deep links ---
ok(PT.parseDeepLink('?curator=Eric%20Alper&status=holding').curator === 'Eric Alper', 'deep link parse');
ok(PT.curatorSlug('DJ 6Rings (Shan)') === 'dj-6rings-shan', 'curator slug');

// --- seed data integrity ---
var seedPath = path.join(__dirname, '..', 'pitches.json');
var seedDoc = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
ok(seedDoc.schema === 'cwi.pitch-feed/1.0', 'seed doc schema');
var allValid = seedDoc.pitches.every(function (p) { return PT.validatePitch(p).ok; });
ok(allValid, 'every seed pitch validates');
var verifiedDates = seedDoc.pitches.filter(function (p) { return p.truth === 'VERIFIED'; }).every(function (p) {
  return PT.daysBetween('2026-09-14', p.verified_on) >= 0;
});
ok(verifiedDates, 'VERIFIED dates not before the 2026-09-14 wave');
var unver = seedDoc.pitches.filter(function (p) { return p.truth === 'UNVERIFIED'; });
ok(unver.length >= 1, 'at least one UNVERIFIED outcome recorded (no outcome invention)');
ok(seedDoc.pitches.length >= 8, 'seed carries the full 2026-09-14 wave (8+ records)');
// placement positions match the verified record
var zz360 = seedDoc.pitches.filter(function (p) { return p.id === 'pit_EAC360'; })[0];
ok(zz360.position === '216 of 216' && zz360.venue_uri === 'spotify:playlist:0hsLLFaADDjU54tFqaImFh', 'Eric Alper record matches verified data');

// --- identity ---
ok(PT.VERSION === '1.0.0' && PT.SCHEMA === 'cwi.pitch-record/1.0', 'version/schema identity');
ok(PT.STATUSES.length === 6, '6 lifecycle statuses');

console.log('PASS ' + pass + '/' + (pass + fail));
process.exit(fail ? 1 : 0);
