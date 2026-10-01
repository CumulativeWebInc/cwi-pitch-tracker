/*!
 * pitch.js — Pitch Tracker engine (CWI App Factory #56)
 * Zero-dependency UMD. Curator outreach pipeline: pitch records, status
 * transitions, follow-up nudge scheduling, and curator win-rate memory.
 * Schema: cwi.pitch-record/1.0
 * Truth labels: VERIFIED / UNVERIFIED / USER-ENTERED on every record.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PitchTracker = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var SCHEMA = 'cwi.pitch-record/1.0';
  var TRUTH_LABELS = ['VERIFIED', 'UNVERIFIED', 'USER-ENTERED'];

  // Lifecycle: queued -> sent -> replied -> placed -> holding  (dead exits anywhere)
  var STATUSES = ['queued', 'sent', 'replied', 'placed', 'holding', 'dead'];
  var STATUS_LABELS = {
    queued: 'Queued',
    sent: 'Sent — awaiting reply',
    replied: 'Replied',
    placed: 'Placed',
    holding: 'Holding',
    dead: 'Dead / lost'
  };
  var WON = { placed: true, holding: true };

  // Follow-up cadence (days after last activity) per status.
  var NUDGE_AFTER = { queued: 0, sent: 14, replied: 21, placed: 30, holding: 30, dead: 0 };
  var NUDGE_KIND = {
    queued: 'send the pitch',
    sent: 'follow-up nudge',
    replied: 'follow-up nudge',
    placed: 're-verify placement (rescan)',
    holding: 're-verify placement (rescan)',
    dead: 'none — closed'
  };

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayISO() { return isoDate(new Date()); }

  function parseDate(s) {
    if (!s || typeof s !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
    return d;
  }

  function addDays(dateISO, days) {
    var d = parseDate(dateISO);
    if (!d) return null;
    d.setDate(d.getDate() + days);
    return isoDate(d);
  }

  function daysBetween(aISO, bISO) {
    var a = parseDate(aISO), b = parseDate(bISO);
    if (!a || !b) return null;
    return Math.round((b - a) / 86400000);
  }

  function curatorSlug(name) {
    return String(name || '').toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function dedupeKey(p) {
    return curatorSlug(p.curator) + '|' + String(p.track || '').toLowerCase().trim() + '|' + String(p.venue || '').toLowerCase().trim();
  }

  // ---- validation ----
  function validatePitch(p) {
    var errors = [];
    if (!p || typeof p !== 'object') return { ok: false, errors: ['record must be an object'] };
    if (!p.curator || !String(p.curator).trim()) errors.push('curator is required');
    if (!p.track || !String(p.track).trim()) errors.push('track is required');
    if (STATUSES.indexOf(p.status) < 0) errors.push('status must be one of: ' + STATUSES.join(', '));
    if (TRUTH_LABELS.indexOf(p.truth) < 0) errors.push('truth must be one of: ' + TRUTH_LABELS.join(', '));
    if (!parseDate(p.date_pitched)) errors.push('date_pitched must be YYYY-MM-DD');
    if (p.last_activity && !parseDate(p.last_activity)) errors.push('last_activity must be YYYY-MM-DD');
    if (p.truth === 'VERIFIED' && !p.verified_on) errors.push('VERIFIED records must carry verified_on');
    if (p.truth === 'VERIFIED' && p.verified_on && !parseDate(p.verified_on)) errors.push('verified_on must be YYYY-MM-DD');
    if (p.schema && p.schema !== SCHEMA) errors.push('schema must be ' + SCHEMA);
    return { ok: errors.length === 0, errors: errors };
  }

  function normalizePitch(p) {
    var out = Object.assign({}, p);
    out.schema = SCHEMA;
    if (!out.id) {
      out.id = 'pit_' + Math.random().toString(36).slice(2, 10).toUpperCase();
    }
    if (!out.last_activity) out.last_activity = out.date_pitched;
    if (!out.channel) out.channel = 'unspecified';
    if (!out.venue_type) out.venue_type = 'playlist';
    return out;
  }

  // ---- nudge scheduling ----
  function lastActivity(p) { return p.last_activity || p.date_pitched; }

  function nextNudgeDate(p) {
    if (p.status === 'dead') return null;
    var days = NUDGE_AFTER[p.status];
    if (typeof days !== 'number') return null;
    return addDays(lastActivity(p), days);
  }

  function nudgeState(p, refISO) {
    if (p.status === 'dead') return 'NONE';
    var due = nextNudgeDate(p);
    if (!due) return 'NONE';
    var ref = refISO || todayISO();
    var diff = daysBetween(ref, due);
    if (diff === null) return 'UNKNOWN';
    if (diff < 0) return 'OVERDUE';
    if (diff <= 7) return 'DUE_SOON';
    return 'OK';
  }

  function nudgeAction(p, refISO) {
    var st = nudgeState(p, refISO);
    return {
      state: st,
      due: nextNudgeDate(p),
      kind: NUDGE_KIND[p.status] || 'review',
      copy: nudgeCopy(p)
    };
  }

  function nudgeCopy(p) {
    var c = p.curator, t = p.track, v = p.venue || 'their platform';
    if (p.status === 'sent' || p.status === 'replied') {
      return 'Hi ' + c + ' — following up on ' + t + ' for ' + v +
        '. Happy to resend the links or the one-sheet. — Cumulative Web Inc';
    }
    if (p.status === 'placed' || p.status === 'holding') {
      return 'Re-verify: rescan ' + v + ' for ' + t +
        ' and update verified_on; downgrade to sent if the add is gone.';
    }
    if (p.status === 'queued') {
      return 'Send the pitch: ' + t + ' → ' + c + ' (' + v + ').';
    }
    return '';
  }

  // ---- win-rate memory ----
  function isWon(p) { return !!WON[p.status]; }

  function curatorStats(pitches, curator) {
    var rows = pitches.filter(function (p) { return p.curator === curator; });
    var wins = rows.filter(isWon).length;
    var dead = rows.filter(function (p) { return p.status === 'dead'; }).length;
    return {
      curator: curator,
      pitches: rows.length,
      wins: wins,
      dead: dead,
      open: rows.length - wins - dead,
      win_rate: rows.length ? wins / rows.length : 0
    };
  }

  // Scoreboard: curators sorted by win_rate desc, then wins desc.
  function scoreboard(pitches) {
    var seen = {}, curators = [];
    pitches.forEach(function (p) {
      if (!seen[p.curator]) { seen[p.curator] = true; curators.push(p.curator); }
    });
    var rows = curators.map(function (c) { return curatorStats(pitches, c); });
    rows.sort(function (a, b) {
      return (b.win_rate - a.win_rate) || (b.wins - a.wins) || (b.pitches - a.pitches);
    });
    return rows;
  }

  function funnel(pitches) {
    var out = { total: pitches.length, wins: 0, dead: 0, open: 0, by_status: {} };
    STATUSES.forEach(function (s) { out.by_status[s] = 0; });
    pitches.forEach(function (p) {
      out.by_status[p.status] = (out.by_status[p.status] || 0) + 1;
      if (isWon(p)) out.wins++;
      else if (p.status === 'dead') out.dead++;
      else out.open++;
    });
    out.win_rate = out.total ? out.wins / out.total : 0;
    return out;
  }

  // ---- deep links ----
  function parseDeepLink(query) {
    var out = {};
    if (!query) return out;
    String(query).replace(/^[?#]/, '').split('&').forEach(function (pair) {
      var kv = pair.split('=');
      if (kv[0]) out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
    });
    return out;
  }

  function mergeLocal(seed, local) {
    var seen = {}, out = [];
    (local || []).forEach(function (p) { seen[dedupeKey(p)] = true; out.push(p); });
    (seed || []).forEach(function (p) {
      if (!seen[dedupeKey(p)]) out.push(p);
    });
    return out;
  }

  return {
    VERSION: VERSION,
    SCHEMA: SCHEMA,
    STATUSES: STATUSES,
    STATUS_LABELS: STATUS_LABELS,
    TRUTH_LABELS: TRUTH_LABELS,
    validatePitch: validatePitch,
    normalizePitch: normalizePitch,
    dedupeKey: dedupeKey,
    curatorSlug: curatorSlug,
    nextNudgeDate: nextNudgeDate,
    nudgeState: nudgeState,
    nudgeAction: nudgeAction,
    nudgeCopy: nudgeCopy,
    isWon: isWon,
    curatorStats: curatorStats,
    scoreboard: scoreboard,
    funnel: funnel,
    parseDeepLink: parseDeepLink,
    mergeLocal: mergeLocal,
    daysBetween: daysBetween,
    todayISO: todayISO
  };
}));
