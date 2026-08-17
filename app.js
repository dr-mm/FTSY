if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW registration failed: ', err));
    });
}

let weeklyStatsData = [];
async function loadWeeklyStatsJson() {
    try {
        const res = await fetch('weekly_stats.json?t=' + Date.now(), { cache: 'no-store' });
        if (res.ok) {
            weeklyStatsData = await res.json();
            console.log('✅ Weekly NFL Stats loaded successfully');
            updatePositionalRanks();
            renderCurrentActiveView();
        }
    } catch (e) {
        console.log('Weekly stats file not loaded yet or offline.');
    }
}

// --- PLAIN-TEXT SANITIZER (user-entered names/teams flow into innerHTML in
// many places across the board, roster, and modals; stripping angle brackets
// at the point of entry is simpler and safer than escaping every render site) ---
function sanitizePlainText(str) {
    if (str === undefined || str === null) return '';
    return String(str).replace(/[<>]/g, '').trim();
}

// --- UNIQUE ID GENERATOR (avoids Date.now() collisions on rapid adds) ---
function generateUniqueId() {
    let id = Date.now();
    const existingIds = new Set(players.map(p => p.id));
    while (existingIds.has(id)) id++;
    return id;
}

// --- UNIVERSAL HEADSHOT LOOKUP ($O(1)$ DIRECT ID BINDING) ---
function getPlayerHeadshot(p) {
    if (!p) return getFallbackAvatar();

    // 1. Defense / ST Team Logo
    if (p.pos === 'DST' || p.pos === 'DEF') {
        const teamCode = (p.team || '').toUpperCase();
        const logoCode = (teamCode === 'WAS') ? 'wsh' : teamCode.toLowerCase();
        return `https://a.espncdn.com/i/teamlogos/nfl/500/${logoCode}.png`;
    }

    // 2. Direct Sleeper ID Thumbnail (Exact Verified Photos)
    if (p.sleeperId) {
        return `https://sleepercdn.com/content/nfl/players/thumb/${p.sleeperId}.jpg`;
    }

    // 3. Direct ESPN ID Headshot
    if (p.espnId) {
        return `https://a.espncdn.com/i/headshots/nfl/players/full/${p.espnId}.png`;
    }

    // 4. Fallback SVG Silhouette
    return getFallbackAvatar();
}

function getFallbackAvatar() {
    return "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='50' fill='%231f2937'/><circle cx='50' cy='38' r='20' fill='%234b5563'/><path d='M20,88 C20,65 35,60 50,65 C65,60 80,65 80,88 Z' fill='%234b5563'/></svg>";
}

// --- RANK MOVEMENT TREND BADGE CALCULATOR ---
function getRankTrendBadge(p) {
    const curr = Number(p.rank);
    const prev = (p.prevRank !== undefined && p.prevRank !== null) ? Number(p.prevRank) : curr;
    const delta = prev - curr; // Positive delta = rank number got smaller = moved UP on Big Board

    if (delta > 0) {
        return `<span class="trend-pill trend-up" onclick="event.stopPropagation(); handleSort('trend')" title="Rose ${delta} spot${delta > 1 ? 's' : ''} (Previous: #${prev}). Click to sort by Rank Risers!">▲ ${delta}</span>`;
    } else if (delta < 0) {
        const absDelta = Math.abs(delta);
        return `<span class="trend-pill trend-down" onclick="event.stopPropagation(); handleSort('trend')" title="Fell ${absDelta} spot${absDelta > 1 ? 's' : ''} (Previous: #${prev}). Click to sort by Movement!">▼ ${absDelta}</span>`;
    } else {
        return `<span class="trend-pill trend-neutral" onclick="event.stopPropagation(); handleSort('trend')" title="No rank movement. Click to sort by Movement!">=</span>`;
    }
}

// --- BOARD SORTING STATE & HANDLERS ---
let currentSortColumn = 'rank';
let currentSortDirection = 'asc';

function handleSort(column) {
    if (currentSortColumn === column) {
        currentSortDirection = (currentSortDirection === 'asc') ? 'desc' : 'asc';
    } else {
        currentSortColumn = column;
        currentSortDirection = (column === 'trend' || column === 'ceiling') ? 'desc' : 'asc';
    }
    renderBoard();
}

function resetSortToDefault() {
    currentSortColumn = 'rank';
    currentSortDirection = 'asc';
    renderBoard();
}

function updateSortHeaderIcons() {
    const columns = ['rank', 'ceiling', 'name', 'team', 'bye', 'pos', 'tier'];
    columns.forEach(col => {
        const iconElem = document.getElementById(`sort-icon-${col}`);
        const thElem = iconElem ? iconElem.closest('th') : null;
        if (iconElem && thElem) {
            if (currentSortColumn === col || (col === 'rank' && currentSortColumn === 'trend')) {
                const arrow = currentSortDirection === 'asc' ? '▲' : '▼';
                iconElem.innerText = arrow;
                thElem.classList.add('active-sort');
            } else {
                iconElem.innerText = '↕';
                thElem.classList.remove('active-sort');
            }
        }
    });
}

function sortPlayerList(playerArray) {
    const list = [...playerArray];
    const mult = currentSortDirection === 'asc' ? 1 : -1;

    list.sort((a, b) => {
        switch (currentSortColumn) {
            case 'rank':
                return (a.rank - b.rank) * mult;
            case 'trend': {
                const prevA = (a.prevRank !== undefined && a.prevRank !== null) ? Number(a.prevRank) : Number(a.rank);
                const prevB = (b.prevRank !== undefined && b.prevRank !== null) ? Number(b.prevRank) : Number(b.rank);
                const deltaA = prevA - Number(a.rank);
                const deltaB = prevB - Number(b.rank);
                if (deltaA !== deltaB) return (deltaA - deltaB) * mult;
                return (a.rank - b.rank);
            }
            case 'ceiling': {
                const ceilA = Number(a.ceilingPosRank || a.posRank || 99);
                const ceilB = Number(b.ceilingPosRank || b.posRank || 99);
                if (ceilA !== ceilB) return (ceilA - ceilB) * mult;
                return (a.rank - b.rank);
            }
            case 'name':
                return a.name.localeCompare(b.name) * mult;
            case 'team': {
                const teamA = a.team || 'ZZZ';
                const teamB = b.team || 'ZZZ';
                return teamA.localeCompare(teamB) * mult;
            }
            case 'bye': {
                const byeA = (a.bye === '-' || !a.bye) ? 99 : Number(a.bye);
                const byeB = (b.bye === '-' || !b.bye) ? 99 : Number(b.bye);
                return (byeA - byeB) * mult;
            }
            case 'pos': {
                if (a.pos !== b.pos) return a.pos.localeCompare(b.pos) * mult;
                return (a.posRank - b.posRank) * mult;
            }
            case 'tier': {
                if (a.tier !== b.tier) return a.tier.localeCompare(b.tier) * mult;
                return (a.rank - b.rank) * mult;
            }
            default:
                return (a.rank - b.rank) * mult;
        }
    });
    return list;
}

// --- SLEEPER REAL-TIME DRAFT ENGINE ---
let sleeperWorker = null;
let sleeperSyncInterval = null;
let isSleeperSyncActive = false;
let sleeperDraftId = '';
let sleeperUsername = 'ViniAvila';
let sleeperOfficialUserId = null;
let sleeperConfirmedSlotFromPicks = null;
let sleeperProcessedPickNos = new Set();
let isInitialSleeperCatchup = false;
let sleeperSlotAutoDetected = false;
let sleeperSlotManuallySet = false;
let sleeperSlotHintShown = false;
let sleeperDraftDetailAttempts = 0;
let sleeperLastSuccessTime = null;
let sleeperWatchdogInterval = null;
const SLEEPER_STALL_THRESHOLD_MS = 8000;

// --- SYNC HEALTH WATCHDOG ---
// Polling/worker failures were previously silent (console.log only) — the
// user had no way to know sync had quietly stopped working mid-draft.
// This checks time-since-last-successful-fetch and flips the status pill
// to a "Stalled" warning if nothing has come back in a while.
function markSleeperSyncSuccess() {
    sleeperLastSuccessTime = Date.now();
}

function checkSleeperHeartbeat() {
    if (!isSleeperSyncActive) return;
    const status = document.getElementById('sleeper-sync-status');
    if (!status) return;
    const elapsed = Date.now() - (sleeperLastSuccessTime || Date.now());
    if (elapsed > SLEEPER_STALL_THRESHOLD_MS) {
        status.innerText = '🟡 Stalled';
        status.style.color = '#f59e0b';
        status.title = `No response from Sleeper in ${Math.round(elapsed / 1000)}s — check your connection or the Draft ID`;
    } else {
        status.innerText = '🟢 Syncing';
        status.style.color = 'var(--accent-green)';
        status.title = '';
    }
}

function startSleeperWatchdog() {
    stopSleeperWatchdog();
    sleeperWatchdogInterval = setInterval(checkSleeperHeartbeat, 2000);
}

function stopSleeperWatchdog() {
    if (sleeperWatchdogInterval) { clearInterval(sleeperWatchdogInterval); sleeperWatchdogInterval = null; }
}

function extractDraftId(val) {
    if (!val) return '';
    val = val.trim();
    const match = val.match(/\d{15,20}/);
    if (match) return match[0];
    return val.replace(/[^0-9]/g, '');
}

function saveSleeperDraftId(val) {
    sleeperDraftId = extractDraftId(val);
    const input = document.getElementById('sleeper-draft-id');
    if (input) input.value = sleeperDraftId;
    localStorage.setItem('god_tier_sleeper_draft_id', sleeperDraftId);
}

function saveSleeperUsername(val) {
    sleeperUsername = val.trim() || 'ViniAvila';
    localStorage.setItem('god_tier_sleeper_username', sleeperUsername);
}

function normalizeName(str) {
    if (!str) return '';
    return str.toLowerCase()
        .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
        .replace(/[^a-z0-9]/g, '')
        .trim();
}

function findLocalPlayer(pick) {
    const fname = (pick.metadata?.first_name || '').trim();
    const lname = (pick.metadata?.last_name || '').trim();
    const pos = (pick.metadata?.position || '').toUpperCase();
    const rawPlayerId = String(pick.player_id || '').toUpperCase().trim();

    const nflTeamCodes = ['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LV','LAC','LAR','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SF','SEA','TB','TEN','WAS'];

    const isExplicitDef = (pos === 'DEF' || pos === 'DST');
    const isTeamCodePlayerId = nflTeamCodes.includes(rawPlayerId);

    if (isExplicitDef || isTeamCodePlayerId) {
        const teamCode = (isTeamCodePlayerId ? rawPlayerId : (pick.metadata?.team || '')).toUpperCase();
        if (teamCode) {
            const dstMatch = players.find(p => p.pos === 'DST' && p.team === teamCode);
            if (dstMatch) return dstMatch;
        }
        const cleanSleeperDst = normalizeName(`${fname} ${lname}`).replace(/dst|def|defense/g, '');
        if (cleanSleeperDst) {
            const dstMatch = players.find(p => p.pos === 'DST' && normalizeName(p.name).replace(/dst|def|defense/g, '') === cleanSleeperDst);
            if (dstMatch) return dstMatch;
        }
    }

    if (!fname && !lname) return null;

    const cleanSleeper = normalizeName(`${fname} ${lname}`);

    let match = players.find(p => normalizeName(p.name) === cleanSleeper);
    if (match) return match;

    const aliases = {
        'marquisebrown': 'hollywoodbrown',
        'gabrieldavis': 'gabedavis',
        'chigoziemokonkwo': 'chigokonkwo',
        'mitchelltrubisky': 'mitchtrubisky',
        'jefferywilson': 'jeffwilson'
    };
    const aliasedSleeper = aliases[cleanSleeper] || cleanSleeper;
    match = players.find(p => {
        const pClean = normalizeName(p.name);
        return pClean === aliasedSleeper || (aliases[pClean] && aliases[pClean] === cleanSleeper);
    });
    if (match) return match;

    const cleanLname = normalizeName(lname);
    const cleanFname3 = normalizeName(fname).slice(0, 3);
    if (cleanLname.length >= 3 && cleanFname3.length >= 2) {
        match = players.find(p => {
            const pParts = p.name.split(' ');
            const pLname = normalizeName(pParts.slice(1).join(' '));
            const pFname = normalizeName(pParts[0]);
            return pLname === cleanLname && pFname.startsWith(cleanFname3);
        });
        if (match) return match;
    }

    if (pos && cleanLname.length >= 4) {
        const posMatches = players.filter(p => (p.pos === pos || (pos === 'DEF' && p.pos === 'DST')) && normalizeName(p.name).includes(cleanLname));
        if (posMatches.length === 1) return posMatches[0];
    }

    return null;
}

function toggleSleeperSync() {
    const draftInput = document.getElementById('sleeper-draft-id');
    const userInput = document.getElementById('sleeper-username');

    const id = extractDraftId(draftInput ? draftInput.value : sleeperDraftId);
    const user = (userInput ? userInput.value.trim() : sleeperUsername) || 'ViniAvila';

    if (!id) return flagInvalidField(draftInput, "Please enter a valid Sleeper Draft ID or URL!");

    isSleeperSyncActive = !isSleeperSyncActive;
    sleeperDraftId = id;
    sleeperUsername = user;
    saveSleeperDraftId(id);
    saveSleeperUsername(user);

    const btn = document.getElementById('sleeper-sync-btn');
    const status = document.getElementById('sleeper-sync-status');

    if (isSleeperSyncActive) {
        if (btn) btn.innerText = "Disconnect";
        if (status) { status.innerText = "🟢 Syncing"; status.style.color = "var(--accent-green)"; }

        sleeperProcessedPickNos.clear();
        isInitialSleeperCatchup = true;
        sleeperSlotAutoDetected = false;
        sleeperSlotManuallySet = false;
        sleeperSlotHintShown = false;
        sleeperDraftDetailAttempts = 0;
        sleeperOfficialUserId = null;
        sleeperConfirmedSlotFromPicks = null;
        markSleeperSyncSuccess();
        startSleeperWatchdog();

        startSleeperWorker(id, user);
        showToast("🏈 Connected & Synced with Sleeper!");
    } else {
        stopSleeperWorker();
        stopSleeperWatchdog();
        if (btn) btn.innerText = "Connect";
        if (status) { status.innerText = "🔴 Off"; status.style.color = "var(--text-muted)"; status.title = ''; }
        showToast("🔴 Sleeper Sync disconnected");
    }
}

