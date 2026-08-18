// league-sync.js
// -----------------------------------------------------------------------
// Live Sleeper LEAGUE sync: standings, rosters, live matchup points.
// Fully independent of the existing Draft Sync in app.js/sleeper-worker.js —
// different Sleeper ID (League ID, not Draft ID), its own worker, its own
// localStorage keys, its own view container (#league-sync-container).
// That container is shown/hidden by app.js's filterPos() as the content of
// the "🏟️ League Board" tab. Does not modify or depend on any existing
// draft-board state (players[], stateTracker, playerDraftMap).
//
// Requires app.js to load FIRST (uses sanitizePlainText(), showToast(),
// flagInvalidField() which already exist there). Include this script tag
// AFTER app.js in index.html.
// -----------------------------------------------------------------------

let leagueSyncActive = false;
let leagueSyncWorker = null;
let leagueSyncId = '';
let leagueSyncCurrentWeek = 1;
let leagueSyncLastData = null; // { league, rosters, users, matchups, week }
let sleeperPlayersDb = null;   // { [sleeper_player_id]: { n, p, t, inj } }

const SLEEPER_PLAYERS_CACHE_KEY = 'god_tier_sleeper_players_db_v1';
const SLEEPER_PLAYERS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — Sleeper
// asks integrators not to hit /v1/players/nfl more than ~once/day since the
// raw payload is 5-10MB+ covering every player in the league.

const LEAGUE_SYNC_ACTIVE_KEY = 'god_tier_sleeper_league_active';
const SLEEPER_TEAM_NAMES_CACHE_KEY = 'god_tier_sleeper_team_names_v1';

// --- Shrinks Sleeper's full player dump down to just what we render ---
function compactPlayersDb(raw) {
    const out = {};
    for (const id in raw) {
        const p = raw[id];
        if (!p) continue;
        out[id] = {
            n: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Unknown',
            p: p.position || (p.fantasy_positions && p.fantasy_positions[0]) || '',
            t: p.team || 'FA',
            inj: p.injury_status || null
        };
    }
    return out;
}

async function loadSleeperPlayersDb(forceRefresh = false) {
    if (sleeperPlayersDb && !forceRefresh) return sleeperPlayersDb;

    if (!forceRefresh) {
        try {
            const cached = localStorage.getItem(SLEEPER_PLAYERS_CACHE_KEY);
            if (cached) {
                const parsed = JSON.parse(cached);
                if (parsed && parsed.savedAt && (Date.now() - parsed.savedAt) < SLEEPER_PLAYERS_CACHE_TTL_MS) {
                    sleeperPlayersDb = parsed.data;
                    return sleeperPlayersDb;
                }
            }
        } catch (e) { /* corrupted cache — fall through and refetch */ }
    }

    const res = await fetch('https://api.sleeper.app/v1/players/nfl');
    if (!res.ok) throw new Error(`Failed to fetch Sleeper players DB: HTTP ${res.status}`);
    const raw = await res.json();
    sleeperPlayersDb = compactPlayersDb(raw);

    try {
        localStorage.setItem(SLEEPER_PLAYERS_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data: sleeperPlayersDb }));
    } catch (e) {
        console.log('Could not cache Sleeper players DB locally (storage full?) — will refetch next load.', e);
    }
    return sleeperPlayersDb;
}

function extractLeagueId(val) {
    if (!val) return '';
    val = val.trim();
    const match = val.match(/\d{15,20}/);
    if (match) return match[0];
    return val.replace(/[^0-9]/g, '');
}

function saveLeagueSyncId(val) {
    leagueSyncId = extractLeagueId(val);
    const input = document.getElementById('sleeper-league-id');
    if (input) input.value = leagueSyncId;
    localStorage.setItem('god_tier_sleeper_league_id', leagueSyncId);
}

function initLeagueSyncUI() {
    const saved = localStorage.getItem('god_tier_sleeper_league_id');
    if (saved) {
        leagueSyncId = saved;
        const input = document.getElementById('sleeper-league-id');
        if (input) input.value = saved;
    }

    // Reapply the last-known real team names immediately on load, before any
    // fresh fetch has landed — otherwise League Board would flash back to
    // "Team N" for a few seconds every refresh, which is the "desync" feel
    // this is meant to avoid.
    try {
        const cachedNames = localStorage.getItem(SLEEPER_TEAM_NAMES_CACHE_KEY);
        if (cachedNames && typeof applyLeagueSyncTeamNames === 'function') {
            applyLeagueSyncTeamNames(JSON.parse(cachedNames));
        }
    } catch (e) { /* corrupted cache — ignore, fresh data will fix it */ }

    // If sync was left ON before the page got refreshed, reconnect
    // automatically instead of sitting "disconnected" until the user clicks
    // Connect again.
    const wasActive = localStorage.getItem(LEAGUE_SYNC_ACTIVE_KEY) === 'true';
    if (wasActive && saved) {
        connectLeagueSync(saved, { silent: true });
    }
}

