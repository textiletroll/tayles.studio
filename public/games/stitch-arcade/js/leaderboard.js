(function () {
  'use strict';

  const KEY = 'stitch-arcade.leaderboard.v1';
  const NAME_KEY = 'stitch-arcade.lastName.v1';
  const MAX = 10;

  function getLastName() {
    try {
      const v = localStorage.getItem(NAME_KEY);
      if (!v) return null;
      const cleaned = String(v).slice(0, 3).toUpperCase();
      return /^[A-Z]{3}$/.test(cleaned) ? cleaned : null;
    } catch (_) { return null; }
  }
  function setLastName(name) {
    try { localStorage.setItem(NAME_KEY, String(name).slice(0, 3).toUpperCase()); } catch (_) { /* quota */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) { return {}; }
  }

  function save(data) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (_) { /* quota / private mode */ }
  }

  function get(shapeId) {
    const all = load();
    return Array.isArray(all[shapeId]) ? all[shapeId] : [];
  }

  // Returns the rank (1-based) of the new entry if it makes the table, else 0.
  function submit(shapeId, name, score) {
    const all = load();
    const list = Array.isArray(all[shapeId]) ? all[shapeId].slice() : [];
    const entry = { name: (name || 'AAA').slice(0, 3).toUpperCase(), score: score | 0, ts: Date.now() };
    list.push(entry);
    list.sort((a, b) => b.score - a.score || a.ts - b.ts);
    const trimmed = list.slice(0, MAX);
    const rank = trimmed.indexOf(entry) + 1;
    all[shapeId] = trimmed;
    save(all);
    setLastName(entry.name);
    return rank;
  }

  function qualifies(shapeId, score) {
    const list = get(shapeId);
    if (list.length < MAX) return true;
    return score > list[list.length - 1].score;
  }

  function clear() { save({}); }

  window.Leaderboard = { get, submit, qualifies, clear, getLastName };
})();