function startSleeperWorker(draftId, username) {
    stopSleeperWorker();
    try {
        sleeperWorker = new Worker('./sleeper-worker.js');
        sleeperWorker.onmessage = handleSleeperWorkerMessage;
        sleeperWorker.onerror = (err) => {
            console.log('Sleeper worker crashed, falling back to main-thread polling:', err.message);
            startSleeperFallbackPolling();
        };
        sleeperWorker.postMessage({ type: 'start', draftId, username });
    } catch (e) {
        console.log('Web Worker unavailable, falling back to main-thread polling:', e);
        startSleeperFallbackPolling();
    }
}

let sleeperFallbackDetailsInterval = null;
function startSleeperFallbackPolling() {
    if (sleeperWorker) { try { sleeperWorker.terminate(); } catch(e){} sleeperWorker = null; }
    fetchSleeperDraftDetails();
    fetchSleeperPicks();
    if (sleeperSyncInterval) clearInterval(sleeperSyncInterval);
    if (sleeperFallbackDetailsInterval) clearInterval(sleeperFallbackDetailsInterval);
    sleeperSyncInterval = setInterval(fetchSleeperPicks, 600);
    sleeperFallbackDetailsInterval = setInterval(fetchSleeperDraftDetails, 4000);
}

function stopSleeperWorker() {
    if (sleeperWorker) {
        try { sleeperWorker.postMessage({ type: 'stop' }); } catch(e){}
        sleeperWorker.terminate();
        sleeperWorker = null;
    }
    if (sleeperSyncInterval) { clearInterval(sleeperSyncInterval); sleeperSyncInterval = null; }
    if (sleeperFallbackDetailsInterval) { clearInterval(sleeperFallbackDetailsInterval); sleeperFallbackDetailsInterval = null; }
}

function handleSleeperWorkerMessage(e) {
    const msg = e.data || {};
    if (msg.type === 'userInfo') {
        if (msg.officialUserId) sleeperOfficialUserId = msg.officialUserId;
        markSleeperSyncSuccess();
    } else if (msg.type === 'picks') {
        if (msg.officialUserId) sleeperOfficialUserId = msg.officialUserId;
        processSleeperPicks(msg.picks || []);
        markSleeperSyncSuccess();
    } else if (msg.type === 'draftDetails') {
        if (msg.officialUserId) sleeperOfficialUserId = msg.officialUserId;
        processSleeperDraftDetails(msg.draft, msg.users || [], msg.officialUserId);
        markSleeperSyncSuccess();
    } else if (msg.type === 'error') {
        console.log('Sleeper worker fetch error:', msg.context, msg.message);
    }
}

function processSleeperDraftDetails(draft, users, officialUserId) {
    if (!draft || !isSleeperSyncActive) return;
    if (officialUserId) sleeperOfficialUserId = officialUserId;

    if (draft.settings && draft.settings.teams) {
        const totalTeams = Number(draft.settings.teams);
        if (teams.length !== totalTeams) {
            updateLeagueTeamsCount(totalTeams);
        }
    }

    const userMap = {};
    const cleanTargetUser = normalizeName(sleeperUsername || 'ViniAvila');
    let detectedSlot = null;
    const resolvedUserId = officialUserId || sleeperOfficialUserId || null;

    (users || []).forEach(u => {
        const displayName = u.display_name || u.username || `Team`;
        userMap[u.user_id] = displayName;
    });

    if (draft.draft_order) {
        sleeperDraftDetailAttempts++;

        for (let uId in draft.draft_order) {
            const slot = Number(draft.draft_order[uId]);
            const displayName = userMap[uId] || `Team ${slot}`;

            const teamObj = teams.find(t => t.id === slot);
            if (teamObj) teamObj.name = displayName;

            const cleanDisplay = normalizeName(displayName);
            const isMe = (resolvedUserId && String(uId) === String(resolvedUserId)) ||
                         (cleanDisplay && cleanTargetUser && (cleanDisplay === cleanTargetUser || cleanDisplay.includes(cleanTargetUser) || cleanTargetUser.includes(cleanDisplay)));
            if (isMe) detectedSlot = slot;
        }
    }

    if (!detectedSlot && draft.slot_to_user_id) {
        for (let slotStr in draft.slot_to_user_id) {
            const slotNum = Number(slotStr);
            const uId = draft.slot_to_user_id[slotStr];
            const displayName = userMap[uId] || `Team ${slotNum}`;

            const teamObj = teams.find(t => t.id === slotNum);
            if (teamObj) teamObj.name = displayName;

            const cleanDisplay = normalizeName(displayName);
            const isMe = (resolvedUserId && String(uId) === String(resolvedUserId)) ||
                         (cleanDisplay && cleanTargetUser && (cleanDisplay === cleanTargetUser || cleanDisplay.includes(cleanTargetUser) || cleanTargetUser.includes(cleanDisplay)));
            if (isMe) detectedSlot = slotNum;
        }
    }

    if (!detectedSlot && resolvedUserId && sleeperConfirmedSlotFromPicks) {
        detectedSlot = sleeperConfirmedSlotFromPicks;
    }

    if (detectedSlot && !sleeperSlotManuallySet) {
        const isNewDetection = !sleeperSlotAutoDetected || Number(myDraftSlot) !== Number(detectedSlot);
        sleeperSlotAutoDetected = true;
        if (isNewDetection) {
            updateDraftPosition(detectedSlot, true);
            showToast(`🎯 Connected! You are in Slot ${detectedSlot}`);
        }
    } else if (!detectedSlot && !sleeperSlotManuallySet && !sleeperSlotAutoDetected && !sleeperSlotHintShown && sleeperDraftDetailAttempts >= 3) {
        sleeperSlotHintShown = true;
        showToast("⚠️ Couldn't match your username to a team — check spelling or set your slot manually");
    }

    populateSlotSelectOptions();
    updateSnakeTracker();
}

async function fetchSleeperDraftDetails() {
    if (!sleeperDraftId) return;
    try {
        let officialUserId = sleeperOfficialUserId;
        if (!officialUserId) {
            const targetUsername = sleeperUsername || 'ViniAvila';
            try {
                const uRes = await fetch(`https://api.sleeper.app/v1/user/${targetUsername.trim()}`);
                if (uRes.ok) {
                    const uData = await uRes.json();
                    if (uData && uData.user_id) officialUserId = uData.user_id;
                }
            } catch(e){}
        }

        const [draftRes, usersRes] = await Promise.all([
            fetch(`https://api.sleeper.app/v1/draft/${sleeperDraftId}`),
            fetch(`https://api.sleeper.app/v1/draft/${sleeperDraftId}/users`)
        ]);

        if (!draftRes.ok) return;
        const draft = await draftRes.json();
        const users = usersRes.ok ? await usersRes.json() : [];
        processSleeperDraftDetails(draft, users, officialUserId);
        markSleeperSyncSuccess();
    } catch(e) {
        console.log("Error fetching Sleeper draft details:", e);
    }
}

function processSleeperPicks(picks) {
    if (!isSleeperSyncActive || !Array.isArray(picks)) return;

    picks = picks.slice().sort((a, b) => a.pick_no - b.pick_no);

    if (sleeperOfficialUserId) {
        const myPick = picks.find(p => p.picked_by && String(p.picked_by) === String(sleeperOfficialUserId));
        if (myPick && myPick.draft_slot) {
            const confirmedSlot = Number(myPick.draft_slot);
            sleeperConfirmedSlotFromPicks = confirmedSlot;
            if (!sleeperSlotManuallySet && Number(myDraftSlot) !== confirmedSlot) {
                sleeperSlotAutoDetected = true;
                updateDraftPosition(confirmedSlot, true);
                showToast(`🎯 Connected! You are in Slot ${confirmedSlot}`);
            }
        }
    }

    let updated = false;
    for (const pick of picks) {
        if (sleeperProcessedPickNos.has(pick.pick_no)) continue;

        sleeperProcessedPickNos.add(pick.pick_no);
        updated = true;

        if (pick.draft_slot === undefined || pick.draft_slot === null) continue;
        const draftSlot = Number(pick.draft_slot);
        const fname = pick.metadata?.first_name || '';
        const lname = pick.metadata?.last_name || '';
        const fullPName = sanitizePlainText(`${fname} ${lname}`.trim()) || 'Unknown Player';

        const localPlayer = findLocalPlayer(pick);

        if (localPlayer) {
            const pId = localPlayer.id;
            playerDraftMap[pId] = draftSlot;

            if (Number(draftSlot) === Number(myDraftSlot)) {
                stateTracker[pId] = 'mine';
                if (myRoster[localPlayer.pos] !== undefined) myRoster[localPlayer.pos]++;
                autoAssignToRoster(localPlayer);
            } else {
                stateTracker[pId] = 'gone';
                removeFromRoster(pId);
            }

            addPickToHistory(pId, draftSlot, !isInitialSleeperCatchup);
        } else {
            const dummyId = 99900000 + pick.pick_no;
            playerDraftMap[dummyId] = draftSlot;
            const pos = (pick.metadata?.position || 'FLEX').toUpperCase();

            const existingIndex = pickHistory.findIndex(p => p.pickNum === pick.pick_no);
            if (existingIndex === -1) {
                pickHistory.push({
                    pickNum: pick.pick_no,
                    playerId: dummyId,
                    playerName: fullPName,
                    teamName: teams.find(t => t.id === draftSlot)?.name || `Team ${draftSlot}`,
                    pos: pos
                });
            }
        }
    }

    if (updated) {
        redoStack = [];
        resetTimer();
        updateUndoButton();
        saveDraftState();
        updateTracker();
        updateSnakeTracker();
        renderCurrentActiveView();
    }
    isInitialSleeperCatchup = false;
}

async function fetchSleeperPicks() {
    if (!sleeperDraftId || !isSleeperSyncActive) return;
    try {
        const res = await fetch(`https://api.sleeper.app/v1/draft/${sleeperDraftId}/picks`);
        if (!res.ok) return;
        const picks = await res.json();
        processSleeperPicks(picks);
        markSleeperSyncSuccess();
    } catch (err) {
        console.log("Sleeper sync error:", err);
    }
}

function initSleeperSyncUI() {
    const savedId = localStorage.getItem('god_tier_sleeper_draft_id');
    const savedUser = localStorage.getItem('god_tier_sleeper_username') || 'ViniAvila';
    if (savedId) {
        sleeperDraftId = savedId;
        const input = document.getElementById('sleeper-draft-id');
        if (input) input.value = savedId;
    }
    sleeperUsername = savedUser;
    const input = document.getElementById('sleeper-username');
    if (input) input.value = sleeperUsername;
}

function playPickInSound() {
    try {
        const audio = new Audio('pick_is_in.mp3');
        audio.play().catch(e => {});
    } catch(e){}
}

let isCompactMode = false;
function toggleDensityMode() {
    isCompactMode = !isCompactMode;
    document.body.classList.toggle('compact-mode', isCompactMode);
    localStorage.setItem('god_tier_density_compact', isCompactMode ? 'true' : 'false');
    const btn = document.getElementById('density-toggle-btn');
    if (btn) btn.innerText = isCompactMode ? '📐 Spaced' : '📐 Compact';
    showToast(isCompactMode ? '📐 Switched to War Room (Compact) View' : '📐 Switched to Broadcast (Spaced) View');
}

function initDensityMode() {
    const saved = localStorage.getItem('god_tier_density_compact');
    if (saved === 'true') {
        isCompactMode = true;
        document.body.classList.add('compact-mode');
        const btn = document.getElementById('density-toggle-btn');
        if (btn) btn.innerText = '📐 Spaced';
    }
}

let currentTheme = 'dark';
function initTheme() {
    const savedTheme = localStorage.getItem('god_tier_theme') || 'dark';
    applyTheme(savedTheme);
}

// --- KEEP STICKY HEADER/TABS/TABLE-HEADER OFFSETS IN SYNC ---
// The header height varies (wraps to multiple lines on narrow screens,
// content changes, etc.), so instead of hardcoded px offsets we measure
// the real rendered height and expose it as CSS vars the sticky rules use.
function syncStickyOffsets() {
    const headerEl = document.querySelector('header');
    const tabsEl = document.querySelector('.tabs');
    if (headerEl) {
        document.documentElement.style.setProperty('--header-h', headerEl.offsetHeight + 'px');
    }
    if (tabsEl) {
        document.documentElement.style.setProperty('--tabs-h', tabsEl.offsetHeight + 'px');
    }
}

function initStickyOffsetSync() {
    syncStickyOffsets();
    // Re-measure on resize (orientation change, window resize, zoom).
    window.addEventListener('resize', syncStickyOffsets);
    // Re-measure whenever the header or tabs actually change size
    // (font load, content change, roster counts wrapping, etc.).
    if (typeof ResizeObserver !== 'undefined') {
        const headerEl = document.querySelector('header');
        const tabsEl = document.querySelector('.tabs');
        const ro = new ResizeObserver(() => syncStickyOffsets());
        if (headerEl) ro.observe(headerEl);
        if (tabsEl) ro.observe(tabsEl);
    }
}
function applyTheme(theme) {
    currentTheme = theme;
    document.documentElement.classList.add('theme-switching');
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('god_tier_theme', theme);
    
    const toggleCheckbox = document.getElementById('theme-switch-checkbox');
    if (toggleCheckbox) toggleCheckbox.checked = (theme === 'dark');

    requestAnimationFrame(() => {
        setTimeout(() => {
            document.documentElement.classList.remove('theme-switching');
        }, 50);
    });
}
function toggleTheme() {
    const toggleCheckbox = document.getElementById('theme-switch-checkbox');
    const newTheme = (toggleCheckbox && toggleCheckbox.checked) ? 'dark' : 'light';
    applyTheme(newTheme);
    showToast(newTheme === 'dark' ? '🌙 Dark Mode' : '☀️ Light Mode');
}

let defaultTeams = Array.from({length: 10}, (_, i) => ({
    id: i + 1,
    name: i === 0 ? "My Team" : `Team ${i + 1}`
}));

let teams = JSON.parse(JSON.stringify(defaultTeams));
let playerDraftMap = {}; 
let playerTags = {}; 
let pickHistory = []; 
let pendingModalPlayerId = null;
let pendingEditPlayerId = null;
let pendingRenameTeamId = null;
let comparePlayer1Id = null;
let currentTagFilter = 'ALL';
let myDraftSlot = 1;
let hideKDst = true;
let scoringFormat = 'PPR_4';