async function toggleLeagueSync() {
    const input = document.getElementById('sleeper-league-id');
    const id = extractLeagueId(input ? input.value : leagueSyncId);
    if (!id) return flagInvalidField(input, 'Please enter a valid Sleeper League ID or URL!');

    if (leagueSyncActive) {
        disconnectLeagueSync();
    } else {
        await connectLeagueSync(id);
    }
}

// opts.silent skips the "Connected!" toast — used on page-load auto-reconnect
// so it doesn't look like a fresh action the user just took.
async function connectLeagueSync(id, opts = {}) {
    leagueSyncActive = true;
    leagueSyncId = id;
    saveLeagueSyncId(id);
    localStorage.setItem(LEAGUE_SYNC_ACTIVE_KEY, 'true');

    const btn = document.getElementById('league-sync-btn');
    const status = document.getElementById('league-sync-status');
    if (btn) btn.innerText = 'Disconnect';
    if (status) { status.innerText = '🟡 Loading player DB…'; status.style.color = '#f59e0b'; }

    try {
        await loadSleeperPlayersDb();
    } catch (e) {
        console.log('Player DB load failed — roster names will fall back to raw IDs:', e);
    }

    if (status) { status.innerText = '🟢 Syncing'; status.style.color = 'var(--accent-green)'; }
    startLeagueSyncWorker(id);
    if (!opts.silent) showToast('🏆 Connected to League Sync!');
}

function disconnectLeagueSync() {
    leagueSyncActive = false;
    localStorage.setItem(LEAGUE_SYNC_ACTIVE_KEY, 'false');
    stopLeagueSyncWorker();

    const btn = document.getElementById('league-sync-btn');
    const status = document.getElementById('league-sync-status');
    if (btn) btn.innerText = 'Connect';
    if (status) { status.innerText = '🔴 Off'; status.style.color = 'var(--text-muted)'; }
    showToast('🔴 League Sync disconnected');
}

function startLeagueSyncWorker(id) {
    stopLeagueSyncWorker();
    try {
        leagueSyncWorker = new Worker('./sleeper-league-worker.js');
        leagueSyncWorker.onmessage = handleLeagueSyncMessage;
        leagueSyncWorker.onerror = (err) => {
            console.log('League sync worker crashed:', err.message);
        };
        leagueSyncWorker.postMessage({ type: 'start', leagueId: id });
    } catch (e) {
        console.log('Web Worker unavailable for league sync:', e);
    }
}

function stopLeagueSyncWorker() {
    if (leagueSyncWorker) {
        try { leagueSyncWorker.postMessage({ type: 'stop' }); } catch (e) {}
        leagueSyncWorker.terminate();
        leagueSyncWorker = null;
    }
}

function handleLeagueSyncMessage(e) {
    const msg = e.data || {};
    if (msg.type === 'nflState') {
        if (msg.state && msg.state.week) leagueSyncCurrentWeek = msg.state.week;
    } else if (msg.type === 'leagueData') {
        leagueSyncLastData = msg;
        renderLeagueSyncView();
        syncTeamNamesFromLeagueData(msg);
    } else if (msg.type === 'error') {
        console.log('League sync fetch error:', msg.context, msg.message);
    }
}

// --- Builds { draftSlot: realTeamName } from the worker's league payload
// and pushes it into the draft board via app.js's applyLeagueSyncTeamNames.
// Needs the draft's slot_to_roster_id (fetched by the worker) — leagues
// without a linked draft yet (e.g. pre-draft dynasty offseason) just won't
// have it, so this quietly no-ops until it does.
function buildSlotTeamNameMap(data) {
    if (!data || !data.slotToRosterId) return null;
    const { rosters, users, slotToRosterId } = data;

    const userMap = {};
    (users || []).forEach(u => {
        userMap[u.user_id] = (u.metadata && u.metadata.team_name) || u.display_name || null;
    });
    const rosterOwnerMap = {};
    (rosters || []).forEach(r => { rosterOwnerMap[r.roster_id] = r.owner_id; });

    const out = {};
    Object.keys(slotToRosterId).forEach(slot => {
        const ownerId = rosterOwnerMap[slotToRosterId[slot]];
        const teamName = ownerId ? userMap[ownerId] : null;
        if (teamName) out[slot] = teamName;
    });
    return Object.keys(out).length ? out : null;
}

function syncTeamNamesFromLeagueData(data) {
    const nameMap = buildSlotTeamNameMap(data);
    if (!nameMap) return;

    if (typeof applyLeagueSyncTeamNames === 'function') applyLeagueSyncTeamNames(nameMap);

    try {
        localStorage.setItem(SLEEPER_TEAM_NAMES_CACHE_KEY, JSON.stringify(nameMap));
    } catch (e) {
        console.log('Could not cache Sleeper team names locally (storage full?):', e);
    }
}

function getSleeperPlayerDisplay(sleeperPlayerId) {
    if (!sleeperPlayersDb) return { n: `#${sleeperPlayerId}`, p: '', t: '' };
    return sleeperPlayersDb[sleeperPlayerId] || { n: `Unknown (${sleeperPlayerId})`, p: '', t: '' };
}

