// sleeper-league-worker.js
// -----------------------------------------------------------------------
// Independent Web Worker for LEAGUE-level Sleeper sync (standings, rosters,
// matchups). Completely separate from sleeper-worker.js (which only does
// draft picks) — different ID (League ID, not Draft ID), different poll
// cadence, different endpoints.
// -----------------------------------------------------------------------

let leagueId = null;
let rosterTimer = null;
let stateTimer = null;
let currentWeek = 1;
let slotToRosterId = null; // { draftSlot: roster_id } — lets the UI match a
                            // real Sleeper team to the same slot numbering
                            // sleeper-worker.js already uses for draft picks
let cachedDraftId = null;  // avoids refetching the draft object every poll —
                            // slot assignments don't change mid-season

const ROSTER_POLL_MS = 20000;  // rosters/standings/matchups: don't need to be
                                // second-fast like draft picks — 20s is plenty
const STATE_POLL_MS = 300000;  // nfl week/season state changes ~weekly

async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
    return res.json();
}

async function pollState() {
    try {
        const state = await fetchJson('https://api.sleeper.app/v1/state/nfl');
        if (state && state.week) currentWeek = state.week;
        postMessage({ type: 'nflState', state });
    } catch (e) {
        postMessage({ type: 'error', context: 'state', message: String(e && e.message || e) });
    }
}

async function fetchSlotMapping(draftId) {
    try {
        const draft = await fetchJson(`https://api.sleeper.app/v1/draft/${draftId}`);
        if (draft && draft.slot_to_roster_id) {
            slotToRosterId = draft.slot_to_roster_id;
            cachedDraftId = draftId;
        }
    } catch (e) {
        // Non-fatal — the rest of the league data still renders fine, we
        // just won't be able to auto-name teams by draft slot this round.
        postMessage({ type: 'error', context: 'draftSlots', message: String(e && e.message || e) });
    }
}

async function pollLeague() {
    if (!leagueId) return;
    try {
        const [league, rosters, users, matchups] = await Promise.all([
            fetchJson(`https://api.sleeper.app/v1/league/${leagueId}`),
            fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/rosters`),
            fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/users`),
            fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/matchups/${currentWeek}`).catch(() => [])
        ]);

        // Draft-slot -> roster mapping only changes if the league gets a
        // brand new draft (basically never mid-season), so this is fetched
        // once per draft_id instead of on every 20s poll.
        if (league && league.draft_id && league.draft_id !== cachedDraftId) {
            await fetchSlotMapping(league.draft_id);
        }

        postMessage({ type: 'leagueData', league, rosters, users, matchups, week: currentWeek, slotToRosterId });
    } catch (e) {
        postMessage({ type: 'error', context: 'league', message: String(e && e.message || e) });
    }
}

function stopTimers() {
    if (rosterTimer) clearInterval(rosterTimer);
    if (stateTimer) clearInterval(stateTimer);
    rosterTimer = null;
    stateTimer = null;
}

self.onmessage = async (e) => {
    const msg = e.data || {};

    if (msg.type === 'start') {
        stopTimers();
        leagueId = (msg.leagueId || '').trim();
        if (!leagueId) return;

        await pollState();
        await pollLeague();

        stateTimer = setInterval(pollState, STATE_POLL_MS);
        rosterTimer = setInterval(pollLeague, ROSTER_POLL_MS);

    } else if (msg.type === 'stop') {
        stopTimers();
        leagueId = null;
        currentWeek = 1;
        slotToRosterId = null;
        cachedDraftId = null;
    }
};