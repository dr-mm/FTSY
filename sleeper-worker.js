// sleeper-worker.js
let draftId = null;
let username = 'ViniAvila';
let officialUserId = null;
let picksTimer = null;
let detailsTimer = null;

const PICKS_INTERVAL_MS = 500;   // live picks: keep this fast (well under Sleeper's ~1000 req/min limit)
const DETAILS_INTERVAL_MS = 4000; // draft order / team names: change rarely, poll gently

async function lookupUserId() {
    officialUserId = null;
    const targetUsername = username || 'ViniAvila';
    try {
        const res = await fetch(`https://api.sleeper.app/v1/user/${encodeURIComponent(targetUsername)}`);
        if (res.ok) {
            const data = await res.json();
            if (data && data.user_id) officialUserId = data.user_id;
        }
    } catch (e) {
    }
    // Tell the main thread the resolved user_id as soon as we have it,
    // instead of waiting for the next draftDetails poll (which was the
    // only place this used to get sent).
    postMessage({ type: 'userInfo', officialUserId, username: targetUsername });
}

async function pollPicks() {
    if (!draftId) return;
    try {
        const res = await fetch(`https://api.sleeper.app/v1/draft/${draftId}/picks`);
        if (!res.ok) return;
        const picks = await res.json();
        postMessage({ type: 'picks', picks, officialUserId });
    } catch (e) {
        postMessage({ type: 'error', context: 'picks', message: String(e && e.message || e) });
    }
}

async function pollDetails() {
    if (!draftId) return;
    try {
        const [draftRes, usersRes] = await Promise.all([
            fetch(`https://api.sleeper.app/v1/draft/${draftId}`),
            fetch(`https://api.sleeper.app/v1/draft/${draftId}/users`)
        ]);
        if (!draftRes.ok) return;
        const draft = await draftRes.json();
        const users = usersRes.ok ? await usersRes.json() : [];
        postMessage({ type: 'draftDetails', draft, users, officialUserId });
    } catch (e) {
        postMessage({ type: 'error', context: 'details', message: String(e && e.message || e) });
    }
}

function stopTimers() {
    if (picksTimer) clearInterval(picksTimer);
    if (detailsTimer) clearInterval(detailsTimer);
    picksTimer = null;
    detailsTimer = null;
}

self.onmessage = async (e) => {
    const msg = e.data || {};

    if (msg.type === 'start') {
        stopTimers();
        draftId = (msg.draftId || '').trim();
        username = (msg.username || 'ViniAvila').trim();

        if (!draftId) return;

        await lookupUserId();

        pollDetails();
        pollPicks();
        picksTimer = setInterval(pollPicks, PICKS_INTERVAL_MS);
        detailsTimer = setInterval(pollDetails, DETAILS_INTERVAL_MS);

    } else if (msg.type === 'stop') {
        stopTimers();
        draftId = null;
        username = 'ViniAvila';
        officialUserId = null;
    }
};