function renderLeagueSyncView() {
    const container = document.getElementById('league-sync-container');
    if (!container) return;

    if (!leagueSyncLastData) {
        container.innerHTML = `
            <div class="empty-text" style="padding:60px 20px; text-align:center;">
                🏆 Enter your Sleeper League ID above (⚡ League Sync) and hit Connect<br>
                to see live standings & rosters here.
            </div>
        `;
        return;
    }

    const { rosters, users, matchups, week } = leagueSyncLastData;

    const userMap = {};
    (users || []).forEach(u => {
        userMap[u.user_id] = (u.metadata && u.metadata.team_name) || u.display_name || 'Unnamed Team';
    });

    const matchupByRoster = {};
    (matchups || []).forEach(m => { matchupByRoster[m.roster_id] = m; });

    // --- Standings: sorted by Wins desc, then Points For desc ---
    const standingsRows = (rosters || []).slice().sort((a, b) => {
        const aw = (a.settings && a.settings.wins) || 0, bw = (b.settings && b.settings.wins) || 0;
        if (bw !== aw) return bw - aw;
        const apf = ((a.settings && a.settings.fpts) || 0) + ((a.settings && a.settings.fpts_decimal) || 0) / 100;
        const bpf = ((b.settings && b.settings.fpts) || 0) + ((b.settings && b.settings.fpts_decimal) || 0) / 100;
        return bpf - apf;
    }).map((r, idx) => {
        const teamName = sanitizePlainText(userMap[r.owner_id] || `Roster ${r.roster_id}`);
        const w = (r.settings && r.settings.wins) || 0, l = (r.settings && r.settings.losses) || 0, t = (r.settings && r.settings.ties) || 0;
        const pf = (((r.settings && r.settings.fpts) || 0) + ((r.settings && r.settings.fpts_decimal) || 0) / 100).toFixed(2);
        const pa = (((r.settings && r.settings.fpts_against) || 0) + ((r.settings && r.settings.fpts_against_decimal) || 0) / 100).toFixed(2);
        const liveMatchup = matchupByRoster[r.roster_id];
        const livePts = liveMatchup ? Number(liveMatchup.points || 0).toFixed(2) : '-';
        return `
            <tr>
                <td>${idx + 1}</td>
                <td class="left"><b>${teamName}</b></td>
                <td>${w}-${l}${t ? '-' + t : ''}</td>
                <td>${pf}</td>
                <td>${pa}</td>
                <td>${livePts}</td>
            </tr>
        `;
    }).join('');

    // --- Roster cards: starters first, names resolved via the Sleeper players DB ---
    const rosterCards = (rosters || []).map(r => {
        const teamName = sanitizePlainText(userMap[r.owner_id] || `Roster ${r.roster_id}`);
        const starters = new Set(r.starters || []);
        const allPlayers = (r.players || []).slice().sort((a, b) => (starters.has(b) ? 1 : 0) - (starters.has(a) ? 1 : 0));

        const rowsHtml = allPlayers.map(pid => {
            const info = getSleeperPlayerDisplay(pid);
            const isStarter = starters.has(pid);
            const posLabel = info.p === 'DEF' ? 'DST' : (info.p || '-');
            const posClass = 'pos-' + (info.p === 'DEF' ? 'dst' : (info.p || 'na')).toLowerCase();
            const injuryTag = info.inj ? ` <span style="color:#ef4444; font-size:11px;">(${sanitizePlainText(info.inj)})</span>` : '';
            return `
                <div class="team-player-row">
                    <span class="team-player-name">${isStarter ? '⭐ ' : ''}${sanitizePlainText(info.n)}${injuryTag} <span style="color:var(--text-muted); font-size:12px;">(${sanitizePlainText(info.t)})</span></span>
                    <span class="badge ${posClass}">${posLabel}</span>
                </div>
            `;
        }).join('') || '<div class="empty-text">No players rostered</div>';

        return `
            <div class="team-card">
                <div class="team-card-header">
                    <div class="team-title-box"><span class="team-title">${teamName}</span></div>
                    <span class="team-count-badge">${(r.players || []).length} Players</span>
                </div>
                <div class="team-roster-list">${rowsHtml}</div>
            </div>
        `;
    }).join('');

    container.innerHTML = `
        <div class="roster-card-section" style="margin-bottom:20px;">
            <div class="roster-card-header">
                <h3>🏆 Live Standings</h3>
                <span class="roster-subtext">Week ${week || leagueSyncCurrentWeek} — updates automatically every 20s</span>
            </div>
            <table style="margin-top:10px;">
                <thead>
                    <tr><th>#</th><th class="left">Team</th><th>Record</th><th>PF</th><th>PA</th><th>Live Pts (Wk ${week || leagueSyncCurrentWeek})</th></tr>
                </thead>
                <tbody>${standingsRows}</tbody>
            </table>
        </div>
        <div class="roster-card-section">
            <div class="roster-card-header">
                <h3>📋 Live Rosters</h3>
                <span class="roster-subtext">⭐ = starting lineup this week</span>
            </div>
            <div class="league-teams-grid" style="margin-top:10px;">${rosterCards}</div>
        </div>
    `;
}

document.addEventListener('DOMContentLoaded', initLeagueSyncUI);