function updateScoringFormat(val) {
    scoringFormat = val;
    saveDraftState();
    let label = "Full PPR (4pt Pass TD)";
    if (val === 'PPR_6') label = "Full PPR (6pt Pass TD)";
    if (val === 'HALF_4') label = "Half PPR (4pt Pass TD)";
    if (val === 'HALF_6') label = "Half PPR (6pt Pass TD)";
    if (val === 'STD_4') label = "No PPR / Standard (4pt Pass TD)";
    if (val === 'STD_6') label = "No PPR / Standard (6pt Pass TD)";
    showToast(`⚡ Scoring format set to ${label}`);
    renderCurrentActiveView();
}

let timerSeconds = 60;
let timerMax = 60;
let timerInterval = null;
let isTimerRunning = false;

function toggleTimer() {
    if (isTimerRunning) pauseTimer();
    else startTimer();
}
function startTimer() {
    if (isTimerRunning) return;
    isTimerRunning = true;
    document.getElementById('timer-play-btn').innerText = '⏸';
    timerInterval = setInterval(tickTimer, 1000);
}
function pauseTimer() {
    isTimerRunning = false;
    document.getElementById('timer-play-btn').innerText = '▶';
    if (timerInterval) clearInterval(timerInterval);
}
function resetTimer() {
    pauseTimer();
    timerSeconds = timerMax;
    updateTimerDisplay();
}
function tickTimer() {
    if (timerSeconds > 0) {
        timerSeconds--;
        updateTimerDisplay();
        if (timerSeconds === 10) playBeep();
    } else {
        pauseTimer();
        playBeep();
        showToast("⏰ Time's Up!");
    }
}
function updateTimerDisplay() {
    const elem = document.getElementById('timer-display');
    if (!elem) return;
    const m = Math.floor(timerSeconds / 60);
    const s = timerSeconds % 60;
    elem.innerText = `${m < 10 ? '0'+m : m}:${s < 10 ? '0'+s : s}`;
    elem.className = 'timer-display' + (timerSeconds <= 10 ? ' danger' : (timerSeconds <= 20 ? ' warning' : ''));
}
function playBeep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.2);
    } catch(e){}
}

function updateLeagueTeamsCount(countVal) {
    const newCount = parseInt(countVal) || 10;
    if (newCount < 4 || newCount > 20) return;
    if (teams.length < newCount) {
        for (let i = teams.length + 1; i <= newCount; i++) teams.push({ id: i, name: `Team ${i}` });
    } else if (teams.length > newCount) {
        teams = teams.slice(0, newCount);
    }
    if (myDraftSlot > newCount) myDraftSlot = newCount;
    populateSlotSelectOptions();
    saveDraftState();
    updateSnakeTracker();
    if (currentFilter === 'LEAGUE') renderLeagueView();
    showToast(`🏟️ League size set to ${newCount} Teams`);
}

function populateSlotSelectOptions() {
    syncTeamNamesWithDraftSlot();
    const selectElem = document.getElementById('snake-slot-select');
    if (!selectElem) return;
    let html = '';
    teams.forEach((t, idx) => {
        const slotNum = idx + 1;
        html += `<option value="${slotNum}">Slot ${slotNum} (${t.name})</option>`;
    });
    selectElem.innerHTML = html;
    selectElem.value = myDraftSlot;
    const teamsSelectElem = document.getElementById('snake-teams-select');
    if (teamsSelectElem) teamsSelectElem.value = teams.length;

    const scoringSelectElem = document.getElementById('scoring-format-select');
    if (scoringSelectElem) scoringSelectElem.value = scoringFormat;
}

function syncTeamNamesWithDraftSlot() {
    teams.forEach(t => {
        if (t.id === Number(myDraftSlot)) { if (t.name.startsWith("Team ")) t.name = "My Team"; }
        else { if (t.name === "My Team") t.name = `Team ${t.id}`; }
    });
}

function reevaluateAllRosters() {
    myRoster = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
    rosterAssignments = {};

    Object.keys(playerDraftMap).forEach(pId => {
        const teamSlot = Number(playerDraftMap[pId]);
        const player = getPlayer(pId);

        if (teamSlot === Number(myDraftSlot)) {
            stateTracker[pId] = 'mine';
            if (player) {
                if (myRoster[player.pos] !== undefined) myRoster[player.pos]++;
                autoAssignToRoster(player);
            }
        } else {
            stateTracker[pId] = 'gone';
            if (player) removeFromRoster(player.id);
        }
    });

    updateTracker();
    saveDraftState();
}

function updateDraftPosition(slotVal, fromAutoSync = false) {
    if (!fromAutoSync) sleeperSlotManuallySet = true;
    myDraftSlot = parseInt(slotVal) || 1;
    syncTeamNamesWithDraftSlot();
    reevaluateAllRosters();
    updateSnakeTracker();
    if (currentFilter === 'LEAGUE') renderLeagueView();
    else renderCurrentActiveView();
}

function getCurrentOnClockInfo() {
    const totalTeams = teams.length || 10;
    const totalDraftedPicks = Object.keys(playerDraftMap).length;
    const currentOverall = totalDraftedPicks + 1;
    const currentRound = Math.floor((currentOverall - 1) / totalTeams) + 1;
    const pickInRound = currentOverall - (currentRound - 1) * totalTeams;
    let currentTeamSlot = (currentRound % 2 === 1) ? pickInRound : (totalTeams - pickInRound + 1);
    const currentTeam = teams.find(t => t.id === currentTeamSlot) || { id: currentTeamSlot, name: 'Team ' + currentTeamSlot };
    return { overall: currentOverall, round: currentRound, pickInRound: pickInRound, teamSlot: currentTeamSlot, team: currentTeam };
}

function updateSnakeTracker() {
    const onClock = getCurrentOnClockInfo();
    const totalTeams = teams.length || 10;
    const currentPickElem = document.getElementById('snake-current-pick');
    if (currentPickElem) {
        currentPickElem.innerText = `Pick ${onClock.round}.${onClock.pickInRound < 10 ? '0'+onClock.pickInRound : onClock.pickInRound} (#${onClock.overall}) — ${onClock.team.name}`;
    }
    let myNextPickOverall = null, myNextRound = null, myNextPickInRound = null;
    for (let r = 1; r <= 30; r++) {
        let pickOverall = (r % 2 === 1) ? (r - 1) * totalTeams + myDraftSlot : (r - 1) * totalTeams + (totalTeams - myDraftSlot + 1);
        if (pickOverall >= onClock.overall) {
            myNextPickOverall = pickOverall; myNextRound = r;
            myNextPickInRound = (r % 2 === 1) ? myDraftSlot : (totalTeams - myDraftSlot + 1);
            break;
        }
    }
    const picksAway = myNextPickOverall - onClock.overall;
    const myNextElem = document.getElementById('snake-my-next');
    const myNextCard = document.getElementById('snake-my-next-card');

    if (myNextElem && myNextCard) {
        if (picksAway === 0) {
            myNextCard.className = "snake-stat-card your-turn";
            myNextElem.innerText = `🟢 IT'S YOUR PICK NOW! (#${myNextPickOverall})`;
            if (!wasMyTurnPreviously) {
                wasMyTurnPreviously = true;
                scrollToTopAvailablePlayer();
            }
        } else {
            myNextCard.className = "snake-stat-card highlight";
            myNextElem.innerText = `Pick ${myNextRound}.${myNextPickInRound < 10 ? '0'+myNextPickInRound : myNextPickInRound} (#${myNextPickOverall}) — ${picksAway} picks away`;
            wasMyTurnPreviously = false;
        }
    }
    populateSlotSelectOptions();
    updateBAPBanner();
}

// --- AUTO-SCROLL TO TOP AVAILABLE PLAYER WHEN IT BECOMES YOUR TURN ---
// Only fires on the *transition* into "your turn" (see wasMyTurnPreviously),
// not on every re-render, so it doesn't fight the user's own scrolling.
let wasMyTurnPreviously = false;
function scrollToTopAvailablePlayer() {
    const available = players
        .filter(p => !stateTracker[p.id] && !(hideKDst && currentFilter === 'ALL' && ['K', 'DST'].includes(p.pos)))
        .sort((a, b) => a.rank - b.rank);
    if (available.length === 0) return;
    const topPlayer = available[0];
    // Only makes sense on the board view — skip if on Roster/League tab.
    if (currentFilter === 'ROSTER' || currentFilter === 'LEAGUE') return;

    requestAnimationFrame(() => {
        const row = document.getElementById(`row-${topPlayer.id}`);
        if (!row) return;
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('on-clock-highlight');
        setTimeout(() => row.classList.remove('on-clock-highlight'), 2600);
    });
}

function updateBAPBanner() {
    const container = document.getElementById('bap-banner-container');
    if (!container) return;

    const myCounts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
    Object.keys(stateTracker).forEach(id => {
        if (stateTracker[id] === 'mine') {
            const p = getPlayer(id);
            if (p) myCounts[p.pos] = (myCounts[p.pos] || 0) + 1;
        }
    });
    let available = players.filter(p => !stateTracker[p.id]);
    if (available.length === 0) { container.style.display = 'none'; return; }
    
    available.sort((a, b) => a.rank - b.rank);
    const top3 = available.slice(0, 3);
    
    let cardsHtml = top3.map(p => {
        const avatarUrl = getPlayerHeadshot(p);

        return `
            <div class="bap-card" onclick="document.getElementById('search-input').value='${p.name.replace(/'/g, "\\'")}'; handleSearch('${p.name.replace(/'/g, "\\'")}');">
                <div class="bap-card-rank">#${p.rank}</div>
                <img src="${avatarUrl}" class="player-avatar-img" style="width: 40px; height: 40px;" alt="${p.name}" loading="lazy">
                <div class="bap-card-info">
                    <span class="bap-name">${p.name}</span>
                    <span class="bap-meta"><span class="badge ${p.posClass}" style="font-size:10px; padding:2px 6px;">${p.displayPos || p.pos}</span> Tier ${p.tier}</span>
                </div>
                <div class="bap-card-reason">Best Available</div>
            </div>
        `;
    }).join('');

    container.style.display = 'flex';
    container.innerHTML = `<div class="bap-header"><span class="bap-title">🤖 Recommended Picks</span></div><div class="bap-cards-container">${cardsHtml}</div>`;
}

const nflByes = { 'ARI': 11, 'ATL': 14, 'BAL': 14, 'BUF': 12, 'CAR': 11, 'CHI': 7, 'CIN': 12, 'CLE': 10, 'DAL': 7, 'DEN': 14, 'DET': 5, 'GB': 10, 'HOU': 14, 'IND': 14, 'JAX': 12, 'KC': 6, 'LV': 10, 'LAC': 5, 'LAR': 6, 'MIA': 6, 'MIN': 6, 'NE': 14, 'NO': 12, 'NYG': 11, 'NYJ': 12, 'PHI': 5, 'PIT': 9, 'SF': 9, 'SEA': 10, 'TB': 11, 'TEN': 5, 'WAS': 14 };
const tierList = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O'];

let activeDefaultPlayers = (typeof defaultPlayers !== 'undefined' && Array.isArray(defaultPlayers) && defaultPlayers.length > 0) ? defaultPlayers : [];
let players = JSON.parse(JSON.stringify(activeDefaultPlayers));
let playersMap = new Map();
let myRoster = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
let currentFilter = 'ALL';
let stateTracker = {};
let searchQuery = '';

function autoCalculateCeilings() {
    players.forEach(p => {
        if (!p.ceilingPosRank || p.ceilingPosRank === p.posRank) {
            let multiplier = 0.25;
            const pr = Number(p.posRank) || 1;

            if (p.pos === 'RB') {
                multiplier = pr <= 6 ? 0.25 : (pr <= 24 ? 0.40 : 0.48);
            } else if (p.pos === 'WR') {
                multiplier = pr <= 6 ? 0.20 : (pr <= 24 ? 0.35 : 0.42);
            } else if (p.pos === 'QB') {
                multiplier = pr <= 6 ? 0.20 : 0.32;
            } else if (p.pos === 'TE') {
                multiplier = pr <= 4 ? 0.20 : 0.30;
            } else {
                multiplier = 0.10;
            }

            let boost = Math.round(pr * multiplier);
            if (pr > 1 && boost < 1) boost = 1;

            p.ceilingPosRank = Math.max(1, pr - boost);
        }
    });
}

function rebuildPlayersMap() {
    playersMap.clear();
    players.forEach(p => playersMap.set(p.id, p));
}

function getPlayer(id) {
    return playersMap.get(id) || playersMap.get(Number(id));
}

function updatePositionalRanks() {
    players.sort((a, b) => a.rank - b.rank);
    
    const posCounts = { RB: 0, WR: 0, TE: 0, QB: 0, K: 0, DST: 0 };
    players.forEach(p => {
        posCounts[p.pos] = (posCounts[p.pos] || 0) + 1;
        p.posRank = posCounts[p.pos];
        p.displayPos = p.pos + posCounts[p.pos];
    });

    autoCalculateCeilings();
    rebuildPlayersMap();
}

// Once true, we've already warned the user this session that saves are
// failing — avoid spamming a toast on every single pick/tag/sort change.
let saveFailureWarned = false;
function saveDraftState() {
    try {
        const draftState = { players, stateTracker, rosterAssignments, myRoster, teams, playerDraftMap, playerTags, pickHistory, myDraftSlot, customRosterSlots, hideKDst, scoringFormat };
        localStorage.setItem('god_tier_draft_saved_state', JSON.stringify(draftState));
    } catch (e) {
        console.error('Failed to save draft state:', e);
        if (!saveFailureWarned) {
            saveFailureWarned = true;
            showToast('⚠️ Could not save your draft — storage may be full. Use 📤 Backup to export a copy now.');
        }
    }
}

function loadDraftState() {
    try {
        const saved = localStorage.getItem('god_tier_draft_saved_state');
        if (saved) {
            let parsed;
            try {
                parsed = JSON.parse(saved);
            } catch (parseErr) {
                // Corrupted save data — don't silently discard it. Keep the raw
                // string around under a recovery key so it isn't lost outright,
                // and tell the user instead of failing quietly.
                localStorage.setItem('god_tier_draft_corrupted_backup', saved);
                console.error('Saved draft state was corrupted and could not be parsed:', parseErr);
                showToast('⚠️ Your saved draft was corrupted and could not be restored. A backup copy was kept — contact support if you need it recovered.');
                throw parseErr;
            }
            if (parsed.players) {
                players = parsed.players;
                players.forEach(p => {
                    if (p.prevRank === undefined || p.prevRank === null) {
                        p.prevRank = p.rank;
                    }
                });
            }
            if (parsed.stateTracker) stateTracker = parsed.stateTracker;
            if (parsed.rosterAssignments) rosterAssignments = parsed.rosterAssignments;
            if (parsed.myRoster) myRoster = parsed.myRoster;
            if (parsed.teams) teams = parsed.teams;
            if (parsed.playerDraftMap) playerDraftMap = parsed.playerDraftMap;
            if (parsed.playerTags) playerTags = parsed.playerTags;
            if (parsed.pickHistory) pickHistory = parsed.pickHistory;
            if (parsed.myDraftSlot) myDraftSlot = parsed.myDraftSlot;
            if (parsed.customRosterSlots) customRosterSlots = parsed.customRosterSlots;
            if (parsed.scoringFormat) scoringFormat = parsed.scoringFormat;
            if (parsed.hideKDst !== undefined) {
                hideKDst = parsed.hideKDst;
            }
        }
        document.getElementById('hide-k-dst-checkbox').checked = hideKDst;
    } catch (e){
        const checkbox = document.getElementById('hide-k-dst-checkbox');
        if (checkbox) checkbox.checked = hideKDst;
    }

    updatePositionalRanks();
    updateTracker();
    updateUndoButton();
    updateSnakeTracker();
}

function resetDraft() {
    confirmAction({
        title: '⚠️ Reset Draft',
        message: 'This will reset all draft picks, tags, and settings. This cannot be undone.',
        confirmLabel: 'Reset Everything',
        onConfirm: () => {
            localStorage.removeItem('god_tier_draft_saved_state');
            location.reload();
        }
    });
}

// --- REPAIR / RE-BASELINE RANK TREND ARROWS ---
// Sets every player's prevRank back to their current rank, so the ▲/▼
// trend badges start clean from this point on. Does NOT touch picks,
// tags, rosters, teams, or anything else — only the trend baseline.
function resetRankTrends() {
    confirmAction({
        title: '↺ Reset Rank Trends',
        message: 'This will clear the ▲/▼ arrows for every player (starting fresh from now, no prior history). Picks, tags, and teams are not affected.',
        confirmLabel: 'Reset Trends',
        onConfirm: () => {
            players.forEach(p => { p.prevRank = p.rank; });
            saveDraftState();
            renderBoard();
            showToast('✅ Rank trend arrows reset!');
        }
    });
}

function exportCSV() {
    let csv = 'Rank,PositionalRank,PositionalCeiling,Name,Position,Team,Bye,Tier,Status,DraftedBy\n';
    players.forEach(p => {
        const status = stateTracker[p.id] || 'Available';
        const teamAssigned = playerDraftMap[p.id] ? (teams.find(t=>t.id===Number(playerDraftMap[p.id]))?.name || '') : '';
        csv += `"${p.rank}","${p.displayPos}","${p.pos}${p.ceilingPosRank || p.posRank}","${p.name}","${p.pos}","${p.team}","${p.bye}","${p.tier}","${status}","${teamAssigned}"\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `draft_export_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
}

function exportDraftState() {
    const jsonStr = JSON.stringify({ players, stateTracker, rosterAssignments, myRoster, teams, playerDraftMap, playerTags, pickHistory, myDraftSlot, customRosterSlots, scoringFormat });
    const blob = new Blob([jsonStr], { type: "application/json" });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `draft_backup_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
}

function importDraftState(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const parsed = JSON.parse(e.target.result);
            if (parsed.players) players = parsed.players;
            if (parsed.stateTracker) stateTracker = parsed.stateTracker;
            if (parsed.rosterAssignments) rosterAssignments = parsed.rosterAssignments;
            if (parsed.teams) teams = parsed.teams;
            if (parsed.scoringFormat) scoringFormat = parsed.scoringFormat;
            updatePositionalRanks();
            saveDraftState();
            location.reload();
        } catch (err) { showToast("❌ Invalid backup file format"); }
    };
    reader.readAsText(file);
}

function openAddPlayerModal() { document.getElementById('add-player-modal-overlay').classList.add('active'); }
function closeAddPlayerModal() { document.getElementById('add-player-modal-overlay').classList.remove('active'); }

// --- GENERIC CONFIRM MODAL (replaces native confirm() to match app styling) ---
let pendingConfirmAction = null;
function confirmAction({ title, message, confirmLabel = 'Confirm', danger = true, onConfirm }) {
    document.getElementById('confirm-modal-title').innerText = title || 'Confirm';
    document.getElementById('confirm-modal-message').innerText = message || '';
    const confirmBtn = document.getElementById('confirm-modal-confirm-btn');
    confirmBtn.innerText = confirmLabel;
    confirmBtn.style.background = danger
        ? 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)'
        : 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
    pendingConfirmAction = typeof onConfirm === 'function' ? onConfirm : null;
    document.getElementById('confirm-modal-overlay').classList.add('active');
    confirmBtn.focus();
}
function closeConfirmModal() {
    document.getElementById('confirm-modal-overlay').classList.remove('active');
    pendingConfirmAction = null;
}
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('confirm-modal-confirm-btn');
    if (btn) btn.addEventListener('click', () => {
        const action = pendingConfirmAction;
        closeConfirmModal();
        if (action) action();
    });
});

// --- FIELD-LEVEL VALIDATION FEEDBACK (replaces native alert() for form errors) ---
// Flags the given input red, briefly shakes it, focuses it, and shows a toast
// instead of blocking the whole page with a native alert() dialog.
function flagInvalidField(inputEl, message) {
    if (inputEl) {
        inputEl.classList.remove('field-invalid-shake');
        void inputEl.offsetWidth;
        inputEl.classList.add('field-invalid-shake');
        inputEl.focus();
        inputEl.addEventListener('animationend', () => inputEl.classList.remove('field-invalid-shake'), { once: true });
    }
    showToast(`⚠️ ${message}`);
}

function saveCustomPlayer() {
    const name = sanitizePlainText(document.getElementById('add-p-name').value);
    const team = sanitizePlainText(document.getElementById('add-p-team').value).toUpperCase();
    const pos = document.getElementById('add-p-pos').value;
    const rank = parseInt(document.getElementById('add-p-rank').value) || 100;
    const ceilingPosRank = parseInt(document.getElementById('add-p-ceiling').value) || null;
    const tier = document.getElementById('add-p-tier').value;
    if (!name) return flagInvalidField(document.getElementById('add-p-name'), "Player name is required");

    const newId = generateUniqueId();
    players.push({
        id: newId, rank, prevRank: rank, name, team, bye: nflByes[team]||'-', pos, posClass: 'pos-'+pos.toLowerCase(), tier, ceilingPosRank
    });
    updatePositionalRanks();
    saveDraftState();
    closeAddPlayerModal();
    renderCurrentActiveView();
    showToast(`➕ Added ${name}`);
}

function calculateGameFantasyPoints(g) {
    const passYds = Number(g.passing_yards || 0);
    const passTd  = Number(g.passing_tds || 0);
    const rushYds = Number(g.rushing_yards || 0);
    const rushTd  = Number(g.rushing_tds || 0);
    const recYds  = Number(g.receiving_yards || 0);
    const recTd   = Number(g.receiving_tds || 0);
    const rec     = Number(g.receptions || 0);

    let pprBonus = 1.0;
    if (scoringFormat.startsWith('HALF')) pprBonus = 0.5;
    if (scoringFormat.startsWith('STD')) pprBonus = 0.0;

    let passTdPts = 4;
    if (scoringFormat.endsWith('_6')) passTdPts = 6;

    let pts = (passYds * 0.04) + (passTd * passTdPts) + (rushYds * 0.1) + (rushTd * 6) + (recYds * 0.1) + (recTd * 6) + (rec * pprBonus);
    
    if (pts === 0 && g.fantasy_points_ppr) {
        let pprVal = Number(g.fantasy_points_ppr);
        let recDeduction = 0;
        if (scoringFormat.startsWith('HALF')) recDeduction = rec * 0.5;
        if (scoringFormat.startsWith('STD')) recDeduction = rec * 1.0;
        
        let passTdAddition = 0;
        if (scoringFormat.endsWith('_6')) passTdAddition = passTd * 2;

        return pprVal - recDeduction + passTdAddition;
    }
    
    return pts;
}

function openPlayerStatsModal(playerId, selectedSeason = null) {
    const p = getPlayer(playerId);
    if (!p) return;

    const modalTitle = document.getElementById('stats-modal-player-name');
    const modalBody = document.getElementById('stats-modal-body');

    if (!weeklyStatsData || weeklyStatsData.length === 0) {
        modalTitle.innerText = `📊 ${p.name}`;
        modalBody.innerHTML = `
            <div class="empty-text" style="padding: 30px; text-align:center;">
                ⚠️ No weekly stats data loaded.<br>
                Please run <b>run_draft_board.bat</b> to generate <b>weekly_stats.json</b>.
            </div>
        `;
        document.getElementById('player-stats-modal-overlay').classList.add('active');
        return;
    }

    const pNameLower = p.name.toLowerCase().trim();
    
    let pLogs = weeklyStatsData.filter(item => {
        const n1 = (item.player_name || '').toLowerCase().trim();
        const n2 = (item.player_display_name || '').toLowerCase().trim();
        return n1 === pNameLower || n2 === pNameLower;
    });

    if (pLogs.length === 0) {
        pLogs = weeklyStatsData.filter(item => {
            const n1 = (item.player_name || '').toLowerCase().trim();
            const n2 = (item.player_display_name || '').toLowerCase().trim();
            return n1.includes(pNameLower) || pNameLower.includes(n1) || n2.includes(pNameLower);
        });
    }

    if (pLogs.length === 0) {
        modalTitle.innerText = `📊 ${p.name}`;
        modalBody.innerHTML = `
            <div class="empty-text" style="padding: 30px; text-align:center;">
                ℹ️ No game logs found in weekly_stats.json for <b>${p.name}</b>.
            </div>
        `;
        document.getElementById('player-stats-modal-overlay').classList.add('active');
        return;
    }

    const availableSeasons = [...new Set(pLogs.map(g => Number(g.season)))].sort((a,b) => b - a);
    const activeSeason = selectedSeason ? Number(selectedSeason) : availableSeasons[0];

    const seasonLogs = pLogs.filter(g => Number(g.season) === activeSeason && Number(g.week) >= 1 && Number(g.week) <= 18);

    const weekMap = new Map();
    seasonLogs.forEach(g => {
        const wk = Number(g.week);
        if (wk < 1 || wk > 18) return;

        if (!weekMap.has(wk)) {
            weekMap.set(wk, g);
        } else {
            const existing = weekMap.get(wk);
            const existingPts = calculateGameFantasyPoints(existing);
            const currentPts = calculateGameFantasyPoints(g);

            if (currentPts > existingPts) {
                weekMap.set(wk, g);
            }
        }
    });

    const uniqueWeekLogs = Array.from(weekMap.values()).sort((a,b) => Number(a.week) - Number(b.week));

    let passYds = 0, rushYds = 0, recYds = 0, totalTds = 0, totalPts = 0;
    uniqueWeekLogs.forEach(g => {
        passYds += Number(g.passing_yards || 0);
        rushYds += Number(g.rushing_yards || 0);
        recYds += Number(g.receiving_yards || 0);
        totalTds += Number(g.passing_tds || 0) + Number(g.rushing_tds || 0) + Number(g.receiving_tds || 0);
        totalPts += calculateGameFantasyPoints(g);
    });

    let formatLabel = 'Pts';
    if (scoringFormat.startsWith('PPR')) formatLabel = 'PPR Pts';
    else if (scoringFormat.startsWith('HALF')) formatLabel = 'Half Pts';
    else formatLabel = 'Std Pts';
    if (scoringFormat.endsWith('_6')) formatLabel += ' (6pt TD)';

    let rowsHtml = uniqueWeekLogs.map(g => {
        let gamePts = calculateGameFantasyPoints(g);
        return `
            <tr>
                <td>Wk ${g.week}</td>
                <td>${g.recent_team || p.team}</td>
                <td>vs ${g.opponent_team || '-'}</td>
                <td>${g.passing_yards || 0}</td>
                <td>${g.rushing_yards || 0}</td>
                <td>${g.receiving_yards || 0}</td>
                <td style="color: var(--accent-green); font-weight:900;">${gamePts.toFixed(1)}</td>
            </tr>
        `;
    }).join('');

    const avatarUrl = getPlayerHeadshot(p);

    modalTitle.innerHTML = `
        <div style="display:flex; align-items:center; gap:12px;">
            <img src="${avatarUrl}" class="player-avatar-img" style="width:48px; height:48px;" alt="${p.name}">
            <div>
                <div>📊 ${p.name}</div>
                <div style="font-size:12px; color:var(--text-secondary); font-weight:700;">${p.team} — ${p.displayPos || p.pos}</div>
            </div>
        </div>
    `;

    modalBody.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; background:var(--bg-main); padding:8px 14px; border-radius:8px; border:1px solid var(--border-color);">
            <span style="font-weight:800; font-size:13px; color:var(--text-secondary);">Select Season:</span>
            <select class="snake-select" onchange="openPlayerStatsModal(${p.id}, this.value)">
                ${availableSeasons.map(s => `<option value="${s}" ${s === activeSeason ? 'selected' : ''}>${s} Season</option>`).join('')}
            </select>
        </div>
        <div class="stats-grid-summary">
            <div class="stat-summary-card">
                <div class="stat-summary-val">${passYds}</div>
                <div class="stat-summary-label">Pass Yds</div>
            </div>
            <div class="stat-summary-card">
                <div class="stat-summary-val">${rushYds}</div>
                <div class="stat-summary-label">Rush Yds</div>
            </div>
            <div class="stat-summary-card">
                <div class="stat-summary-val">${recYds}</div>
                <div class="stat-summary-label">Rec Yds</div>
            </div>
            <div class="stat-summary-card">
                <div class="stat-summary-val" style="color: var(--accent-blue);">${totalPts.toFixed(1)}</div>
                <div class="stat-summary-label">Total ${formatLabel}</div>
            </div>
        </div>
        <div class="stats-table-wrapper">
            <table>
                <thead>
                    <tr>
                        <th>Week</th>
                        <th>Team</th>
                        <th>Opp</th>
                        <th>Pass Yds</th>
                        <th>Rush Yds</th>
                        <th>Rec Yds</th>
                        <th>${formatLabel}</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml || '<tr><td colspan="7" class="empty-text">No regular season games recorded</td></tr>'}
                </tbody>
            </table>
        </div>
    `;

    document.getElementById('player-stats-modal-overlay').classList.add('active');
}

function closePlayerStatsModal() {
    document.getElementById('player-stats-modal-overlay').classList.remove('active');
}

function handleCompareClick(pId) {
    if (comparePlayer1Id === null) {
        comparePlayer1Id = pId;
        const p1 = getPlayer(pId);
        showToast(`🆚 Selected ${p1 ? p1.name : 'Player'}. Click 🆚 on another player to compare!`);
        renderBoard();
    } else if (comparePlayer1Id === pId) {
        comparePlayer1Id = null;
        showToast("❌ Comparison cleared");
        renderBoard();
    } else {
        openCompareModal(comparePlayer1Id, pId);
        comparePlayer1Id = null;
        renderBoard();
    }
}

function openCompareModal(id1, id2) {
    const p1 = getPlayer(id1);
    const p2 = getPlayer(id2);
    if (!p1 || !p2) return;

    const modalBody = document.getElementById('compare-modal-body');

    const getStatsSum = (pName) => {
        if (!weeklyStatsData || weeklyStatsData.length === 0) return { pts: 0, passYds: 0, rushYds: 0, recYds: 0, tds: 0 };
        const nameLower = pName.toLowerCase().trim();
        const logs = weeklyStatsData.filter(g => {
            const n1 = (g.player_name || '').toLowerCase().trim();
            const n2 = (g.player_display_name || '').toLowerCase().trim();
            return n1 === nameLower || n2 === nameLower;
        });

        if (logs.length === 0) return { pts: 0, passYds: 0, rushYds: 0, recYds: 0, tds: 0 };

        const latestSeason = Math.max(...logs.map(g => Number(g.season)));
        const seasonLogs = logs.filter(g => Number(g.season) === latestSeason && Number(g.week) >= 1 && Number(g.week) <= 18);

        const weekMap = new Map();
        seasonLogs.forEach(g => {
            const wk = Number(g.week);
            if (wk >= 1 && wk <= 18) {
                if (!weekMap.has(wk) || calculateGameFantasyPoints(g) > calculateGameFantasyPoints(weekMap.get(wk))) {
                    weekMap.set(wk, g);
                }
            }
        });

        let totalPts = 0, passYds = 0, rushYds = 0, recYds = 0, tds = 0;
        Array.from(weekMap.values()).forEach(g => {
            totalPts += calculateGameFantasyPoints(g);
            passYds += Number(g.passing_yards || 0);
            rushYds += Number(g.rushing_yards || 0);
            recYds += Number(g.receiving_yards || 0);
            tds += Number(g.passing_tds || 0) + Number(g.rushing_tds || 0) + Number(g.receiving_tds || 0);
        });

        return { pts: totalPts, passYds, rushYds, recYds, tds, season: latestSeason };
    };

    const s1 = getStatsSum(p1.name);
    const s2 = getStatsSum(p2.name);

    const av1 = getPlayerHeadshot(p1);
    const av2 = getPlayerHeadshot(p2);

    modalBody.innerHTML = `
        <div class="compare-grid">
            <div class="compare-card">
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
                    <img src="${av1}" class="player-avatar-img" style="width:48px; height:48px;" alt="${p1.name}">
                    <div>
                        <div style="font-size:18px; font-weight:900; color:var(--text-primary);">${p1.name}</div>
                        <div><span class="badge ${p1.posClass}">${p1.displayPos || p1.pos}</span> ${p1.team} • Bye ${p1.bye}</div>
                    </div>
                </div>
                <div class="compare-stat-row ${p1.rank < p2.rank ? 'winner' : ''}"><span>Overall Rank:</span> <b>#${p1.rank}</b></div>
                <div class="compare-stat-row ${ (p1.ceilingPosRank || p1.posRank) < (p2.ceilingPosRank || p2.posRank) ? 'winner' : ''}"><span>Positional Ceiling:</span> <b>${p1.pos}${p1.ceilingPosRank || p1.posRank}</b></div>
                <div class="compare-stat-row"><span>Tier:</span> <b>Tier ${p1.tier}</b></div>
                <div class="compare-stat-row ${s1.pts > s2.pts ? 'winner' : ''}"><span>Fantasy Points (${s1.season || 'Recent'}):</span> <b>${s1.pts.toFixed(1)}</b></div>
                <div class="compare-stat-row"><span>Pass / Rush / Rec Yds:</span> <b>${s1.passYds} / ${s1.rushYds} / ${s1.recYds}</b></div>
                <div class="compare-stat-row ${s1.tds > s2.tds ? 'winner' : ''}"><span>Total Touchdowns:</span> <b>${s1.tds}</b></div>
            </div>

            <div class="compare-card">
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
                    <img src="${av2}" class="player-avatar-img" style="width:48px; height:48px;" alt="${p2.name}">
                    <div>
                        <div style="font-size:18px; font-weight:900; color:var(--text-primary);">${p2.name}</div>
                        <div><span class="badge ${p2.posClass}">${p2.displayPos || p2.pos}</span> ${p2.team} • Bye ${p2.bye}</div>
                    </div>
                </div>
                <div class="compare-stat-row ${p2.rank < p1.rank ? 'winner' : ''}"><span>Overall Rank:</span> <b>#${p2.rank}</b></div>
                <div class="compare-stat-row ${ (p2.ceilingPosRank || p2.posRank) < (p1.ceilingPosRank || p1.posRank) ? 'winner' : ''}"><span>Positional Ceiling:</span> <b>${p2.pos}${p2.ceilingPosRank || p2.posRank}</b></div>
                <div class="compare-stat-row"><span>Tier:</span> <b>Tier ${p2.tier}</b></div>
                <div class="compare-stat-row ${s2.pts > s1.pts ? 'winner' : ''}"><span>Fantasy Points (${s2.season || 'Recent'}):</span> <b>${s2.pts.toFixed(1)}</b></div>
                <div class="compare-stat-row"><span>Pass / Rush / Rec Yds:</span> <b>${s2.passYds} / ${s2.rushYds} / ${s2.recYds}</b></div>
                <div class="compare-stat-row ${s2.tds > s1.tds ? 'winner' : ''}"><span>Total Touchdowns:</span> <b>${s2.tds}</b></div>
            </div>
        </div>
    `;

    document.getElementById('compare-modal-overlay').classList.add('active');
}

function closeCompareModal() {
    document.getElementById('compare-modal-overlay').classList.remove('active');
}

function openEditPlayerModal(playerId) {
    pendingEditPlayerId = playerId;
    const p = getPlayer(playerId);
    if (!p) return;
    document.getElementById('edit-p-name').value = p.name || '';
    document.getElementById('edit-p-team').value = p.team || '';
    document.getElementById('edit-p-pos').value = p.pos || 'RB';
    document.getElementById('edit-p-rank').value = p.rank || 1;
    document.getElementById('edit-p-ceiling').value = p.ceilingPosRank || '';
    document.getElementById('edit-p-tier').value = p.tier || 'S';
    document.getElementById('edit-player-modal-overlay').classList.add('active');
}

function closeEditPlayerModal() {
    document.getElementById('edit-player-modal-overlay').classList.remove('active');
    pendingEditPlayerId = null;
}

function saveEditedPlayer() {
    if (!pendingEditPlayerId) return;
    const p = getPlayer(pendingEditPlayerId);
    if (!p) return;

    const name = sanitizePlainText(document.getElementById('edit-p-name').value);
    const team = sanitizePlainText(document.getElementById('edit-p-team').value).toUpperCase();
    const pos = document.getElementById('edit-p-pos').value;
    const newRankVal = parseInt(document.getElementById('edit-p-rank').value) || p.rank;
    const ceilingPosRank = parseInt(document.getElementById('edit-p-ceiling').value) || null;
    const tier = document.getElementById('edit-p-tier').value;

    if (!name) return flagInvalidField(document.getElementById('edit-p-name'), "Player name is required");

    if (newRankVal !== p.rank && (p.prevRank === undefined || p.prevRank === null)) {
        p.prevRank = p.rank;
    }

    p.name = name;
    p.team = team;
    p.bye = nflByes[team] || '-';
    p.pos = pos;
    p.posClass = 'pos-' + pos.toLowerCase();
    p.rank = newRankVal;
    p.ceilingPosRank = ceilingPosRank;
    p.tier = tier;

    updatePositionalRanks();
    saveDraftState();
    closeEditPlayerModal();
    renderCurrentActiveView();
    showToast(`✏️ Updated ${name}`);
}

function setTag(playerId, tag) {
    if (!tag) {
        delete playerTags[playerId];
    } else {
        playerTags[playerId] = tag;
    }
    saveDraftState();
    renderCurrentActiveView();
}

function filterTag(tag, btnElement) {
    currentTagFilter = tag;
    document.querySelectorAll('.btn-tag-filter').forEach(b => b.classList.remove('active'));
    if (btnElement) btnElement.classList.add('active');
    renderBoard();
}

function toggleHideKDst(val) {
    hideKDst = val;
    saveDraftState();
    renderBoard();
}

function recordPick(playerId, teamId, triggerSound = true) {
    redoStack = [];
    addPickToHistory(playerId, teamId, triggerSound);
    resetTimer();
    updateUndoButton();
    updateSnakeTracker();
}

function addPickToHistory(playerId, teamId, triggerSound = true) {
    const player = getPlayer(playerId);
    const team = teams.find(t => t.id === Number(teamId));

    const existingIndex = pickHistory.findIndex(p => p.playerId === playerId);
    if (existingIndex === -1) {
        pickHistory.push({ 
            pickNum: pickHistory.length + 1, 
            playerId, 
            playerName: player ? player.name : 'Unknown', 
            teamName: team ? team.name : 'Team '+teamId, 
            pos: player ? player.pos : '' 
        });
        if (triggerSound) playPickInSound();
        return true;
    }
    return false;
}

let redoStack = [];

function undoLastPick() {
    if (pickHistory.length === 0) return;
    const lastPick = pickHistory.pop();
    const pId = lastPick.playerId;
    const player = getPlayer(pId);

    // Snapshot what this pick's state looked like so redoLastUndo() can restore it.
    redoStack.push({
        pick: lastPick,
        status: stateTracker[pId] || null,
        draftSlot: playerDraftMap[pId] !== undefined ? playerDraftMap[pId] : null
    });

    if (stateTracker[pId] === 'mine' && player && myRoster[player.pos]) myRoster[player.pos]--;
    removeFromRoster(pId);
    delete stateTracker[pId];
    delete playerDraftMap[pId];
    saveDraftState();
    updateTracker();
    updateUndoButton();
    updateSnakeTracker();
    showToast(`↩️ Undid Pick #${lastPick.pickNum}: ${lastPick.playerName}`);
    renderCurrentActiveView();
}

function redoLastUndo() {
    if (redoStack.length === 0) return;
    const snap = redoStack.pop();
    const pId = snap.pick.playerId;
    const player = getPlayer(pId);

    if (snap.status) stateTracker[pId] = snap.status;
    if (snap.draftSlot !== null) playerDraftMap[pId] = snap.draftSlot;

    if (snap.status === 'mine' && player) {
        if (myRoster[player.pos] !== undefined) myRoster[player.pos]++;
        autoAssignToRoster(player);
    }

    pickHistory.push(snap.pick);
    saveDraftState();
    updateTracker();
    updateUndoButton();
    updateSnakeTracker();
    showToast(`↪️ Redid Pick #${snap.pick.pickNum}: ${snap.pick.playerName}`);
    renderCurrentActiveView();
}

function updateUndoButton() {
    const btn = document.getElementById('undo-pick-btn');
    if (btn) {
        btn.disabled = (pickHistory.length === 0);
        btn.innerText = pickHistory.length > 0 ? `↩️ Undo (#${pickHistory.length})` : `↩️ Undo`;
    }
    const redoBtn = document.getElementById('redo-pick-btn');
    if (redoBtn) {
        redoBtn.disabled = (redoStack.length === 0);
        redoBtn.innerText = redoStack.length > 0 ? `↪️ Redo (${redoStack.length})` : `↪️ Redo`;
    }
}

function openPickLogModal() {
    const container = document.getElementById('history-log-container');
    if (!container) return;
    if (pickHistory.length === 0) container.innerHTML = `<div class="empty-text">No picks recorded yet</div>`;
    else {
        container.innerHTML = pickHistory.slice().reverse().map(p => `
            <div class="history-log-item">
                <div><span style="color:var(--text-secondary); margin-right:8px;">#${p.pickNum}</span><b>${p.playerName}</b> (${p.pos})</div>
                <span class="gone-team-badge">${p.teamName}</span>
            </div>
        `).join('');
    }
    document.getElementById('pick-log-modal-overlay').classList.add('active');
}
function closePickLogModal() { document.getElementById('pick-log-modal-overlay').classList.remove('active'); }

function renameTeam(teamId) {
    const team = teams.find(t => t.id === Number(teamId));
    if (!team) return;
    pendingRenameTeamId = Number(teamId);
    const input = document.getElementById('rename-team-input');
    if (input) input.value = team.name;
    const modal = document.getElementById('rename-team-modal-overlay');
    if (modal) modal.classList.add('active');
}

function closeRenameTeamModal() {
    const modal = document.getElementById('rename-team-modal-overlay');
    if (modal) modal.classList.remove('active');
    pendingRenameTeamId = null;
}

function saveRenamedTeam() {
    if (!pendingRenameTeamId) return;
    const team = teams.find(t => t.id === Number(pendingRenameTeamId));
    if (!team) return;
    const input = document.getElementById('rename-team-input');
    const newName = input ? sanitizePlainText(input.value) : '';
    if (newName) {
        team.name = newName;
        populateSlotSelectOptions();
        saveDraftState();
        updateSnakeTracker();
        if (currentFilter === 'LEAGUE') renderLeagueView();
        else renderBoard();
        showToast(`✏️ Renamed to ${team.name}`);
        closeRenameTeamModal();
    }
}

function openTeamRosterModal(teamId) {
    const team = teams.find(t => t.id === Number(teamId));
    if (!team) return;

    const modalTitle = document.getElementById('team-roster-modal-title');
    const modalBody = document.getElementById('team-roster-modal-body');

    const teamPlayers = Object.keys(playerDraftMap)
        .filter(pId => Number(playerDraftMap[pId]) === Number(team.id))
        .map(pId => getPlayer(pId))
        .filter(Boolean);

    teamPlayers.sort((a,b) => a.rank - b.rank);

    const counts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
    teamPlayers.forEach(p => {
        if (counts[p.pos] !== undefined) counts[p.pos]++;
    });

    const needSpecs = [
        { pos: 'QB', label: 'QB', target: 2, current: counts.QB, critical: 1 },
        { pos: 'RB', label: 'RB', target: 5, current: counts.RB, critical: 2 },
        { pos: 'WR', label: 'WR', target: 5, current: counts.WR, critical: 2 },
        { pos: 'TE', label: 'TE', target: 2, current: counts.TE, critical: 1 },
        { pos: 'K', label: 'K', target: 1, current: counts.K, critical: 1 },
        { pos: 'DST', label: 'DST', target: 1, current: counts.DST, critical: 1 }
    ];

    let needsHtml = needSpecs.map(spec => {
        let statusText = '', statusClass = '';
        if (spec.current < spec.critical) {
            statusText = `🔴 Need (${spec.current}/${spec.target})`; statusClass = 'status-critical';
        } else if (spec.current < spec.target) {
            statusText = `🟡 Depth (${spec.current}/${spec.target})`; statusClass = 'status-need';
        } else {
            statusText = `🟢 Full (${spec.current}/${spec.target})`; statusClass = 'status-complete';
        }
        return `
            <div class="need-pill" style="padding:6px 10px;">
                <span class="need-pill-pos">${spec.label}</span>
                <span class="need-pill-status ${statusClass}">${statusText}</span>
            </div>`;
    }).join('');

    const posOrder = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
    let rosterGroupedHtml = posOrder.map(pos => {
        const posPlayers = teamPlayers.filter(p => p.pos === pos);
        if (posPlayers.length === 0) {
            return `
                <div style="margin-bottom:10px;">
                    <div style="font-size:12px; font-weight:800; color:var(--text-secondary); margin-bottom:4px;">${pos} (0)</div>
                    <div class="empty-text" style="padding:6px; justify-content:flex-start;">None drafted</div>
                </div>`;
        }
        return `
            <div style="margin-bottom:12px;">
                <div style="font-size:12px; font-weight:800; color:var(--text-secondary); margin-bottom:6px;">${pos} (${posPlayers.length})</div>
                <div style="display:flex; flex-direction:column; gap:4px;">
                    ${posPlayers.map(p => {
                        const av = getPlayerHeadshot(p);
                        return `
                            <div class="team-player-row">
                                <span class="player-name-link" style="display:flex; align-items:center; gap:8px;" onclick="closeTeamRosterModal(); openPlayerStatsModal(${p.id})">
                                    <img src="${av}" class="player-avatar-img" style="width:28px; height:28px;" alt="${p.name}">
                                    <b>${p.name}</b> <span style="color:var(--text-muted); font-size:12px;">(${p.team || ''})</span>
                                </span>
                                <span class="badge ${p.posClass}">${p.displayPos || p.pos}</span>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>`;
    }).join('');

    modalTitle.innerText = `FD ${team.name} — Roster & Position Needs`;
    modalBody.innerHTML = `
        <div class="needs-summary-card" style="margin-bottom:16px; padding:12px 16px;">
            <div style="font-size:13px; font-weight:800; color:var(--text-primary); margin-bottom:10px;">🎯 Positional Need Status</div>
            <div class="needs-grid" style="grid-template-columns: repeat(3, 1fr); gap:8px;">${needsHtml}</div>
        </div>
        <div style="max-height:320px; overflow-y:auto; padding-right:4px;">
            ${rosterGroupedHtml}
        </div>
    `;

    document.getElementById('team-roster-modal-overlay').classList.add('active');
}

function closeTeamRosterModal() {
    document.getElementById('team-roster-modal-overlay').classList.remove('active');
}

let searchDebounceTimer = null;
function handleSearch(val) {
    searchQuery = val.trim().toLowerCase();
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(renderBoard, 60);
}

function setupEventDelegation() {
    const boardBody = document.getElementById('board-body');
    if (!boardBody) return;

    boardBody.addEventListener('click', (e) => {
        const target = e.target;
        const row = target.closest('tr');
        if (!row || !row.dataset.id) return;
        const pId = parseInt(row.dataset.id);

        if (target.classList.contains('player-name-link')) openPlayerStatsModal(pId);
        else if (target.classList.contains('btn-draft')) openTeamModal(pId);
        else if (target.classList.contains('btn-compare')) handleCompareClick(pId);
        else if (target.classList.contains('btn-tag')) {
            e.stopPropagation();
            document.querySelectorAll('.tag-menu.active').forEach(m => {
                if (m.id !== `tag-menu-${pId}`) m.classList.remove('active');
            });
            const menu = document.getElementById(`tag-menu-${pId}`);
            if (menu) menu.classList.toggle('active');
        }
        else if (target.classList.contains('tag-menu-item')) {
            e.stopPropagation();
            const tagVal = target.dataset.tag;
            setTag(pId, tagVal || null);
        }
        else if (target.classList.contains('btn-edit')) openEditPlayerModal(pId);
        else if (target.classList.contains('btn-delete')) deletePlayer(pId);
        else if (target.classList.contains('rank-badge')) {
            e.stopPropagation();
            startRankEdit(target, pId);
        }
    });

    boardBody.addEventListener('change', (e) => {
        const target = e.target;
        const row = target.closest('tr');
        if (!row || !row.dataset.id) return;
        const pId = parseInt(row.dataset.id);

        if (target.id === `mine-${pId}`) toggleStatus(pId, 'mine');
        else if (target.id === `gone-${pId}`) toggleStatus(pId, 'gone');
        else if (target.classList.contains('tier-select')) updateTier(pId, target.value);
    });

    // Keyboard activation for the player-name-link, which is a <span role="button">
    // (not a real <button>/<a>) so Enter/Space don't trigger a click natively.
    boardBody.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('player-name-link')) {
            e.preventDefault();
            e.target.click();
            return;
        }

        // Row-level keyboard navigation: only handle this when the row itself
        // (the focused <tr>, tabindex="0") has focus — not when focus is on a
        // nested control like a button/input/select, which have their own
        // native keyboard behavior we don't want to override.
        if (e.target.tagName !== 'TR' || !e.target.classList.contains('player-row')) return;
        const pId = parseInt(e.target.dataset.id);
        if (isNaN(pId)) return;

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const rows = Array.from(boardBody.querySelectorAll('tr.player-row'));
            const idx = rows.indexOf(e.target);
            const nextIdx = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
            if (rows[nextIdx]) {
                e.target.tabIndex = -1;
                rows[nextIdx].tabIndex = 0;
                rows[nextIdx].focus();
            }
        } else if (e.key === ' ') {
            e.preventDefault();
            toggleStatus(pId, 'mine');
        } else if (e.key === 'Enter') {
            e.preventDefault();
            openPlayerStatsModal(pId);
        }
    });
}

// --- CLICK-TO-EDIT RANK BADGE ---
// Turns the rank badge into a small text field the user can type a new
// position into. No native number spinner involved.
function startRankEdit(badgeEl, pId) {
    const p = getPlayer(pId);
    if (!p) return;
    const originalVal = p.rank;

    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.pattern = '[0-9]*';
    input.className = 'rank-edit-input';
    input.value = originalVal;

    badgeEl.replaceWith(input);
    input.focus();
    input.select();

    let settled = false;
    const commit = () => {
        if (settled) return;
        settled = true;
        const newVal = parseInt(input.value, 10);
        if (!isNaN(newVal) && newVal > 0 && newVal !== originalVal) {
            moveToRank(pId, newVal);
        } else {
            renderBoard();
        }
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
            input.blur();
        } else if (ev.key === 'Escape') {
            settled = true;
            renderBoard();
        }
    });
}

window.addEventListener('click', (e) => {
    if (!e.target.closest('.tag-dropdown')) {
        document.querySelectorAll('.tag-menu.active').forEach(m => m.classList.remove('active'));
    }
});

function openTeamModal(playerId) {
    pendingModalPlayerId = playerId;
    const player = getPlayer(playerId);
    if (!player) return;
    document.getElementById('modal-player-name').innerText = player.name;
    document.getElementById('modal-player-info').innerText = `${player.team || ''} • ${player.displayPos || player.pos} (#${player.rank})`;
    const onClock = getCurrentOnClockInfo();
    const quickBtn = document.getElementById('modal-quick-draft-btn');
    if (quickBtn) {
        quickBtn.innerHTML = `⚡ Quick Draft to <b>${onClock.team.name}</b> (On Clock #${onClock.overall})`;
        quickBtn.onclick = () => selectDraftTeam(onClock.team.id);
    }
    const grid = document.getElementById('modal-teams-grid');
    grid.innerHTML = teams.map(t => `
        <button class="btn-select-team ${t.id === onClock.team.id ? 'on-clock-team' : ''}" onclick="selectDraftTeam(${t.id})">
            <span>${t.name}</span>
        </button>
    `).join('');
    document.getElementById('team-modal-overlay').classList.add('active');
}
function closeTeamModal() { document.getElementById('team-modal-overlay').classList.remove('active'); pendingModalPlayerId = null; }

function selectDraftTeam(teamId) {
    if (!pendingModalPlayerId) return;
    const pId = pendingModalPlayerId;
    const player = getPlayer(pId);
    playerDraftMap[pId] = Number(teamId);
    if (Number(teamId) === Number(myDraftSlot)) {
        stateTracker[pId] = 'mine';
        if (player && myRoster[player.pos] !== undefined) myRoster[player.pos]++;
        autoAssignToRoster(player);
    } else {
        stateTracker[pId] = 'gone';
        removeFromRoster(pId);
    }
    recordPick(pId, Number(teamId));
    closeTeamModal();
    saveDraftState();
    updateTracker();
    updateSnakeTracker();
    renderCurrentActiveView();
}

function renderLeagueView() {
    const container = document.getElementById('league-view-container');
    if (!container) return;
    container.classList.remove('tab-view-content');
    void container.offsetWidth;
    container.classList.add('tab-view-content');

    container.innerHTML = `<div class="league-teams-grid">` + teams.map(team => {
        const teamPlayers = Object.keys(playerDraftMap).filter(pId => Number(playerDraftMap[pId]) === Number(team.id)).map(pId => getPlayer(pId)).filter(Boolean);
        teamPlayers.sort((a,b) => a.rank - b.rank);
        return `
            <div class="team-card" onclick="openTeamRosterModal(${team.id})" style="cursor: pointer;" title="Click to inspect team roster & position needs">
                <div class="team-card-header">
                    <div class="team-title-box">
                        <span class="team-title">${team.name}</span>
                        <button class="btn-edit-team" onclick="event.stopPropagation(); renameTeam(${team.id})" title="Rename Team">✏️</button>
                    </div>
                    <span class="team-count-badge">${teamPlayers.length} Drafted</span>
                </div>
                <div class="team-roster-list">${teamPlayers.length === 0 ? '<div class="empty-text">No players drafted yet</div>' : teamPlayers.map(p => {
                    const av = getPlayerHeadshot(p);
                    return `
                        <div class="team-player-row">
                            <span class="team-player-name player-name-link" style="display:flex; align-items:center; gap:8px;" onclick="event.stopPropagation(); openPlayerStatsModal(${p.id})">
                                <img src="${av}" class="player-avatar-img" style="width:28px; height:28px;" alt="${p.name}">
                                ${p.name} <span style="color:var(--text-muted); font-size:12px;">(${p.team || ''})</span>
                            </span>
                            <span class="badge ${p.posClass}">${p.displayPos || p.pos}</span>
                        </div>
                    `;
                }).join('')}</div>
            </div>`;
    }).join('') + `</div>`;
}

const defaultRosterSlots = [
    { id: 'QB1', label: 'Quarterback', slotType: 'QB', allowedPos: ['QB'], pillClass: 'pill-qb' },
    { id: 'RB1', label: 'Running Back 1', slotType: 'RB', allowedPos: ['RB'], pillClass: 'pill-rb' },
    { id: 'RB2', label: 'Running Back 2', slotType: 'RB', allowedPos: ['RB'], pillClass: 'pill-rb' },
    { id: 'WR1', label: 'Wide Receiver 1', slotType: 'WR', allowedPos: ['WR'], pillClass: 'pill-wr' },
    { id: 'WR2', label: 'Wide Receiver 2', slotType: 'WR', allowedPos: ['WR'], pillClass: 'pill-wr' },
    { id: 'FLEX1', label: 'Flex 1 (RB/WR/TE)', slotType: 'FLEX', allowedPos: ['RB', 'WR', 'TE'], pillClass: 'pill-flex' },
    { id: 'FLEX2', label: 'Flex 2 (RB/WR/TE)', slotType: 'FLEX', allowedPos: ['RB', 'WR', 'TE'], pillClass: 'pill-flex' },
    { id: 'K1', label: 'Kicker', slotType: 'K', allowedPos: ['K'], pillClass: 'pill-k' },
    { id: 'DST1', label: 'Defense / ST', slotType: 'DST', allowedPos: ['DST'], pillClass: 'pill-dst' },
    { id: 'BENCH1', label: 'Bench 1', slotType: 'BENCH', allowedPos: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'], pillClass: 'pill-bench' },
    { id: 'BENCH2', label: 'Bench 2', slotType: 'BENCH', allowedPos: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'], pillClass: 'pill-bench' },
    { id: 'BENCH3', label: 'Bench 3', slotType: 'BENCH', allowedPos: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'], pillClass: 'pill-bench' }
];

const slotTypeMeta = {
    'QB': { label: 'Quarterback', allowedPos: ['QB'], pillClass: 'pill-qb' },
    'RB': { label: 'Running Back', allowedPos: ['RB'], pillClass: 'pill-rb' },
    'WR': { label: 'Wide Receiver', allowedPos: ['WR'], pillClass: 'pill-wr' },
    'TE': { label: 'Tight End', allowedPos: ['TE'], pillClass: 'pill-te' },
    'FLEX': { label: 'Flex (RB/WR/TE)', allowedPos: ['RB', 'WR', 'TE'], pillClass: 'pill-flex' },
    'K': { label: 'Kicker', allowedPos: ['K'], pillClass: 'pill-k' },
    'DST': { label: 'Defense / ST', allowedPos: ['DST'], pillClass: 'pill-dst' },
    'BENCH': { label: 'Bench', allowedPos: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'], pillClass: 'pill-bench' }
};

let customRosterSlots = JSON.parse(JSON.stringify(defaultRosterSlots));
let rosterAssignments = {};
let draggedSlotId = null;

function addSlot(type) {
    const meta = slotTypeMeta[type];
    if (!meta) return null;
    const count = customRosterSlots.filter(s => s.slotType === type).length + 1;
    let uniqueId = type + count;
    let idx = 1;
    while (customRosterSlots.some(s => s.id === uniqueId)) {
        idx++;
        uniqueId = type + (count + idx - 1);
    }
    const newSlot = {
        id: uniqueId,
        label: `${meta.label} ${uniqueId.replace(type, '')}`,
        slotType: type,
        allowedPos: [...meta.allowedPos],
        pillClass: meta.pillClass
    };
    customRosterSlots.push(newSlot);
    saveDraftState();
    renderRosterView();
    showToast(`➕ Added 1 ${type} slot`);
    return newSlot;
}

function removeSlot(type) {
    const matchingSlots = customRosterSlots.filter(s => s.slotType === type);
    if (matchingSlots.length === 0) return showToast(`⚠️ No ${type} slots to remove`);
    let slotToRemove = [...matchingSlots].reverse().find(s => !rosterAssignments[s.id]) || matchingSlots[matchingSlots.length - 1];
    const assignedPlayerId = rosterAssignments[slotToRemove.id];
    if (assignedPlayerId) {
        delete rosterAssignments[slotToRemove.id];
        const p = getPlayer(assignedPlayerId);
        if (p) autoAssignToRoster(p);
    }
    const slotIndex = customRosterSlots.findIndex(s => s.id === slotToRemove.id);
    if (slotIndex !== -1) customRosterSlots.splice(slotIndex, 1);
    saveDraftState();
    renderRosterView();
    showToast(`➖ Removed 1 ${type} slot`);
}

function autoAssignToRoster(player) {
    for (let slotId in rosterAssignments) if (rosterAssignments[slotId] === player.id) return slotId;
    const slots = getAllRosterSlots();
    let openSlot = slots.find(s => !rosterAssignments[s.id] && s.allowedPos.length === 1 && s.allowedPos[0] === player.pos) ||
                   slots.find(s => !rosterAssignments[s.id] && s.slotType !== 'BENCH' && s.allowedPos.includes(player.pos)) ||
                   slots.find(s => !rosterAssignments[s.id] && s.slotType === 'BENCH' && s.allowedPos.includes(player.pos));
    
    if (!openSlot) {
        openSlot = addSlot('BENCH');
    }

    if (openSlot) {
        rosterAssignments[openSlot.id] = player.id;
        return openSlot.id;
    }
    return null;
}

function removeFromRoster(playerId) {
    for (let slotId in rosterAssignments) {
        if (rosterAssignments[slotId] === playerId) {
            delete rosterAssignments[slotId];
            break;
        }
    }
}

function getAllRosterSlots() {
    const positionOrderMap = { 'QB': 1, 'RB': 2, 'WR': 3, 'TE': 4, 'FLEX': 5, 'K': 6, 'DST': 7, 'BENCH': 8 };
    return [...customRosterSlots].sort((a, b) => {
        const orderA = positionOrderMap[a.slotType] || 99;
        const orderB = positionOrderMap[b.slotType] || 99;
        if (orderA !== orderB) return orderA - orderB;
        const numA = parseInt(a.id.replace(/\D/g, '')) || 0;
        const numB = parseInt(b.id.replace(/\D/g, '')) || 0;
        return numA - numB;
    });
}

function renderRosterView() {
    const container = document.getElementById('roster-view-container');
    if (!container) return;
    
    container.classList.remove('tab-view-content');
    void container.offsetWidth;
    container.classList.add('tab-view-content');

    const slots = getAllRosterSlots();
    const starterSlots = slots.filter(s => s.slotType !== 'BENCH');
    const benchSlots = slots.filter(s => s.slotType === 'BENCH');

    const starterByes = {};
    starterSlots.forEach(slot => {
        const pId = rosterAssignments[slot.id];
        if (pId) {
            const p = getPlayer(pId);
            if (p && p.bye && p.bye !== '-') {
                if (!starterByes[p.bye]) starterByes[p.bye] = [];
                starterByes[p.bye].push(p);
            }
        }
    });

    let conflictBanners = [];
    for (let byeWeek in starterByes) {
        if (starterByes[byeWeek].length >= 2) {
            const names = starterByes[byeWeek].map(p => `${p.name} (${p.team})`).join(', ');
            conflictBanners.push(`
                <div class="bye-alert-banner">
                    ⚠️ <b>Bye Week ${byeWeek} Conflict:</b> ${starterByes[byeWeek].length} starting players on Bye simultaneously [${names}]
                </div>
            `);
        }
    }

    const myPlayerList = Object.values(rosterAssignments).map(pId => getPlayer(pId)).filter(Boolean);
    const myCounts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
    myPlayerList.forEach(p => myCounts[p.pos] = (myCounts[p.pos] || 0) + 1);

    const needSpecs = [
        { pos: 'QB', label: 'Quarterbacks', target: 2, current: myCounts.QB, criticalIfBelow: 1 },
        { pos: 'RB', label: 'Running Backs', target: 5, current: myCounts.RB, criticalIfBelow: 2 },
        { pos: 'WR', label: 'Wide Receivers', target: 5, current: myCounts.WR, criticalIfBelow: 2 },
        { pos: 'TE', label: 'Tight Ends', target: 2, current: myCounts.TE, criticalIfBelow: 1 },
        { pos: 'K', label: 'Kicker', target: 1, current: myCounts.K, criticalIfBelow: 1 },
        { pos: 'DST', label: 'Defense/ST', target: 1, current: myCounts.DST, criticalIfBelow: 1 }
    ];

    let needsPillsHtml = needSpecs.map(spec => {
        let statusText = '', statusClass = '';
        if (spec.current < spec.criticalIfBelow) {
            statusText = `🔴 Critical Need (${spec.current}/${spec.target})`; statusClass = 'status-critical';
        } else if (spec.current < spec.target) {
            statusText = `🟡 Depth Needed (${spec.current}/${spec.target})`; statusClass = 'status-need';
        } else {
            statusText = `🟢 Complete (${spec.current}/${spec.target})`; statusClass = 'status-complete';
        }
        return `<div class="need-pill"><span class="need-pill-pos">${spec.label}</span><span class="need-pill-status ${statusClass}">${statusText}</span></div>`;
    }).join('');

    const slotTypesToConfigure = [
        { type: 'QB', label: 'QB' }, { type: 'RB', label: 'RB' }, { type: 'WR', label: 'WR' },
        { type: 'TE', label: 'TE' }, { type: 'FLEX', label: 'FLEX' }, { type: 'K', label: 'K' },
        { type: 'DST', label: 'DST' }, { type: 'BENCH', label: 'BENCH' }
    ];

    let slotConfigHtml = slotTypesToConfigure.map(st => {
        const count = customRosterSlots.filter(s => s.slotType === st.type).length;
        return `
            <div class="slot-config-item">
                <span class="slot-config-label">${st.label}</span>
                <div class="slot-config-ctrls">
                    <button class="btn-slot-ctrl" onclick="removeSlot('${st.type}')">-</button>
                    <span class="slot-config-count">${count}</span>
                    <button class="btn-slot-ctrl" onclick="addSlot('${st.type}')">+</button>
                </div>
            </div>
        `;
    }).join('');

    let htmlBuf = [];

    htmlBuf.push(`
        <div class="roster-card-section" style="margin-bottom: 20px;">
            <div class="roster-card-header" style="padding-bottom: 8px; margin-bottom: 12px;">
                <h3>⚙️ Custom Roster Positions</h3>
                <span class="roster-subtext">Add or remove position slots to customize your lineup</span>
            </div>
            <div class="slot-config-grid">${slotConfigHtml}</div>
        </div>
    `);

    htmlBuf.push(`
        <div class="needs-summary-card">
            <div class="needs-summary-header">
                <h4>📊 Roster Health & Positional Need Indicators</h4>
                <span style="font-size: 12px; color: var(--text-secondary); font-weight: 700;">Target depth for standard draft</span>
            </div>
            <div class="needs-grid">${needsPillsHtml}</div>
        </div>
    `);

    htmlBuf.push(`
        <div class="roster-card-section">
            <div class="roster-card-header">
                <h3>⚡ Starting Lineup</h3>
                <span class="roster-subtext">💡 Drag & drop players between slots to rearrange starters</span>
            </div>
            ${conflictBanners.join('')}
            <div class="roster-grid">
    `);

    starterSlots.forEach(slot => htmlBuf.push(renderSlotCardHtml(slot)));
    htmlBuf.push(`</div></div>`);

    htmlBuf.push(`
        <div class="roster-card-section">
            <div class="roster-card-header">
                <h3>🪑 Bench</h3>
                <span class="roster-subtext">Reservations & Backup Options</span>
            </div>
            <div class="roster-grid">
    `);

    benchSlots.forEach(slot => htmlBuf.push(renderSlotCardHtml(slot)));
    htmlBuf.push(`</div></div>`);

    container.innerHTML = htmlBuf.join('');
}

function renderSlotCardHtml(slot) {
    const playerId = rosterAssignments[slot.id];
    const player = playerId ? getPlayer(playerId) : null;
    const isFilled = !!player;

    let cardContent = player ? `
        <div class="slot-player-item" draggable="true" ondragstart="handleDragStart(event, '${slot.id}')" ondragend="handleDragEnd(event)">
            <div class="player-line-1" style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                <div style="display:flex; align-items:center; gap:8px;">
                    <img src="${getPlayerHeadshot(player)}" class="player-avatar-img" style="width:36px; height:36px;" alt="${player.name}">
                    <span class="p-title player-name-link" onclick="openPlayerStatsModal(${player.id})">${player.name}</span>
                </div>
                <span class="badge ${player.posClass}">${player.displayPos || player.pos}</span>
            </div>
            <div class="player-line-2">
                <span>Team: <b>${player.team}</b></span>
                <span>Bye: <b>${player.bye}</b></span>
                <span>Rank: <b>#${player.rank}</b></span>
            </div>
        </div>
    ` : `<div class="empty-text">Empty Slot</div>`;

    return `
        <div class="roster-slot-card ${isFilled ? 'filled' : ''}" 
             id="slot-card-${slot.id}"
             ondragover="handleDragOver(event, '${slot.id}')"
             ondragleave="handleDragLeave(event, '${slot.id}')"
             ondrop="handleDrop(event, '${slot.id}')">
            <div class="slot-header">
                <span class="slot-label">${slot.label}</span>
                <span class="slot-pill ${slot.pillClass}">${slot.slotType}</span>
            </div>
            ${cardContent}
        </div>
    `;
}

function handleDragStart(event, slotId) {
    draggedSlotId = slotId;
    event.dataTransfer.setData('text/plain', slotId);
    event.dataTransfer.effectAllowed = 'move';
    const card = document.getElementById('slot-card-' + slotId);
    if (card) card.classList.add('dragging');
}

function handleDragEnd(event) {
    if (draggedSlotId) {
        const card = document.getElementById('slot-card-' + draggedSlotId);
        if (card) card.classList.remove('dragging');
    }
    draggedSlotId = null;
    document.querySelectorAll('.roster-slot-card').forEach(c => c.classList.remove('drag-over'));
}

function handleDragOver(event, slotId) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const card = document.getElementById('slot-card-' + slotId);
    if (card) card.classList.add('drag-over');
}

function handleDragLeave(event, slotId) {
    const card = document.getElementById('slot-card-' + slotId);
    if (card) card.classList.remove('drag-over');
}

function canPlayerFitInSlot(playerPos, targetSlotId) {
    const slot = getAllRosterSlots().find(s => s.id === targetSlotId);
    if (!slot) return true;
    return slot.allowedPos.includes(playerPos);
}

function handleDrop(event, targetSlotId) {
    event.preventDefault();
    document.querySelectorAll('.roster-slot-card').forEach(c => c.classList.remove('drag-over'));
    const sourceSlotId = event.dataTransfer.getData('text/plain') || draggedSlotId;
    if (!sourceSlotId || sourceSlotId === targetSlotId) return;

    const sourcePlayerId = rosterAssignments[sourceSlotId];
    if (!sourcePlayerId) return;
    const sourcePlayer = getPlayer(sourcePlayerId);
    if (!sourcePlayer) return;

    if (!canPlayerFitInSlot(sourcePlayer.pos, targetSlotId)) {
        const targetSlot = getAllRosterSlots().find(s => s.id === targetSlotId);
        return showToast(`❌ Cannot put ${sourcePlayer.pos} (${sourcePlayer.name}) into ${targetSlot ? targetSlot.label : targetSlotId}`);
    }

    const targetPlayerId = rosterAssignments[targetSlotId];
    if (targetPlayerId) {
        const targetPlayer = getPlayer(targetPlayerId);
        if (targetPlayer && !canPlayerFitInSlot(targetPlayer.pos, sourceSlotId)) {
            const sourceSlot = getAllRosterSlots().find(s => s.id === sourceSlotId);
            return showToast(`❌ Cannot swap ${targetPlayer.pos} into ${sourceSlot ? sourceSlot.label : sourceSlotId}`);
        }
        rosterAssignments[targetSlotId] = sourcePlayerId;
        rosterAssignments[sourceSlotId] = targetPlayerId;
        showToast(`🔄 Swapped ${sourcePlayer.name} ↔️ ${targetPlayer.name}`);
    } else {
        rosterAssignments[targetSlotId] = sourcePlayerId;
        delete rosterAssignments[sourceSlotId];
        const targetSlot = getAllRosterSlots().find(s => s.id === targetSlotId);
        showToast(`✅ Moved ${sourcePlayer.name} to ${targetSlot ? targetSlot.label : targetSlotId}`);
    }

    saveDraftState();
    renderRosterView();
}

function renderCurrentActiveView() {
    if (currentFilter === 'ROSTER') renderRosterView();
    else if (currentFilter === 'LEAGUE') renderLeagueView();
    else renderBoard();
}

function passesTagFilter(playerId) {
    if (currentTagFilter === 'ALL') return true;
    const tag = playerTags[playerId] || '';
    return currentTagFilter.toLowerCase() === tag;
}

function renderBoard() {
    const table = document.getElementById('draft-board');
    const tbody = document.getElementById('board-body');
    if (!tbody || !table) return;

    table.classList.remove('tab-view-content');
    void table.offsetWidth;
    table.classList.add('tab-view-content');

    updateSortHeaderIcons();

    const myByeWeeks = new Set(players.filter(p => stateTracker[p.id] === 'mine').map(p => p.bye));
    const onClock = getCurrentOnClockInfo();

    let html = '';

    let filteredPlayers = players.filter(p => {
        if (hideKDst && currentFilter === 'ALL' && ['K', 'DST'].includes(p.pos)) return false;
        if (currentFilter !== 'ALL' && p.pos !== currentFilter) return false;
        if (!passesTagFilter(p.id)) return false;
        if (searchQuery) {
            return p.name.toLowerCase().includes(searchQuery) ||
                   p.team.toLowerCase().includes(searchQuery) ||
                   p.pos.toLowerCase().includes(searchQuery) ||
                   (p.displayPos || '').toLowerCase().includes(searchQuery);
        }
        return true;
    });

    const isCustomSortActive = (currentSortColumn !== 'rank' || currentSortDirection !== 'asc');

    if (isCustomSortActive) {
        let sortLabel = currentSortColumn.toUpperCase();
        if (currentSortColumn === 'trend') sortLabel = 'RANK MOVEMENT (RISERS/FALLERS)';
        if (currentSortColumn === 'ceiling') sortLabel = 'UPSIDE CEILING';

        html += `
            <tr class="tier-row tier-o">
                <td colspan="11">
                    <div class="sort-info-banner">
                        <span>📊 Sorted globally by: <b>${sortLabel}</b> (${currentSortDirection === 'asc' ? 'Ascending ▲' : 'Descending ▼'})</span>
                        <button class="btn-reset-sort" onclick="resetSortToDefault()">↺ Reset to Rank View</button>
                    </div>
                </td>
            </tr>
        `;

        const sortedList = sortPlayerList(filteredPlayers);
        sortedList.forEach(p => {
            html += renderPlayerRowHtml(p, myByeWeeks, onClock);
        });
    } else {
        tierList.forEach(t => {
            const tierPlayers = filteredPlayers.filter(p => p.tier === t);

            if (tierPlayers.length > 0) {
                const allTierPlayers = players.filter(p => p.tier === t && (currentFilter === 'ALL' || p.pos === currentFilter) && (!hideKDst || currentFilter !== 'ALL' || !['K', 'DST'].includes(p.pos)));
                const totalInTier = allTierPlayers.length;
                const remainingInTier = allTierPlayers.filter(p => !stateTracker[p.id]).length;
                const pctRemaining = totalInTier > 0 ? Math.round((remainingInTier / totalInTier) * 100) : 0;

                html += `
                    <tr class="tier-row tier-${t.toLowerCase()}">
                        <td colspan="11">
                            <div class="tier-header-flex">
                                <span class="tier-title-pill">
                                    <span>Tier ${t}</span>
                                    <span class="tier-scarcity-badge">${remainingInTier}/${totalInTier} Left</span>
                                </span>
                                <div class="tier-progress-track" title="${pctRemaining}% Remaining in Tier ${t}">
                                    <div class="tier-progress-fill" style="width: ${pctRemaining}%;"></div>
                                </div>
                            </div>
                        </td>
                    </tr>
                `;
                tierPlayers.forEach(p => {
                    html += renderPlayerRowHtml(p, myByeWeeks, onClock);
                });
            }
        });
    }

    tbody.innerHTML = html;

    // Roving tabindex: only the first row is a Tab stop, so keyboard users
    // reach the board in one Tab press and then use arrow keys to move
    // between the (potentially hundreds of) rows — see setupEventDelegation.
    const firstRow = tbody.querySelector('tr.player-row');
    if (firstRow) firstRow.tabIndex = 0;
}

function renderPlayerRowHtml(p, myByeWeeks, onClock) {
    const isMine = stateTracker[p.id] === 'mine';
    const isGone = stateTracker[p.id] === 'gone';
    const hasByeConflict = !isMine && !isGone && myByeWeeks.has(p.bye) && p.bye !== '-';
    const pTag = playerTags[p.id] || '';

    let teamBadgeHtml = '';
    if (isGone && playerDraftMap[p.id]) {
        const draftingTeam = teams.find(t => t.id === Number(playerDraftMap[p.id]));
        if (draftingTeam) {
            teamBadgeHtml = `<span class="gone-team-badge" onclick="openTeamModal(${p.id})">${draftingTeam.name}</span>`;
        }
    }

    let stealBadgeHtml = '';
    if (!isMine && !isGone) {
        const valueDelta = onClock.overall - p.rank;
        if (valueDelta >= 8) {
            stealBadgeHtml = `<span class="steal-pill" title="Overall Rank #${p.rank} — fallen ${valueDelta} picks past ADP!">💎 +${valueDelta} Steal</span>`;
        }
    }

    let ceilingBadge = '<span style="color:var(--text-muted);">-</span>';
    if (p.ceilingPosRank && Number(p.ceilingPosRank) > 0) {
        const ceilPos = Number(p.ceilingPosRank);
        const posR = Number(p.posRank || 1);
        const diff = posR - ceilPos;
        if (diff > 0) {
            ceilingBadge = `<span class="upside-pill-col" title="Positional Ceiling ${p.pos}${ceilPos}">🚀 ${p.pos}${ceilPos} (+${diff})</span>`;
        } else {
            ceilingBadge = `<span class="ceiling-flat-pill">${p.pos}${ceilPos}</span>`;
        }
    }

    const teamClass = p.team ? `chip-${p.team.toLowerCase()}` : 'chip-default';

    const avatarUrl = getPlayerHeadshot(p);

    return `
        <tr class="player-row pos-row-${p.pos.toLowerCase()} ${isMine ? 'mine' : ''} ${isGone ? 'gone' : ''}" id="row-${p.id}" data-id="${p.id}" tabindex="-1" aria-label="${p.name}, ${p.displayPos || p.pos}, rank ${p.rank}. Press space to mark as mine, arrow keys to navigate.">
            <td><input type="checkbox" id="mine-${p.id}" ${isMine ? 'checked' : ''} aria-label="Mark ${p.name} as mine"></td>
            <td>
                <input type="checkbox" id="gone-${p.id}" ${isGone ? 'checked' : ''} aria-label="Mark ${p.name} as drafted">
                ${teamBadgeHtml}
            </td>
            <td>
                <div class="tag-dropdown">
                    <button class="btn-tag tag-${pTag}" aria-haspopup="true" aria-label="Tag ${p.name}${pTag ? ` (currently ${pTag})` : ''}">${pTag ? pTag.toUpperCase() : '🏷️ Tag'}</button>
                    <div class="tag-menu" id="tag-menu-${p.id}" role="menu">
                        <button type="button" class="tag-menu-item tag-opt-target" data-tag="target" role="menuitem">⭐ Target</button>
                        <button type="button" class="tag-menu-item tag-opt-sleeper" data-tag="sleeper" role="menuitem">🚀 Sleeper</button>
                        <button type="button" class="tag-menu-item tag-opt-avoid" data-tag="avoid" role="menuitem">⚠️ Avoid</button>
                        ${pTag ? `<button type="button" class="tag-menu-item tag-opt-clear" data-tag="" role="menuitem">❌ Clear Tag</button>` : ''}
                    </div>
                </div>
            </td>
            <td>
                <div class="rank-cell-flex">
                    <button type="button" class="rank-badge" data-id="${p.id}" title="Click to set rank position" aria-label="Rank ${p.rank} for ${p.name}, click to edit">${p.rank}</button>
                    ${getRankTrendBadge(p)}
                </div>
            </td>
            <td>${ceilingBadge}</td>
            <td class="left">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <img src="${avatarUrl}" class="player-avatar-img" alt="${p.name}" loading="lazy">
                    <span class="player-name-link" onclick="openPlayerStatsModal(${p.id})" role="button" tabindex="0" aria-label="View stats for ${p.name}">${p.name}</span>
                    ${stealBadgeHtml}
                </div>
            </td>
            <td><span class="nfl-chip ${teamClass}">${p.team}</span></td>
            <td>${p.bye}${hasByeConflict ? '<span class="bye-warning-badge" title="Bye week conflict with drafted player">⚠️ Bye</span>' : ''}</td>
            <td><span class="badge ${p.posClass}">${p.displayPos || p.pos}</span></td>
            <td><select class="tier-select" aria-label="Tier for ${p.name}">${tierList.map(x => `<option value="${x}" ${x===p.tier?'selected':''}>Tier ${x}</option>`).join('')}</select></td>
            <td>
                <button class="btn-compare ${comparePlayer1Id === p.id ? 'selected' : ''}" title="Compare Player" aria-label="Compare ${p.name}">🆚 ${comparePlayer1Id === p.id ? 'Selected' : 'VS'}</button>
                <button class="btn-draft" title="Select Drafting Team" aria-label="Assign ${p.name} to a drafting team">🏟️ Team</button>
                <button class="btn-edit" title="Edit Player" aria-label="Edit ${p.name}">✏️ Edit</button>
                <button class="btn-delete" title="Delete Player" aria-label="Delete ${p.name}">🗑️</button>
            </td>
        </tr>`;
}

// --- MOVE PLAYER TO A SPECIFIC BOARD POSITION (LOCAL SHIFT ONLY) ---
// Moves the target player to newRankVal and shifts by exactly 1 only the
// players strictly between the old and new position — it never renumbers
// the whole board, so existing ties/gaps elsewhere are left untouched.
// K/DST and skill positions (QB/RB/WR/TE) are treated as separate pools:
// moving one never shifts the other.
function moveToRank(id, newRankVal) {
    const target = getPlayer(id);
    if (!target) { renderBoard(); return; }

    const desired = parseInt(newRankVal, 10);
    if (isNaN(desired) || desired < 1) { renderBoard(); return; }

    const oldRank = Number(target.rank);
    if (desired === oldRank) { renderBoard(); return; }

    const isKDst = (target.pos === 'K' || target.pos === 'DST');
    const pool = players.filter(p => (p.pos === 'K' || p.pos === 'DST') === isKDst);

    if (desired < oldRank) {
        // Moving up (smaller number = better): everyone from desired up to
        // (but not including) oldRank slides down by 1 to make room.
        pool.forEach(p => {
            if (p.id === target.id) return;
            const r = Number(p.rank);
            if (r >= desired && r < oldRank) {
                if (p.prevRank === undefined || p.prevRank === null) p.prevRank = p.rank;
                p.rank = r + 1;
            }
        });
    } else {
        // Moving down (bigger number = worse): everyone from just after
        // oldRank up to desired slides up by 1 to close the gap.
        pool.forEach(p => {
            if (p.id === target.id) return;
            const r = Number(p.rank);
            if (r > oldRank && r <= desired) {
                if (p.prevRank === undefined || p.prevRank === null) p.prevRank = p.rank;
                p.rank = r - 1;
            }
        });
    }

    if (target.prevRank === undefined || target.prevRank === null) target.prevRank = target.rank;
    target.rank = desired;

    updatePositionalRanks();
    saveDraftState();
    renderBoard();
}
function updateTier(id, newTier) {
    const p = getPlayer(id);
    if (p) { p.tier = newTier; saveDraftState(); renderBoard(); }
}
function toggleStatus(id, type) {
    const player = getPlayer(id);
    if (!player) return;
    if (type === 'mine') {
        if (stateTracker[id] === 'mine') {
            delete stateTracker[id]; delete playerDraftMap[id];
            if (myRoster[player.pos]) myRoster[player.pos]--;
            removeFromRoster(id);
        } else {
            stateTracker[id] = 'mine'; playerDraftMap[id] = Number(myDraftSlot);
            if (myRoster[player.pos] !== undefined) myRoster[player.pos]++;
            autoAssignToRoster(player);
            recordPick(id, Number(myDraftSlot));
        }
    } else if (type === 'gone') {
        if (stateTracker[id] === 'gone') {
            delete stateTracker[id]; delete playerDraftMap[id];
        } else {
            openTeamModal(id); return;
        }
    }
    saveDraftState(); updateTracker(); updateSnakeTracker(); renderCurrentActiveView();
}

function updateTracker() {
    document.getElementById('count-qb').innerText = myRoster.QB || 0;
    document.getElementById('count-rb').innerText = myRoster.RB || 0;
    document.getElementById('count-wr').innerText = myRoster.WR || 0;
    document.getElementById('count-te').innerText = myRoster.TE || 0;
}

function deletePlayer(id) {
    players = players.filter(p => p.id !== id);
    delete stateTracker[id]; delete playerDraftMap[id];
    updatePositionalRanks();
    saveDraftState(); renderBoard();
}

function filterPos(pos, btnElement) {
    currentFilter = pos;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btnElement.classList.add('active');
    document.getElementById('draft-board').style.display = (pos === 'ROSTER' || pos === 'LEAGUE') ? 'none' : 'table';
    document.getElementById('roster-view-container').style.display = (pos === 'ROSTER') ? 'block' : 'none';
    document.getElementById('league-view-container').style.display = (pos === 'LEAGUE') ? 'block' : 'none';
    renderCurrentActiveView();
}

function showToast(msg) {
    const toast = document.getElementById('roster-toast');
    if (!toast) return;
    toast.innerText = msg; toast.classList.add('active');
    setTimeout(() => toast.classList.remove('active'), 2500);
}

window.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault();
        document.getElementById('search-input').focus();
    } else if (e.key === 'Escape') {
        closeTeamModal(); closePickLogModal(); closeAddPlayerModal(); closeEditPlayerModal(); closePlayerStatsModal(); closeTeamRosterModal(); closeRenameTeamModal(); closeCompareModal(); closeConfirmModal();
        document.querySelectorAll('.tag-menu.active').forEach(m => m.classList.remove('active'));
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault(); undoLastPick();
    } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault(); redoLastUndo();
    }
});

initTheme();
initDensityMode();
initSleeperSyncUI();
initStickyOffsetSync();
loadDraftState();
loadWeeklyStatsJson();
setupEventDelegation();
populateSlotSelectOptions();
renderBoard();
updateTimerDisplay();