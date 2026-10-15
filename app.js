(function(){

  // Same Firebase project as Day Chain — public web config, safe to expose
  // client-side; access is enforced by firestore.rules, not by keeping this
  // secret. Reusing it means one Google account signs into both apps.
  const firebaseConfig = {
    apiKey: "AIzaSyBG3JD5KPXzr4zSuTZMElD4jDulTxgCCzg",
    authDomain: "day-chain.firebaseapp.com",
    projectId: "day-chain",
    storageBucket: "day-chain.firebasestorage.app",
    messagingSenderId: "874734696407",
    appId: "1:874734696407:web:f1e7aacbaa89705a1a7d92"
  };
  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  // iPhone Safari can buffer Firestore's default live-update stream, so
  // changes made elsewhere (e.g. resuming the timer on the laptop) arrive in
  // delayed batches — we saw up to ~50s. Long polling delivers each update
  // promptly. Must be set before Firestore is used for anything else.
  db.settings({ experimentalForceLongPolling: true });

  // ---------- data model ----------
  // users/{uid}/activities/{activityId}   - real subcollection, one doc per activity
  // users/{uid}/timeEntries/{entryId}     - real subcollection, one doc per logged entry
  // users/{uid}/meta/activeTimer          - singleton doc (absent = no timer running)
  // users/{uid}/meta/settings             - singleton doc
  //
  // activeTimer/settings are modeled as two fixed-id docs inside a "meta"
  // subcollection rather than fields on users/{uid} itself, since
  // users/{uid} is a document and Firestore paths must alternate
  // collection/document — this keeps them at a stable, individually
  // gettable/settable location while staying under users/{uid}/**, which
  // the existing security rule already covers.

  // Activities no longer have goals of their own — an activity is just a name
  // you track time against (goals are a separate concept, assigned activities).
  // Older activity docs may still carry cadence, goalMinutes, scheduleRule and
  // minSessionMinutes fields from earlier versions. Nothing reads or writes
  // them anymore; they're left in Firestore untouched until the user decides
  // whether to clean them up.
  const SEED_ACTIVITIES = [
    'Video ideas & notes', 'Video recording & editing', 'Newsletter', 'ASMR Healing',
    'Story', 'Household needs', 'Learning', 'Budget', 'Budget Review',
  ];

  function activitiesCol(uid){ return db.collection('users').doc(uid).collection('activities'); }
  function timeEntriesCol(uid){ return db.collection('users').doc(uid).collection('timeEntries'); }
  function metaDoc(uid, id){ return db.collection('users').doc(uid).collection('meta').doc(id); }

  // Idempotent: only seeds if the activities subcollection is empty, so this
  // is safe to call every sign-in without duplicating rows or clobbering
  // edits made later.
  async function seedActivitiesIfEmpty(uid){
    const snap = await activitiesCol(uid).limit(1).get();
    if(!snap.empty) return;
    const batch = db.batch();
    SEED_ACTIVITIES.forEach((name, idx) => {
      const ref = activitiesCol(uid).doc();
      batch.set(ref, {
        name,
        sortOrder: idx,
        active: true,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
  }

  // Safety net for any activity doc that somehow lacks a sortOrder: gives
  // them one (alphabetical) so the shared drag order always has a value.
  // No-ops once every activity has a real sortOrder.
  async function backfillSortOrderIfNeeded(uid, docs){
    if(!docs.some(d => typeof d.sortOrder !== 'number')) return;
    const ordered = [...docs].sort((a, b) => a.name.localeCompare(b.name));
    const batch = db.batch();
    ordered.forEach((d, idx) => batch.update(activitiesCol(uid).doc(d.id), { sortOrder: idx }));
    await batch.commit();
  }

  // Ensures the settings singleton exists with sensible defaults; leaves it
  // alone if already present.
  async function ensureSettingsDoc(uid){
    const ref = metaDoc(uid, 'settings');
    const snap = await ref.get();
    if(!snap.exists){
      await ref.set({ notificationsEnabled: false, notificationTime: '07:00' });
    }
  }

  function showConnectionError(msg){
    const el = document.getElementById('connectionError');
    if(msg){ el.textContent = msg; el.hidden = false; }
    else { el.hidden = true; el.textContent = ''; }
  }

  // The one display format for durations: "45 min", "1 hr 30 min", "4 hr".
  // Whole minutes only; exact hours omit the "0 min". (Live stopwatch-style
  // readouts like the running timer stay H:MM:SS — those are clocks, not
  // durations.)
  function fmtDuration(totalMinutes){
    const mins = Math.max(0, Math.round(totalMinutes));
    if(mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
  }

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Local-timezone YYYY-MM-DD (avoids the UTC-shift bugs that
  // toISOString() has for anyone not at UTC+0).
  function dateToStr(d){
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }
  function todayDateStr(){ return dateToStr(new Date()); }
  // Appending T00:00:00 forces the date string to parse in local time
  // instead of UTC, so the weekday matches the calendar date the user picked.
  function weekdayFromDateStr(dateStr){
    return WEEKDAYS[new Date(dateStr + 'T00:00:00').getDay()];
  }
  function mondayOfDateStr(dateStr){
    const d = new Date(dateStr + 'T00:00:00');
    const dowMonBased = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dowMonBased);
    return d;
  }
  function nowTimeStr(){
    const d = new Date();
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }
  function fmt12h(hhmm){
    const [h, m] = hhmm.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
  }
  function msToDateStr(ms){ return dateToStr(new Date(ms)); }
  function msToHHMM(ms){
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }
  // Combines the calendar date of baseMs with a "HH:MM" time-of-day —
  // used to turn an edited end-time input back into a real timestamp.
  function combineDateWithTime(baseMs, hhmm){
    const base = new Date(baseMs);
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, 0, 0).getTime();
  }
  function fmtElapsed(ms){
    const totalSec = Math.max(0, Math.floor(ms/1000));
    const h = Math.floor(totalSec/3600);
    const m = Math.floor((totalSec%3600)/60);
    const s = totalSec%60;
    if(h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }
  // Always H:MM:SS — the big timer readout (0:00:06, 1:23:45).
  function fmtHMS(ms){
    const totalSec = Math.max(0, Math.floor(ms/1000));
    const h = Math.floor(totalSec/3600);
    const m = Math.floor((totalSec%3600)/60);
    const s = totalSec%60;
    return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  // ---------- home header + period boundaries ----------
  // Weekly = Monday-Sunday, monthly = calendar month, per the spec. Computed
  // fresh on each sign-in so a day/week/month rollover is picked up on
  // reload even if the tab was left open across the boundary.
  function computePeriodBounds(){
    const now = new Date();
    const dowMonBased = (now.getDay() + 6) % 7; // 0=Mon ... 6=Sun
    const monday = new Date(now); monday.setDate(now.getDate() - dowMonBased);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    return {
      today: dateToStr(now),
      weekStart: dateToStr(monday),
      weekEnd: dateToStr(sunday),
      daysLeftInWeek: 7 - dowMonBased,
    };
  }
  let periodBounds = computePeriodBounds();

  function renderHomeHeader(){
    const now = new Date();
    document.getElementById('homeDate').textContent =
      `${WEEKDAYS[now.getDay()]}, ${MONTHS_SHORT[now.getMonth()]} ${now.getDate()}`;
    const b = periodBounds;
    const weekWord = b.daysLeftInWeek === 1 ? 'day' : 'days';
    document.getElementById('homeRemaining').textContent =
      `${b.daysLeftInWeek} ${weekWord} left this week`;
  }

  // periodBounds is a snapshot of "now" taken when listeners start (sign-in
  // or reload). Without this check, a tab left open across a day/week
  // boundary would keep showing the old week's numbers indefinitely —
  // Home and History are both computed from periodBounds, not from a
  // separate "finalize the week" write, so refreshing it is what makes a
  // rollover actually visible.
  let periodRolloverIntervalHandle = null;
  function checkForPeriodRollover(){
    if(!currentUid) return;
    const fresh = computePeriodBounds();
    if(fresh.today === periodBounds.today) return; // still the same day
    periodBounds = fresh;
    renderHomeHeader();
    renderHomeActivities(); renderHomeGoals();
    renderHomePlan(); // the rolling day list shifts/refills as the day changes
    if(currentPage === 'history') renderHistoryPage();
  }
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) checkForPeriodRollover(); });

  // Time tracked on an activity this week (Monday–Sunday, local time).
  function loggedMinutesThisWeek(activityId){
    const b = periodBounds;
    return periodEntries
      .filter(e => e.activityId === activityId && e.date >= b.weekStart && e.date <= b.weekEnd)
      .reduce((sum, e) => sum + e.durationMinutes, 0);
  }

  // ---------- week schedule rules ----------
  // Retired from activities (they no longer have goals or schedules); kept
  // here because a goal can optionally use a rule, e.g. "only the first full
  // week of the month". Add new rule types as new `case`s in
  // weekMatchesScheduleRule.
  function firstFullWeekMondayOfMonth(year, monthIndex){
    const firstOfMonth = new Date(year, monthIndex, 1);
    const dowMonBased = (firstOfMonth.getDay() + 6) % 7; // 0=Mon ... 6=Sun
    const daysUntilMonday = dowMonBased === 0 ? 0 : 7 - dowMonBased;
    return new Date(year, monthIndex, 1 + daysUntilMonday);
  }

  function weekMatchesScheduleRule(rule, weekStartDate){
    if(!rule) return true;
    switch(rule.type){
      case 'firstFullWeekOfMonth': {
        const target = firstFullWeekMondayOfMonth(weekStartDate.getFullYear(), weekStartDate.getMonth());
        return dateToStr(weekStartDate) === dateToStr(target);
      }
      default:
        return true; // unrecognized rule types stay active rather than silently vanishing
    }
  }

  // ---------- shared activity state ----------
  let currentUid = null;
  let activities = [];        // kept in sync via onSnapshot
  let unsubscribeActivities = null;

  // User-controlled order (drag-reordered on the home screen), shared across
  // Home/Activities/History so position stays consistent everywhere.
  function sortedActivities(){
    return [...activities].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }

  function activityName(activityId){
    const a = activities.find(x => x.id === activityId);
    return a ? a.name : '(deleted activity)';
  }

  function populateActivitySelect(sel){
    const prevValue = sel.value;
    sel.innerHTML = activities.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
    if(activities.some(a => a.id === prevValue)) sel.value = prevValue;
  }

  // ---------- PAGE: HOME ----------
  // Read-only "this week's plan": the active (default) schedule's remaining
  // days, today first. As the day advances the list shrinks toward Sunday;
  // once a new week starts it's back to all 7 days, using whichever
  // schedule is currently the default (usually the same one, unchanged).
  function renderHomePlan(){
    const titleEl = document.getElementById('homePlanTitle');
    const daysEl = document.getElementById('homePlanDays');
    const schedule = schedules.find(s => s.id === currentSettings.defaultScheduleId);
    if(!schedule){
      titleEl.textContent = "This week's plan";
      daysEl.innerHTML = '<div class="empty-note">No default schedule set — pick one in Planner.</div>';
      return;
    }
    titleEl.textContent = `This week's plan · ${schedule.name}`;
    const dowMonBased = (new Date().getDay() + 6) % 7; // 0=Mon ... 6=Sun
    const remainingDays = DAY_KEYS.slice(dowMonBased);
    daysEl.innerHTML = remainingDays.map((day, i) => {
      const isToday = i === 0;
      const parts = DAYPART_KEYS
        .map(part => ({ part, items: (schedule.days && schedule.days[day] && schedule.days[day][part]) || [] }))
        .filter(p => p.items.length);
      const partsHtml = parts.length
        ? parts.map(p => `<div class="home-plan-part"><span class="home-plan-part-label">${DAYPART_LABELS[p.part]}:</span> ${p.items.map(it => `${escapeHtml(activityName(it.activityId))} ${fmtDuration(it.minutes)}`).join(', ')}</div>`).join('')
        : '<div class="home-plan-part empty">Nothing planned</div>';
      return `
        <div class="home-plan-day">
          <div class="home-plan-day-title">${DAY_LABELS[day]}${isToday ? '<span class="home-plan-today-tag">Today</span>' : ''}</div>
          ${partsHtml}
        </div>
      `;
    }).join('');
  }

  // Deliberately minimal per row: name, progress, a Timer button, and a
  // drag handle for reordering. No cadence tag, no edit/delete — those
  // live on the Activities page.
  let homeSortable = null;

  function renderHomeActivities(){
    const list = document.getElementById('homeActivityList');
    list.innerHTML = '';
    // Every activity, every week: name, time tracked this week, Timer button.
    sortedActivities().forEach(a => {
      const logged = loggedMinutesThisWeek(a.id);
      const li = document.createElement('li');
      li.className = 'activity-item home-activity-item';
      li.dataset.id = a.id;
      li.innerHTML = `
        <div class="activity-item-top">
          <div>
            <div class="name">${escapeHtml(a.name)}</div>
            <div class="meta">${fmtDuration(logged)} this week</div>
          </div>
          <div class="home-row-right">
            <button class="btn-pill-icon timer-row-btn" data-id="${a.id}" type="button"${activeTimer ? ' disabled' : ''}>▶ Timer</button>
            <div class="drag-handle" title="Drag to reorder">⠿</div>
          </div>
        </div>
      `;
      list.appendChild(li);
    });
    initHomeDragSort();
  }

  // Drag is confined to the handle (not the whole row) so it doesn't fight
  // the Timer button's tap or normal page scrolling. Re-created after every
  // render since rebuilding the list's innerHTML tears down the old DOM
  // nodes Sortable was attached to.
  function initHomeDragSort(){
    if(homeSortable){ homeSortable.destroy(); homeSortable = null; }
    const list = document.getElementById('homeActivityList');
    if(typeof Sortable === 'undefined' || !list.children.length) return;
    homeSortable = new Sortable(list, {
      handle: '.drag-handle',
      animation: 150,
      onEnd: async ()=>{
        if(!currentUid) return;
        const ids = [...list.children].map(li => li.dataset.id);
        const batch = db.batch();
        ids.forEach((id, idx) => batch.update(activitiesCol(currentUid).doc(id), { sortOrder: idx }));
        try{ await batch.commit(); }
        catch(err){ console.error('save reorder failed', err); alert('Could not save the new order — see console.'); }
      },
    });
  }

  async function onTimerButtonClick(e){
    const btn = e.target.closest('.timer-row-btn');
    if(!btn || btn.disabled || !currentUid || activeTimer) return;
    try{
      await metaDoc(currentUid, 'activeTimer').set(newTimerDoc(btn.dataset.id));
    }catch(err){
      console.error('start timer failed', err);
      alert('Could not start timer — see console.');
    }
  }
  document.getElementById('homeActivityList').addEventListener('click', onTimerButtonClick);
  document.getElementById('homeGoals').addEventListener('click', onTimerButtonClick);

  // ---------- PAGE: ACTIVITIES (management — shows every activity,
  // regardless of this week's scheduled visibility) ----------
  function renderActivitiesPage(){
    const list = document.getElementById('activityList');
    list.innerHTML = '';
    sortedActivities().forEach(a => {
      const li = document.createElement('li');
      li.className = 'activity-item';
      li.innerHTML = `
        <div class="activity-item-top">
          <div>
            <div class="name">${escapeHtml(a.name)}</div>
          </div>
          <div class="item-right">
            <div class="item-actions">
              <button class="icon-btn edit-btn" data-id="${a.id}" title="Edit" type="button">✎</button>
              <button class="icon-btn danger delete-btn" data-id="${a.id}" title="Delete" type="button">✕</button>
            </div>
          </div>
        </div>
      `;
      list.appendChild(li);
    });
  }

  document.getElementById('activityList').addEventListener('click', (e)=>{
    const editBtn = e.target.closest('.edit-btn');
    const delBtn = e.target.closest('.delete-btn');
    if(editBtn){
      const a = activities.find(x => x.id === editBtn.dataset.id);
      if(a) openActivityForm(a);
    } else if(delBtn){
      const a = activities.find(x => x.id === delBtn.dataset.id);
      if(a) deleteActivity(a);
    }
  });

  function startActivitiesListener(uid){
    if(unsubscribeActivities) unsubscribeActivities();
    unsubscribeActivities = activitiesCol(uid).orderBy('createdAt').onSnapshot(
      snap => {
        activities = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderHomeActivities(); renderHomeGoals();
        renderActivitiesPage();
        renderGoalsPage();
        populateActivitySelect(document.getElementById('logActivityId'));
        renderTimerBanner(); // activity names/goal may have changed
        if(currentPage === 'history') renderHistoryPage();
        backfillSortOrderIfNeeded(uid, activities).catch(err => console.error('sortOrder backfill failed', err));
      },
      err => {
        console.error('activities listener failed', err);
        showConnectionError('Firestore connection failed — see console.');
      }
    );
  }

  // ---------- activity add/edit form ----------
  const formEl = document.getElementById('activityForm');
  const formIdEl = document.getElementById('formActivityId');
  const formNameEl = document.getElementById('formName');
  const formErrorEl = document.getElementById('formError');

  function setFormError(msg){
    if(msg){ formErrorEl.textContent = msg; formErrorEl.hidden = false; }
    else { formErrorEl.hidden = true; formErrorEl.textContent = ''; }
  }

  function openActivityForm(activity){
    setFormError(null);
    if(activity){
      formIdEl.value = activity.id;
      formNameEl.value = activity.name;
    } else {
      formIdEl.value = '';
      formNameEl.value = '';
    }
    formEl.hidden = false;
    formNameEl.focus();
  }

  function closeActivityForm(){
    formEl.hidden = true;
    setFormError(null);
  }

  document.getElementById('addActivityBtn').addEventListener('click', ()=> openActivityForm(null));
  document.getElementById('formCancelBtn').addEventListener('click', closeActivityForm);

  formEl.addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!currentUid) return;
    const name = formNameEl.value.trim();
    if(!name){ setFormError('Name is required.'); return; }

    const id = formIdEl.value;
    const saveBtn = document.getElementById('formSaveBtn');
    saveBtn.disabled = true;
    try{
      if(id){
        // Only the name changes; any old goal/cadence fields on the doc are left alone.
        await activitiesCol(currentUid).doc(id).update({ name });
      } else {
        await activitiesCol(currentUid).add({
          name, active: true, sortOrder: Date.now(),
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }
      closeActivityForm();
    }catch(err){
      console.error('save activity failed', err);
      setFormError('Save failed — see console.');
    }finally{
      saveBtn.disabled = false;
    }
  });

  async function deleteActivity(activity){
    const ok = confirm(`Delete "${activity.name}"? This can't be undone.`);
    if(!ok) return;
    try{
      await activitiesCol(currentUid).doc(activity.id).delete();
    }catch(err){
      console.error('delete activity failed', err);
      alert('Delete failed — see console.');
    }
  }

  // ---------- GOALS ----------
  // users/{uid}/goals/{goalId}:
  //   { name, type: 'daily'|'weekly', targetMinutes, workingDays: [dayKey,...],
  //     activityIds: [...], sortOrder, createdAt }
  // Daily goal: targetMinutes is per working day; the weekly target is derived
  // (daily x number of working days) and never stored. Weekly goal:
  // targetMinutes is the weekly total and workingDays is unused. Results are
  // always computed from time entries, never stored, so past weeks recalc if
  // entries or goals change.
  function goalsCol(uid){ return db.collection('users').doc(uid).collection('goals'); }

  let goals = [];
  let unsubscribeGoals = null;
  let vacations = [];
  let unsubscribeVacations = null;

  function sortedGoals(){
    return [...goals].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }

  const DAY_SHORT = { monday:'Mon', tuesday:'Tue', wednesday:'Wed', thursday:'Thu', friday:'Fri', saturday:'Sat', sunday:'Sun' };

  function goalWorkingDays(goal){
    return DAY_KEYS.filter(d => (goal.workingDays || []).includes(d));
  }
  function goalWeeklyTargetMinutes(goal){
    return goal.type === 'daily' ? goal.targetMinutes * goalWorkingDays(goal).length : goal.targetMinutes;
  }

  // "Every day", "Mon–Fri", "Mon, Wed, Fri".
  function fmtWorkingDays(days){
    if(days.length === 7) return 'Every day';
    const idx = days.map(d => DAY_KEYS.indexOf(d));
    const consecutive = idx.length > 2 && idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
    if(consecutive) return `${DAY_SHORT[days[0]]}–${DAY_SHORT[days[days.length - 1]]}`;
    return days.map(d => DAY_SHORT[d]).join(', ');
  }

  function goalSummary(goal){
    if(goal.type === 'daily'){
      const days = goalWorkingDays(goal);
      return `${fmtDuration(goal.targetMinutes)}/day · ${fmtWorkingDays(days)} · ${fmtDuration(goalWeeklyTargetMinutes(goal))}/week`;
    }
    return `${fmtDuration(goal.targetMinutes)}/week`;
  }

  // Scores one goal for one Monday–Sunday week. weekMondayStr is the week's
  // Monday as YYYY-MM-DD. Each day's time comes from entries whose `date` is
  // that day (a timed entry is dated the day it started). The weekly total
  // counts every day Mon–Sun, working or not, vacation or not; daily hit/miss
  // is only judged on scored days (working days not on vacation). Extra time
  // on one day never carries over to another.
  //
  // Vacation (see `vacations`): a day is on vacation for this goal if a
  // vacation covering that date lists the goal.
  //  - daily goal: vacation working days aren't scored and drop out of the
  //    weekly target (daily target x scored days). No scored days left = the
  //    week is skipped.
  //  - weekly goal: skipped only when all 7 days are covered. Otherwise the
  //    target is unchanged, unless a covering vacation has scalePartialWeeks,
  //    in which case it shrinks by (days off / 7).
  function scoreGoalForWeek(goal, weekMondayStr, entries, vacs = vacations){
    const monday = new Date(weekMondayStr + 'T00:00:00');
    const ids = new Set(goal.activityIds || []);
    const working = new Set(goalWorkingDays(goal));
    const days = DAY_KEYS.map((dayKey, i) => {
      const d = new Date(monday); d.setDate(monday.getDate() + i);
      const date = dateToStr(d);
      const minutes = entries
        .filter(e => e.date === date && ids.has(e.activityId))
        .reduce((sum, e) => sum + e.durationMinutes, 0);
      const covering = vacs.filter(v => (v.goalIds || []).includes(goal.id) && date >= v.startDate && date <= v.endDate);
      const onVacation = covering.length > 0;
      const scaledOff = covering.some(v => v.scalePartialWeeks);
      const isWorking = goal.type === 'daily' && working.has(dayKey);
      const scored = isWorking && !onVacation;
      return { dayKey, date, minutes, isWorking, onVacation, scaledOff, scored, hit: scored ? minutes >= goal.targetMinutes : null };
    });
    const weeklyMinutes = days.reduce((sum, d) => sum + d.minutes, 0);
    const scoredDays = days.filter(d => d.scored);
    let weeklyTarget, skipped;
    if(goal.type === 'daily'){
      weeklyTarget = goal.targetMinutes * scoredDays.length;
      skipped = scoredDays.length === 0;
    } else {
      skipped = days.every(d => d.onVacation);
      const scaledOffDays = days.filter(d => d.scaledOff).length;
      weeklyTarget = skipped ? 0 : Math.round(goal.targetMinutes * (7 - scaledOffDays) / 7);
    }
    return {
      days, weeklyMinutes, weeklyTarget, skipped,
      weeklyHit: skipped ? null : weeklyMinutes >= weeklyTarget,
      workingDayCount: scoredDays.length,
      daysHit: scoredDays.filter(d => d.hit).length,
    };
  }

  // ---------- HOME: goals + this week's results ----------
  // Compact duration for the 7-day strip only ("4h 5m", "35m", "4h"); every
  // other place uses fmtDuration's "4 hr 5 min".
  function fmtDurationShort(totalMinutes){
    const mins = Math.max(0, Math.round(totalMinutes));
    if(mins === 0) return '–';
    const h = Math.floor(mins / 60), m = mins % 60;
    if(h === 0) return `${m}m`;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }

  // One progress row: label, "done / target", left/reached status, bar.
  // Bar: sage while in progress, white once full, blue only at double the target.
  function goalProgressHtml(label, minutes, target){
    const reached = minutes >= target;
    const over = minutes - target;
    const status = !reached
      ? `${fmtDuration(target - minutes)} left`
      : `Goal reached ✓${over > 0 ? ` · ${fmtDuration(over)} over` : ''}`;
    const pct = Math.min(100, (minutes / target) * 100);
    const cls = minutes >= target * 2 ? ' is-over' : (reached ? ' is-full' : '');
    return `
      <div class="goal-progress">
        <div class="goal-progress-line">
          <span class="goal-progress-label">${label}</span>
          <span class="goal-progress-amount">${fmtDuration(minutes)} / ${fmtDuration(target)}</span>
        </div>
        <div class="goal-progress-status${reached ? ' is-reached' : ''}">${status}</div>
        <div class="progress-track"><div class="progress-fill${cls}" style="width:${pct}%"></div></div>
      </div>`;
  }

  // "Wed–Fri, Sun" from a list of day keys (Mon-first order).
  function fmtDayRanges(keys){
    const idx = DAY_KEYS.map((d, i) => keys.includes(d) ? i : -1).filter(i => i >= 0);
    const runs = [];
    idx.forEach(i => {
      const last = runs[runs.length - 1];
      if(last && last[1] === i - 1) last[1] = i; else runs.push([i, i]);
    });
    return runs.map(([a, b]) => a === b ? DAY_SHORT[DAY_KEYS[a]] : `${DAY_SHORT[DAY_KEYS[a]]}–${DAY_SHORT[DAY_KEYS[b]]}`).join(', ');
  }

  // Small line under a goal's result when any day this week is on vacation.
  function vacationNoteHtml(g, r){
    const off = r.days.filter(d => d.onVacation).map(d => d.dayKey);
    if(!off.length) return '';
    let text = off.length === 7 ? 'Vacation all week' : `Vacation: ${fmtDayRanges(off)}`;
    if(g.type !== 'daily' && !r.skipped && r.weeklyTarget !== g.targetMinutes){
      text += ` · target reduced to ${fmtDuration(r.weeklyTarget)}`;
    }
    return `<div class="goal-vacation-note">🌴 ${text}</div>`;
  }

  function renderHomeGoals(){
    const box = document.getElementById('homeGoals');
    const resultsBox = document.getElementById('homeGoalResults');
    if(!box || !resultsBox) return;
    const list = sortedGoals();
    renderDayOffMenu();
    if(!list.length){
      box.innerHTML = '<div class="empty-note">No goals yet — add one on the Goals page.</div>';
      resultsBox.innerHTML = '';
      return;
    }
    const today = periodBounds.today;
    const scored = list.map(g => ({ g, r: scoreGoalForWeek(g, periodBounds.weekStart, periodEntries) }));

    box.innerHTML = scored.map(({ g, r }) => {
      const textRow = (label, text) => `<div class="goal-progress"><div class="goal-progress-line"><span class="goal-progress-label">${label}</span><span class="goal-progress-amount">${text}</span></div></div>`;
      const weekRow = r.skipped ? textRow('This week', 'Vacation') : goalProgressHtml('This week', r.weeklyMinutes, r.weeklyTarget);
      let progress;
      if(g.type === 'daily'){
        const t = r.days.find(d => d.date === today);
        if(!t || !t.isWorking) progress = textRow('Today', 'Not a working day');
        else if(t.onVacation) progress = textRow('Today', 'Vacation');
        else progress = goalProgressHtml('Today', t.minutes, g.targetMinutes);
        progress += weekRow;
      } else {
        progress = weekRow;
      }
      const acts = (g.activityIds || []).map(id => activities.find(a => a.id === id)).filter(Boolean);
      const actsHtml = acts.map(a => `
        <div class="goal-activity-row">
          <span class="goal-activity-name">${escapeHtml(a.name)}</span>
          <button class="btn-pill-icon timer-row-btn" data-id="${a.id}" type="button"${activeTimer ? ' disabled' : ''}>▶ Timer</button>
        </div>`).join('');
      return `<div class="goal-card"><div class="goal-card-name">${escapeHtml(g.name)}</div>${progress}<div class="goal-activity-list">${actsHtml}</div></div>`;
    }).join('');

    // Results: daily goals get a Mon–Sun strip; each weekly goal is one line.
    resultsBox.innerHTML = scored.map(({ g, r }) => {
      const totalCls = r.weeklyHit ? ' is-reached' : '';
      if(g.type !== 'daily'){
        const right = r.skipped ? 'Vacation' : `${fmtDuration(r.weeklyMinutes)} / ${fmtDuration(r.weeklyTarget)}${r.weeklyHit ? ' ✓' : ''}`;
        return `<div class="goal-result-line"><span>${escapeHtml(g.name)}</span><span class="goal-result-total${totalCls}">${right}</span>${vacationNoteHtml(g, r)}</div>`;
      }
      const cells = r.days.map(d => {
        let icon, cls;
        if(!d.isWorking){ icon = 'off'; cls = 'is-off'; }
        else if(d.onVacation){ icon = 'Vacation'; cls = 'is-vacation'; }
        else if(d.hit){ icon = '✓'; cls = 'is-hit'; }
        else if(d.date < today){ icon = '✗'; cls = 'is-miss'; }
        else if(d.date === today){ icon = '●'; cls = 'is-pending'; }
        else { icon = '·'; cls = 'is-future'; }
        return `<div class="strip-cell ${cls}${d.date === today ? ' is-today' : ''}">
          <div class="strip-day">${DAY_SHORT[d.dayKey]}</div>
          <div class="strip-icon">${icon}</div>
          <div class="strip-time">${fmtDurationShort(d.minutes)}</div>
        </div>`;
      }).join('');
      return `
        <div class="goal-result">
          <div class="goal-result-line">
            <span>${escapeHtml(g.name)} · ${r.skipped ? 'Vacation this week' : `${r.daysHit} of ${r.workingDayCount} days`}</span>
            <span class="goal-result-total${totalCls}">${r.skipped ? fmtDuration(r.weeklyMinutes) : `${fmtDuration(r.weeklyMinutes)} / ${fmtDuration(r.weeklyTarget)}`}</span>
          </div>
          <div class="day-strip">${cells}</div>
          ${vacationNoteHtml(g, r)}
        </div>`;
    }).join('');
  }

  function renderGoalsPage(){
    const list = document.getElementById('goalList');
    list.innerHTML = '';
    document.getElementById('goalsEmpty').hidden = goals.length > 0;
    sortedGoals().forEach(g => {
      const names = (g.activityIds || []).map(id => activities.find(a => a.id === id)).filter(Boolean).map(a => a.name);
      const li = document.createElement('li');
      li.className = 'activity-item';
      li.innerHTML = `
        <div class="activity-item-top">
          <div>
            <div class="name">${escapeHtml(g.name)}</div>
            <div class="goal-summary">${escapeHtml(goalSummary(g))}</div>
            <div class="goal-activities">${names.length ? escapeHtml(names.join(', ')) : 'No activities assigned'}</div>
          </div>
          <div class="item-right">
            <div class="item-actions">
              <button class="icon-btn edit-btn" data-id="${g.id}" title="Edit" type="button">✎</button>
              <button class="icon-btn danger delete-btn" data-id="${g.id}" title="Delete" type="button">✕</button>
            </div>
          </div>
        </div>
      `;
      list.appendChild(li);
    });
  }

  function startGoalsListener(uid){
    if(unsubscribeGoals) unsubscribeGoals();
    unsubscribeGoals = goalsCol(uid).orderBy('createdAt').onSnapshot(
      snap => {
        goals = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderGoalsPage();
        renderHomeGoals();
        renderVacationList();
      },
      err => {
        console.error('goals listener failed', err);
        showConnectionError('Firestore connection failed — see console.');
      }
    );
  }

  // ---------- goal add/edit form ----------
  const goalFormEl = document.getElementById('goalForm');
  const goalErrorEl = document.getElementById('goalFormError');
  let goalFormType = 'daily';

  function setGoalFormError(msg){
    if(msg){ goalErrorEl.textContent = msg; goalErrorEl.hidden = false; }
    else { goalErrorEl.hidden = true; goalErrorEl.textContent = ''; }
  }

  function goalFormTargetMinutes(){
    const h = parseInt(document.getElementById('goalHours').value, 10) || 0;
    const m = parseInt(document.getElementById('goalMinutes').value, 10) || 0;
    return h * 60 + m;
  }
  function goalFormSelectedDays(){
    return DAY_KEYS.filter(d => document.querySelector(`#goalDayChips input[value="${d}"]`).checked);
  }

  // The "4 hr × 6 days = 24 hr per week" line under the working days.
  function updateGoalWeekTotal(){
    const el = document.getElementById('goalWeekTotal');
    const mins = goalFormTargetMinutes();
    const n = goalFormSelectedDays().length;
    if(goalFormType !== 'daily' || mins <= 0 || n === 0){ el.textContent = ''; return; }
    el.textContent = `${fmtDuration(mins)} × ${n} ${n === 1 ? 'day' : 'days'} = ${fmtDuration(mins * n)} per week`;
  }

  function setGoalFormType(type){
    goalFormType = type;
    document.getElementById('goalTypeDailyBtn').classList.toggle('is-active', type === 'daily');
    document.getElementById('goalTypeWeeklyBtn').classList.toggle('is-active', type === 'weekly');
    document.getElementById('goalTargetLabel').textContent = type === 'daily' ? 'Daily target' : 'Weekly target';
    document.getElementById('goalDaysField').hidden = type !== 'daily';
    updateGoalWeekTotal();
  }

  function openGoalForm(goal){
    setGoalFormError(null);
    document.getElementById('goalFormId').value = goal ? goal.id : '';
    document.getElementById('goalName').value = goal ? goal.name : '';
    const mins = goal ? goal.targetMinutes : 0;
    document.getElementById('goalHours').value = mins ? Math.floor(mins / 60) : '';
    document.getElementById('goalMinutes').value = mins % 60 ? mins % 60 : '';
    // New daily goals start on Mon–Fri; change as needed.
    const days = goal ? goalWorkingDays(goal) : ['monday','tuesday','wednesday','thursday','friday'];
    document.getElementById('goalDayChips').innerHTML = DAY_KEYS.map(d => `
      <label class="day-chip"><input type="checkbox" value="${d}" ${days.includes(d) ? 'checked' : ''}><span>${DAY_SHORT[d]}</span></label>`).join('');
    const picked = new Set(goal ? goal.activityIds || [] : []);
    document.getElementById('goalActivityChecks').innerHTML = sortedActivities().map(a => `
      <label class="check-row"><input type="checkbox" value="${a.id}" ${picked.has(a.id) ? 'checked' : ''}><span>${escapeHtml(a.name)}</span></label>`).join('');
    setGoalFormType(goal ? goal.type : 'daily');
    goalFormEl.hidden = false;
    document.getElementById('goalName').focus();
  }

  function closeGoalForm(){
    goalFormEl.hidden = true;
    setGoalFormError(null);
  }

  document.getElementById('addGoalBtn').addEventListener('click', ()=> openGoalForm(null));
  document.getElementById('goalCancelBtn').addEventListener('click', closeGoalForm);
  document.getElementById('goalTypeDailyBtn').addEventListener('click', ()=> setGoalFormType('daily'));
  document.getElementById('goalTypeWeeklyBtn').addEventListener('click', ()=> setGoalFormType('weekly'));
  document.getElementById('goalHours').addEventListener('input', updateGoalWeekTotal);
  document.getElementById('goalMinutes').addEventListener('input', updateGoalWeekTotal);
  document.getElementById('goalDayChips').addEventListener('change', updateGoalWeekTotal);

  goalFormEl.addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!currentUid) return;
    const name = document.getElementById('goalName').value.trim();
    const targetMinutes = goalFormTargetMinutes();
    const workingDays = goalFormSelectedDays();
    const activityIds = [...document.querySelectorAll('#goalActivityChecks input:checked')].map(i => i.value);
    if(!name){ setGoalFormError('Name is required.'); return; }
    if(targetMinutes <= 0){ setGoalFormError('Enter a target greater than zero.'); return; }
    if(goalFormType === 'daily' && workingDays.length === 0){ setGoalFormError('Choose at least one working day.'); return; }
    if(activityIds.length === 0){ setGoalFormError('Choose at least one activity.'); return; }

    const fields = {
      name, type: goalFormType, targetMinutes, activityIds,
      workingDays: goalFormType === 'daily' ? workingDays : [],
    };
    const id = document.getElementById('goalFormId').value;
    const saveBtn = document.getElementById('goalSaveBtn');
    saveBtn.disabled = true;
    try{
      if(id){
        await goalsCol(currentUid).doc(id).update(fields);
      } else {
        await goalsCol(currentUid).add({
          ...fields, sortOrder: Date.now(),
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }
      closeGoalForm();
    }catch(err){
      console.error('save goal failed', err);
      setGoalFormError('Save failed — see console.');
    }finally{
      saveBtn.disabled = false;
    }
  });

  document.getElementById('goalList').addEventListener('click', (e)=>{
    const editBtn = e.target.closest('.edit-btn');
    const delBtn = e.target.closest('.delete-btn');
    const g = goals.find(x => x.id === (editBtn || delBtn || {dataset:{}}).dataset.id);
    if(!g) return;
    if(editBtn) openGoalForm(g);
    else deleteGoal(g);
  });

  // Deleting a goal removes only the goal; activities and logged time are untouched.
  async function deleteGoal(goal){
    const ok = confirm(`Delete the goal "${goal.name}"? Your activities and logged time are not affected.`);
    if(!ok) return;
    try{
      await goalsCol(currentUid).doc(goal.id).delete();
    }catch(err){
      console.error('delete goal failed', err);
      alert('Delete failed — see console.');
    }
  }

  // ---------- VACATIONS ----------
  // users/{uid}/vacations/{id}:
  //   { startDate, endDate (YYYY-MM-DD, inclusive), goalIds: [...],
  //     scalePartialWeeks: bool, createdAt }
  // The goal list is explicit: a goal created later is NOT on an existing
  // vacation until you edit that vacation and tick it. scoreGoalForWeek reads
  // these; nothing about a vacation is ever written into entries or goals.
  function vacationsCol(uid){ return db.collection('users').doc(uid).collection('vacations'); }

  function fmtVacationDate(dateStr, withYear){
    const d = new Date(dateStr + 'T00:00:00');
    return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}${withYear ? `, ${d.getFullYear()}` : ''}`;
  }
  function fmtVacationRange(v){
    const thisYear = new Date().getFullYear();
    const sameYear = v.startDate.slice(0, 4) === v.endDate.slice(0, 4);
    const showYear = v.startDate.slice(0, 4) !== String(thisYear) || v.endDate.slice(0, 4) !== String(thisYear);
    if(v.startDate === v.endDate){
      const d = new Date(v.startDate + 'T00:00:00');
      return `${DAY_SHORT[DAY_KEYS[(d.getDay() + 6) % 7]]}, ${fmtVacationDate(v.startDate, showYear)}`;
    }
    return `${fmtVacationDate(v.startDate, showYear && !sameYear)} – ${fmtVacationDate(v.endDate, showYear)}`;
  }

  function renderVacationList(){
    const box = document.getElementById('vacationList');
    if(!box) return;
    const today = todayDateStr();
    const current = vacations.filter(v => v.endDate >= today).sort((a, b) => a.startDate.localeCompare(b.startDate));
    const past = vacations.filter(v => v.endDate < today).sort((a, b) => b.startDate.localeCompare(a.startDate));
    if(!vacations.length){
      box.innerHTML = '<div class="empty-note">No vacations yet.</div>';
      return;
    }
    const row = v => {
      const live = (v.goalIds || []).map(id => goals.find(g => g.id === id)).filter(Boolean);
      const allGoals = goals.length > 0 && live.length === goals.length;
      const names = !live.length ? 'No goals' : (allGoals ? 'All goals' : live.map(g => g.name).join(', '));
      return `
        <li class="activity-item">
          <div class="activity-item-top">
            <div>
              <div class="name">${escapeHtml(fmtVacationRange(v))}</div>
              <div class="goal-summary">${escapeHtml(names)}${v.scalePartialWeeks ? ' · reduces weekly goals' : ''}</div>
            </div>
            <div class="item-right"><div class="item-actions">
              <button class="icon-btn vac-edit-btn" data-id="${v.id}" title="Edit" type="button">✎</button>
              <button class="icon-btn danger vac-delete-btn" data-id="${v.id}" title="Delete" type="button">✕</button>
            </div></div>
          </div>
        </li>`;
    };
    box.innerHTML =
      (current.length ? `<div class="vac-group-label">Current &amp; upcoming</div><ul class="activity-list">${current.map(row).join('')}</ul>` : '') +
      (past.length ? `<div class="vac-group-label">Past</div><ul class="activity-list">${past.map(row).join('')}</ul>` : '');
  }

  function startVacationsListener(uid){
    if(unsubscribeVacations) unsubscribeVacations();
    unsubscribeVacations = vacationsCol(uid).onSnapshot(
      snap => {
        vacations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderVacationList();
        renderHomeGoals();
        if(activeTimer) tickTimerBanner();
        if(currentPage === 'history') renderHistoryPage();
      },
      err => {
        console.error('vacations listener failed', err);
        showConnectionError('Firestore connection failed — see console.');
      }
    );
  }

  // ---------- vacation add/edit form (Settings) ----------
  const vacationFormEl = document.getElementById('vacationForm');
  const vacationErrorEl = document.getElementById('vacationFormError');

  function setVacationError(msg){
    if(msg){ vacationErrorEl.textContent = msg; vacationErrorEl.hidden = false; }
    else { vacationErrorEl.hidden = true; vacationErrorEl.textContent = ''; }
  }

  function openVacationForm(v){
    setVacationError(null);
    const today = todayDateStr();
    document.getElementById('vacationFormId').value = v ? v.id : '';
    document.getElementById('vacationStart').value = v ? v.startDate : today;
    document.getElementById('vacationEnd').value = v ? v.endDate : today;
    const picked = new Set(v ? v.goalIds || [] : sortedGoals().map(g => g.id));   // new: all checked
    document.getElementById('vacationGoalChecks').innerHTML = sortedGoals().length
      ? sortedGoals().map(g => `<label class="check-row"><input type="checkbox" value="${g.id}" ${picked.has(g.id) ? 'checked' : ''}><span>${escapeHtml(g.name)}</span></label>`).join('')
      : '<div class="empty-note">Add a goal first.</div>';
    document.getElementById('vacationScale').checked = !!(v && v.scalePartialWeeks);
    vacationFormEl.hidden = false;
    vacationFormEl.scrollIntoView({ block: 'nearest' });
  }
  function closeVacationForm(){
    vacationFormEl.hidden = true;
    setVacationError(null);
  }

  document.getElementById('addVacationBtn').addEventListener('click', ()=> openVacationForm(null));
  document.getElementById('vacationCancelBtn').addEventListener('click', closeVacationForm);

  vacationFormEl.addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!currentUid) return;
    const startDate = document.getElementById('vacationStart').value;
    const endDate = document.getElementById('vacationEnd').value;
    const goalIds = [...document.querySelectorAll('#vacationGoalChecks input:checked')].map(i => i.value);
    if(!startDate || !endDate){ setVacationError('Choose a start and end date.'); return; }
    if(endDate < startDate){ setVacationError('The end date can’t be before the start date.'); return; }
    if(goalIds.length === 0){ setVacationError('Choose at least one goal.'); return; }
    const fields = { startDate, endDate, goalIds, scalePartialWeeks: document.getElementById('vacationScale').checked };
    const id = document.getElementById('vacationFormId').value;
    const saveBtn = document.getElementById('vacationSaveBtn');
    saveBtn.disabled = true;
    try{
      if(id) await vacationsCol(currentUid).doc(id).update(fields);
      else await vacationsCol(currentUid).add({ ...fields, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      closeVacationForm();
    }catch(err){
      console.error('save vacation failed', err);
      setVacationError('Save failed — see console.');
    }finally{
      saveBtn.disabled = false;
    }
  });

  document.getElementById('vacationList').addEventListener('click', async (e)=>{
    const editBtn = e.target.closest('.vac-edit-btn');
    const delBtn = e.target.closest('.vac-delete-btn');
    const v = vacations.find(x => x.id === (editBtn || delBtn || { dataset: {} }).dataset.id);
    if(!v) return;
    if(editBtn){ openVacationForm(v); return; }
    if(!confirm(`Delete the vacation ${fmtVacationRange(v)}? Your goals recalculate without it.`)) return;
    try{ await vacationsCol(currentUid).doc(v.id).delete(); }
    catch(err){ console.error('delete vacation failed', err); alert('Delete failed — see console.'); }
  });

  // ---------- quick "Day off" on Home ----------
  let toastTimer = null;
  function showToast(message, actions){
    const el = document.getElementById('toast');
    el.innerHTML = `<span class="toast-msg"></span>`;
    el.querySelector('.toast-msg').textContent = message;
    actions.forEach(a => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = a.label;
      b.addEventListener('click', ()=>{ hideToast(); a.fn(); });
      el.appendChild(b);
    });
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 9000);
  }
  function hideToast(){
    clearTimeout(toastTimer);
    document.getElementById('toast').hidden = true;
  }

  function dayOffDate(offset){
    const d = new Date(); d.setDate(d.getDate() + offset);
    return dateToStr(d);
  }
  // True when every current goal is already on vacation that day.
  function dayFullyOff(date){
    return goals.length > 0 && goals.every(g =>
      vacations.some(v => (v.goalIds || []).includes(g.id) && date >= v.startDate && date <= v.endDate));
  }
  function renderDayOffMenu(){
    const toggle = document.getElementById('dayOffToggle');
    if(!toggle) return;
    toggle.hidden = goals.length === 0;
    if(goals.length === 0) document.getElementById('dayOffMenu').hidden = true;
    [['dayOffToday', 0, 'Today'], ['dayOffYesterday', -1, 'Yesterday']].forEach(([id, offset, label]) => {
      const b = document.getElementById(id);
      const off = dayFullyOff(dayOffDate(offset));
      b.disabled = off;
      b.textContent = off ? `${label} ✓` : label;
    });
  }

  async function markDayOff(offset, label){
    if(!currentUid || !goals.length) return;
    const fields = { startDate: dayOffDate(offset), endDate: dayOffDate(offset), goalIds: goals.map(g => g.id), scalePartialWeeks: false };
    document.getElementById('dayOffMenu').hidden = true;
    try{
      const ref = await vacationsCol(currentUid).add({ ...fields, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      showToast(`${label} marked as a day off for all goals.`, [
        { label: 'Choose goals', fn: ()=>{ navigateTo('settings'); openVacationForm({ id: ref.id, ...fields }); } },
        { label: 'Undo', fn: ()=> ref.delete().catch(err => console.error('undo day off failed', err)) },
      ]);
    }catch(err){
      console.error('day off failed', err);
      alert('Could not save the day off — see console.');
    }
  }

  document.getElementById('dayOffToggle').addEventListener('click', ()=>{
    const menu = document.getElementById('dayOffMenu');
    menu.hidden = !menu.hidden;
  });
  document.getElementById('dayOffToday').addEventListener('click', ()=> markDayOff(0, 'Today'));
  document.getElementById('dayOffYesterday').addEventListener('click', ()=> markDayOff(-1, 'Yesterday'));

  // ---------- PAGE: PLANNER ----------
  // users/{uid}/schedules/{scheduleId}: { name, days, createdAt }
  // days: { monday: {morning:[], afternoon:[], evening:[]}, ... sunday: {...} }
  // Each day-part array holds { activityId, minutes } assignments. Day-part
  // granularity only, per spec — no exact clock times.
  const DAY_KEYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  const DAY_LABELS = { monday:'Monday', tuesday:'Tuesday', wednesday:'Wednesday', thursday:'Thursday', friday:'Friday', saturday:'Saturday', sunday:'Sunday' };
  const DAYPART_KEYS = ['morning','afternoon','evening'];
  const DAYPART_LABELS = { morning:'Morning', afternoon:'Afternoon', evening:'Evening' };

  function schedulesCol(uid){ return db.collection('users').doc(uid).collection('schedules'); }

  function emptyScheduleDays(){
    const days = {};
    DAY_KEYS.forEach(d => { days[d] = { morning: [], afternoon: [], evening: [] }; });
    return days;
  }
  function cloneDays(days){ return JSON.parse(JSON.stringify(days || emptyScheduleDays())); }

  let schedules = [];
  let unsubscribeSchedules = null;
  let editingScheduleId = null;

  // Default/favorite schedule: a single pointer on the settings doc rather
  // than a per-schedule boolean flag, so there's no way for two schedules
  // to ever both be "the default" and no multi-doc transaction needed to
  // switch — one field, one write.
  function settingsDoc(uid){ return metaDoc(uid, 'settings'); }
  let currentSettings = {};
  let unsubscribeSettings = null;

  function startSettingsListener(uid){
    if(unsubscribeSettings) unsubscribeSettings();
    unsubscribeSettings = settingsDoc(uid).onSnapshot(
      snap => {
        currentSettings = snap.exists ? snap.data() : {};
        renderPlannerList();
        if(editingScheduleId) renderPlannerEdit();
        renderHomePlan();
      },
      err => console.error('settings listener failed', err)
    );
  }

  async function setDefaultSchedule(id){
    if(!currentUid || currentSettings.defaultScheduleId === id) return;
    try{ await settingsDoc(currentUid).set({ defaultScheduleId: id }, { merge: true }); }
    catch(err){ console.error('set default schedule failed', err); alert('Could not set default — see console.'); }
  }

  function startSchedulesListener(uid){
    if(unsubscribeSchedules) unsubscribeSchedules();
    unsubscribeSchedules = schedulesCol(uid).orderBy('createdAt').onSnapshot(
      snap => {
        schedules = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderPlannerList();
        if(editingScheduleId) renderPlannerEdit();
        renderHomePlan();
      },
      err => console.error('schedules listener failed', err)
    );
  }

  function renderPlannerList(){
    const list = document.getElementById('scheduleList');
    const emptyEl = document.getElementById('plannerEmpty');
    list.innerHTML = '';
    emptyEl.hidden = schedules.length > 0;
    schedules.forEach(s => {
      const isDefault = currentSettings.defaultScheduleId === s.id;
      const li = document.createElement('li');
      li.className = 'schedule-item';
      li.innerHTML = `
        <div>
          <div class="name">${escapeHtml(s.name)}</div>
          ${isDefault ? '<div class="schedule-default-label">★ Default</div>' : ''}
        </div>
        <div class="item-actions">
          <button class="icon-btn favorite-schedule-btn${isDefault ? ' is-favorite' : ''}" data-id="${s.id}" title="${isDefault ? 'Default schedule' : 'Set as default'}" type="button">${isDefault ? '★' : '☆'}</button>
          <button class="icon-btn edit-schedule-btn" data-id="${s.id}" title="Edit" type="button">✎</button>
          <button class="icon-btn duplicate-schedule-btn" data-id="${s.id}" title="Duplicate" type="button">⧉</button>
          <button class="icon-btn danger delete-schedule-btn" data-id="${s.id}" title="Delete" type="button">✕</button>
        </div>
      `;
      list.appendChild(li);
    });
  }

  document.getElementById('scheduleList').addEventListener('click', (e)=>{
    const favBtn = e.target.closest('.favorite-schedule-btn');
    const editBtn = e.target.closest('.edit-schedule-btn');
    const dupBtn = e.target.closest('.duplicate-schedule-btn');
    const delBtn = e.target.closest('.delete-schedule-btn');
    if(favBtn) setDefaultSchedule(favBtn.dataset.id);
    else if(editBtn) openScheduleEditor(editBtn.dataset.id);
    else if(dupBtn) duplicateSchedule(dupBtn.dataset.id);
    else if(delBtn) deleteSchedule(delBtn.dataset.id);
  });

  function showPlannerListView(){
    editingScheduleId = null;
    document.getElementById('plannerListView').hidden = false;
    document.getElementById('plannerEditView').hidden = true;
  }
  function openScheduleEditor(id){
    editingScheduleId = id;
    document.getElementById('plannerListView').hidden = true;
    document.getElementById('plannerEditView').hidden = false;
    renderPlannerEdit();
  }
  document.getElementById('plannerBackBtn').addEventListener('click', showPlannerListView);

  function renderPlannerEdit(){
    const schedule = schedules.find(s => s.id === editingScheduleId);
    if(!schedule){ showPlannerListView(); return; }
    const nameInput = document.getElementById('scheduleNameInput');
    if(document.activeElement !== nameInput) nameInput.value = schedule.name; // don't clobber while typing
    document.getElementById('plannerDefaultBadge').hidden = currentSettings.defaultScheduleId !== schedule.id;

    const daysEl = document.getElementById('plannerDays');
    daysEl.innerHTML = DAY_KEYS.map(day => {
      const partsHtml = DAYPART_KEYS.map(part => {
        const items = (schedule.days && schedule.days[day] && schedule.days[day][part]) || [];
        const chips = items.map((item, idx) => `
          <span class="planner-chip">${escapeHtml(activityName(item.activityId))} · ${fmtDuration(item.minutes)}
            <button class="chip-remove" data-day="${day}" data-part="${part}" data-idx="${idx}" title="Remove" type="button">✕</button>
          </span>
        `).join('');
        return `
          <div class="planner-daypart">
            <div class="planner-daypart-label">${DAYPART_LABELS[part]}</div>
            <div class="planner-chips">${chips}</div>
            <button class="btn-pill-icon planner-add-btn" data-day="${day}" data-part="${part}" type="button">+ Add</button>
          </div>
        `;
      }).join('');
      return `<div class="planner-day-block"><div class="planner-day-title">${DAY_LABELS[day]}</div>${partsHtml}</div>`;
    }).join('');
  }

  document.getElementById('scheduleNameInput').addEventListener('blur', async (e)=>{
    if(!currentUid) return;
    const schedule = schedules.find(s => s.id === editingScheduleId);
    if(!schedule) return;
    const newName = e.target.value.trim();
    if(!newName || newName === schedule.name){ e.target.value = schedule.name; return; }
    try{ await schedulesCol(currentUid).doc(schedule.id).update({ name: newName }); }
    catch(err){ console.error('rename schedule failed', err); alert('Rename failed — see console.'); e.target.value = schedule.name; }
  });

  document.getElementById('plannerDays').addEventListener('click', (e)=>{
    const addBtn = e.target.closest('.planner-add-btn');
    const removeBtn = e.target.closest('.chip-remove');
    if(addBtn) openAssignModal(addBtn.dataset.day, addBtn.dataset.part);
    else if(removeBtn) removeAssignment(removeBtn.dataset.day, removeBtn.dataset.part, parseInt(removeBtn.dataset.idx, 10));
  });

  async function removeAssignment(day, part, idx){
    if(!currentUid) return;
    const schedule = schedules.find(s => s.id === editingScheduleId);
    if(!schedule) return;
    const days = cloneDays(schedule.days);
    days[day][part].splice(idx, 1);
    try{ await schedulesCol(currentUid).doc(schedule.id).update({ days }); }
    catch(err){ console.error('remove assignment failed', err); alert('Could not remove — see console.'); }
  }

  // ---- add-assignment modal: reused for every day-part rather than 21 inline forms ----
  const assignModalEl = document.getElementById('assignModal');
  const assignModalDayPartEl = document.getElementById('assignModalDayPart');
  const assignActivityEl = document.getElementById('assignActivityId');
  const assignMinutesEl = document.getElementById('assignMinutes');
  const assignErrorEl = document.getElementById('assignFormError');
  let assignTargetDay = null, assignTargetPart = null;

  function setAssignError(msg){
    if(msg){ assignErrorEl.textContent = msg; assignErrorEl.hidden = false; }
    else { assignErrorEl.hidden = true; assignErrorEl.textContent = ''; }
  }

  function openAssignModal(day, part){
    assignTargetDay = day; assignTargetPart = part;
    assignModalDayPartEl.textContent = `${DAY_LABELS[day]} · ${DAYPART_LABELS[part]}`;
    populateActivitySelect(assignActivityEl);
    assignMinutesEl.value = '';
    setAssignError(null);
    assignModalEl.hidden = false;
  }
  function closeAssignModal(){ assignModalEl.hidden = true; }
  document.getElementById('assignCancelBtn').addEventListener('click', closeAssignModal);

  document.getElementById('assignSaveBtn').addEventListener('click', async ()=>{
    if(!currentUid) return;
    const schedule = schedules.find(s => s.id === editingScheduleId);
    if(!schedule) return;
    const activityId = assignActivityEl.value;
    const minutes = parseInt(assignMinutesEl.value, 10);
    if(!activityId){ setAssignError('Add an activity first.'); return; }
    if(!minutes || minutes <= 0){ setAssignError('Enter a positive number of minutes.'); return; }
    const days = cloneDays(schedule.days);
    days[assignTargetDay][assignTargetPart].push({ activityId, minutes });
    try{
      await schedulesCol(currentUid).doc(schedule.id).update({ days });
      closeAssignModal();
    }catch(err){
      console.error('add assignment failed', err);
      setAssignError('Save failed — see console.');
    }
  });

  // ---- schedule list: create / duplicate / delete ----
  const newScheduleFormEl = document.getElementById('newScheduleForm');
  const newScheduleNameEl = document.getElementById('newScheduleName');
  const newScheduleErrorEl = document.getElementById('newScheduleError');

  function setNewScheduleError(msg){
    if(msg){ newScheduleErrorEl.textContent = msg; newScheduleErrorEl.hidden = false; }
    else { newScheduleErrorEl.hidden = true; newScheduleErrorEl.textContent = ''; }
  }

  document.getElementById('addScheduleBtn').addEventListener('click', ()=>{
    newScheduleNameEl.value = '';
    setNewScheduleError(null);
    newScheduleFormEl.hidden = false;
    newScheduleNameEl.focus();
  });
  document.getElementById('newScheduleCancelBtn').addEventListener('click', ()=>{ newScheduleFormEl.hidden = true; });

  newScheduleFormEl.addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!currentUid) return;
    const name = newScheduleNameEl.value.trim();
    if(!name){ setNewScheduleError('Name is required.'); return; }
    const saveBtn = document.getElementById('newScheduleSaveBtn');
    saveBtn.disabled = true;
    try{
      const ref = await schedulesCol(currentUid).add({
        name, days: emptyScheduleDays(), createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      newScheduleFormEl.hidden = true;
      openScheduleEditor(ref.id);
    }catch(err){
      console.error('create schedule failed', err);
      setNewScheduleError('Save failed — see console.');
    }finally{
      saveBtn.disabled = false;
    }
  });

  async function duplicateSchedule(id){
    if(!currentUid) return;
    const schedule = schedules.find(s => s.id === id);
    if(!schedule) return;
    try{
      await schedulesCol(currentUid).add({
        name: `${schedule.name} (copy)`,
        days: cloneDays(schedule.days),
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }catch(err){
      console.error('duplicate schedule failed', err);
      alert('Duplicate failed — see console.');
    }
  }

  async function deleteSchedule(id){
    if(!currentUid) return;
    const schedule = schedules.find(s => s.id === id);
    if(!schedule) return;
    const ok = confirm(`Delete "${schedule.name}"? This can't be undone.`);
    if(!ok) return;
    try{
      await schedulesCol(currentUid).doc(id).delete();
      if(currentSettings.defaultScheduleId === id){
        await settingsDoc(currentUid).set({ defaultScheduleId: null }, { merge: true });
      }
      if(editingScheduleId === id) showPlannerListView();
    }catch(err){
      console.error('delete schedule failed', err);
      alert('Delete failed — see console.');
    }
  }

  // ---------- PAGE: LOG TIME ----------
  // Most-recently-created 15 entries, editable/deletable in place.
  let timeEntries = [];
  let unsubscribeTimeEntries = null;

  function renderTimeEntries(){
    const list = document.getElementById('timeEntryList');
    list.innerHTML = '';
    if(!timeEntries.length){
      list.innerHTML = '<div class="empty-note">No time logged yet.</div>';
      return;
    }
    timeEntries.forEach(e => {
      const li = document.createElement('li');
      li.className = 'time-entry-item';
      const range = e.startTime && e.endTime ? ` · ${fmt12h(e.startTime)}–${fmt12h(e.endTime)}` : '';
      li.innerHTML = `
        <div>
          <div class="name">${escapeHtml(activityName(e.activityId))}</div>
          <div class="meta">${e.date} · ${e.weekday}${range} · ${fmtDuration(e.durationMinutes)}</div>
        </div>
        <div class="item-right">
          <span class="source-tag">${e.source}</span>
          <div class="item-actions">
            <button class="icon-btn edit-entry-btn" data-id="${e.id}" title="Edit" type="button">✎</button>
            <button class="icon-btn danger delete-entry-btn" data-id="${e.id}" title="Delete" type="button">✕</button>
          </div>
        </div>
      `;
      list.appendChild(li);
    });
  }

  document.getElementById('timeEntryList').addEventListener('click', (e)=>{
    const editBtn = e.target.closest('.edit-entry-btn');
    const delBtn = e.target.closest('.delete-entry-btn');
    if(editBtn){
      const entry = timeEntries.find(x => x.id === editBtn.dataset.id);
      if(entry) openLogTimeFormForEdit(entry);
    } else if(delBtn){
      const entry = timeEntries.find(x => x.id === delBtn.dataset.id);
      if(entry) deleteTimeEntry(entry);
    }
  });

  async function deleteTimeEntry(entry){
    const ok = confirm(`Delete this ${activityName(entry.activityId)} entry? This can't be undone.`);
    if(!ok) return;
    try{
      await timeEntriesCol(currentUid).doc(entry.id).delete();
      if(logEntryIdEl.value === entry.id) resetLogTimeForm(); // was mid-edit on the now-deleted entry
    }catch(err){
      console.error('delete time entry failed', err);
      alert('Delete failed — see console.');
    }
  }

  function startTimeEntriesListener(uid){
    if(unsubscribeTimeEntries) unsubscribeTimeEntries();
    unsubscribeTimeEntries = timeEntriesCol(uid).orderBy('createdAt', 'desc').limit(15).onSnapshot(
      snap => {
        timeEntries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderTimeEntries();
      },
      err => console.error('time entries listener failed', err)
    );
  }

  // ---------- period entries: powers the home-screen progress bars ----------
  // Separate from the "recent 15" feed above — this pulls every entry from
  // the earlier of this week's or this month's start, since a week can span
  // two calendar months (e.g. a Monday in late July for an early-August
  // "today"). That's enough range to compute daily/weekly/monthly totals.
  let periodEntries = [];
  let unsubscribePeriodEntries = null;

  function startPeriodEntriesListener(uid){
    if(unsubscribePeriodEntries) unsubscribePeriodEntries();
    periodBounds = computePeriodBounds();
    renderHomeHeader();
    unsubscribePeriodEntries = timeEntriesCol(uid).where('date', '>=', periodBounds.weekStart).onSnapshot(
      snap => {
        periodEntries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderHomeActivities(); renderHomeGoals();
      },
      err => console.error('period entries listener failed', err)
    );
  }

  // ---------- all-time entries: powers the History page ----------
  let allEntries = [];
  let unsubscribeAllEntries = null;

  function startAllEntriesListener(uid){
    if(unsubscribeAllEntries) unsubscribeAllEntries();
    unsubscribeAllEntries = timeEntriesCol(uid).onSnapshot(
      snap => {
        allEntries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if(currentPage === 'history') renderHistoryPage();
      },
      err => console.error('all-entries listener failed', err)
    );
  }

  // ---------- log time form ----------
  // Doubles as the edit form: logEntryIdEl set = editing that entry
  // in-place (update, preserving its original source); empty = logging a
  // new one (add, source: 'manual') — same pattern as the Activities form.
  const logFormEl = document.getElementById('logTimeForm');
  const logEntryIdEl = document.getElementById('logEntryId');
  const logActivityEl = document.getElementById('logActivityId');
  const logDurationEl = document.getElementById('logDuration');
  const logStartTimeEl = document.getElementById('logStartTime');
  const logEndTimeEl = document.getElementById('logEndTime');
  const logDateEl = document.getElementById('logDate');
  const logFormErrorEl = document.getElementById('logFormError');
  const durationFieldEl = document.getElementById('durationField');
  const startEndFieldsEl = document.getElementById('startEndFields');
  const modeDurationBtn = document.getElementById('modeDurationBtn');
  const modeStartEndBtn = document.getElementById('modeStartEndBtn');
  const logSaveBtnEl = document.getElementById('logSaveBtn');
  const logCancelEditBtnEl = document.getElementById('logCancelEditBtn');
  let logMode = 'duration'; // 'duration' | 'startEnd'

  function setLogFormError(msg){
    if(msg){ logFormErrorEl.textContent = msg; logFormErrorEl.hidden = false; }
    else { logFormErrorEl.hidden = true; logFormErrorEl.textContent = ''; }
  }

  function setLogMode(mode){
    logMode = mode;
    const isDuration = mode === 'duration';
    durationFieldEl.hidden = !isDuration;
    startEndFieldsEl.hidden = isDuration;
    modeDurationBtn.classList.toggle('is-active', isDuration);
    modeStartEndBtn.classList.toggle('is-active', !isDuration);
  }
  modeDurationBtn.addEventListener('click', ()=> setLogMode('duration'));
  modeStartEndBtn.addEventListener('click', ()=> setLogMode('startEnd'));

  // Resets the Log Time form to fresh "add a new entry" defaults — called
  // every time the page is navigated to, and after every successful save.
  function resetLogTimeForm(presetActivityId){
    logEntryIdEl.value = '';
    logSaveBtnEl.textContent = 'Save';
    logCancelEditBtnEl.hidden = true;
    setLogFormError(null);
    setLogMode('duration');
    logDurationEl.value = '';
    logStartTimeEl.value = nowTimeStr();
    logEndTimeEl.value = nowTimeStr();
    logDateEl.value = todayDateStr();
    if(presetActivityId && activities.some(a => a.id === presetActivityId)) logActivityEl.value = presetActivityId;
    else if(activities.length) logActivityEl.value = activities[0].id;
  }

  function openLogTimeFormForEdit(entry){
    logEntryIdEl.value = entry.id;
    logSaveBtnEl.textContent = 'Update';
    logCancelEditBtnEl.hidden = false;
    setLogFormError(null);
    logActivityEl.value = entry.activityId;
    logDateEl.value = entry.date;
    if(entry.startTime && entry.endTime){
      setLogMode('startEnd');
      logStartTimeEl.value = entry.startTime;
      logEndTimeEl.value = entry.endTime;
    } else {
      setLogMode('duration');
      logDurationEl.value = entry.durationMinutes;
    }
    logFormEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  logCancelEditBtnEl.addEventListener('click', ()=> resetLogTimeForm());

  logFormEl.addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!currentUid) return;
    if(!activities.length){ setLogFormError('Add an activity first.'); return; }

    const activityId = logActivityEl.value;
    const date = logDateEl.value;
    if(!date){ setLogFormError('Date is required.'); return; }

    let startTime = null, endTime = null, durationMinutes;
    if(logMode === 'duration'){
      durationMinutes = parseInt(logDurationEl.value, 10);
      if(!durationMinutes || durationMinutes <= 0){ setLogFormError('Enter a duration greater than 0.'); return; }
    } else {
      startTime = logStartTimeEl.value;
      endTime = logEndTimeEl.value;
      if(!startTime || !endTime){ setLogFormError('Enter both a start and end time.'); return; }
      const [sh, sm] = startTime.split(':').map(Number);
      const [eh, em] = endTime.split(':').map(Number);
      durationMinutes = (eh*60+em) - (sh*60+sm);
      if(durationMinutes <= 0){ setLogFormError('End time must be after start time.'); return; }
    }

    const editingId = logEntryIdEl.value;
    logSaveBtnEl.disabled = true;
    try{
      if(editingId){
        await timeEntriesCol(currentUid).doc(editingId).update({
          activityId, date, weekday: weekdayFromDateStr(date), startTime, endTime, durationMinutes,
        });
      } else {
        await timeEntriesCol(currentUid).add({
          activityId,
          date,
          weekday: weekdayFromDateStr(date),
          startTime, endTime,
          durationMinutes,
          source: 'manual',
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }
      resetLogTimeForm();
    }catch(err){
      console.error('save time entry failed', err);
      setLogFormError('Save failed — see console.');
    }finally{
      logSaveBtnEl.disabled = false;
    }
  });

  // ---------- PAGE: HISTORY ----------
  // Only past, completed weeks — "last week" is the most recent column.
  // High/low/avg are computed across every applicable week since the
  // activity was created, not just the columns currently in view.
  function weekTotalMinutes(activityId, weekMondayStr){
    const endDate = new Date(weekMondayStr + 'T00:00:00'); endDate.setDate(endDate.getDate() + 6);
    const end = dateToStr(endDate);
    return allEntries
      .filter(e => e.activityId === activityId && e.date >= weekMondayStr && e.date <= end)
      .reduce((sum, e) => sum + e.durationMinutes, 0);
  }

  function activityCreatedWeekMonday(activity){
    if(!activity.createdAt || typeof activity.createdAt.toDate !== 'function') return null;
    return dateToStr(mondayOfDateStr(dateToStr(activity.createdAt.toDate())));
  }

  // A week counts for an activity once the activity exists. (No per-activity
  // schedule rule anymore — every week since creation counts, zeros included.)
  function weekAppliesToActivity(weekMondayStr, createdWeekStr){
    return !(createdWeekStr && weekMondayStr < createdWeekStr);
  }

  function renderHistoryPage(){
    const tableEl = document.getElementById('historyTable');
    const emptyEl = document.getElementById('historyEmpty');

    const currentMonday = new Date(periodBounds.weekStart + 'T00:00:00');
    const lastWeekMonday = new Date(currentMonday); lastWeekMonday.setDate(currentMonday.getDate() - 7);
    const lastWeekStr = dateToStr(lastWeekMonday);

    if(!allEntries.length){
      tableEl.innerHTML = '';
      emptyEl.hidden = false;
      emptyEl.textContent = 'No completed weeks yet.';
      return;
    }

    const earliestEntryDate = allEntries.reduce((min, e) => e.date < min ? e.date : min, allEntries[0].date);
    const earliestMondayStr = dateToStr(mondayOfDateStr(earliestEntryDate));

    if(earliestMondayStr > lastWeekStr){
      tableEl.innerHTML = '';
      emptyEl.hidden = false;
      emptyEl.textContent = 'No completed weeks yet — check back after this week ends.';
      return;
    }
    emptyEl.hidden = true;

    const weekMondays = [];
    let cursor = new Date(lastWeekMonday);
    while(dateToStr(cursor) >= earliestMondayStr){
      weekMondays.push(dateToStr(cursor));
      cursor.setDate(cursor.getDate() - 7);
    }

    let html = '<thead><tr><th class="hist-activity-col">Activity</th><th>High</th><th>Low</th><th>Avg</th>';
    weekMondays.forEach(w => {
      const m = new Date(w + 'T00:00:00');
      html += `<th>${MONTHS_SHORT[m.getMonth()]} ${m.getDate()}</th>`;
    });
    html += '</tr></thead><tbody>';

    sortedActivities().forEach(a => {
      const createdWeekStr = activityCreatedWeekMonday(a);
      const applicableWeeks = weekMondays.filter(w => weekAppliesToActivity(w, createdWeekStr));
      const totals = applicableWeeks.map(w => weekTotalMinutes(a.id, w));
      const high = totals.length ? Math.max(...totals) : null;
      const low = totals.length ? Math.min(...totals) : null;
      const avg = totals.length ? Math.round(totals.reduce((s, x) => s + x, 0) / totals.length) : null;

      html += `<tr><td class="hist-activity-col">${escapeHtml(a.name)}</td>`;
      html += `<td>${high === null ? '–' : fmtDuration(high)}</td><td>${low === null ? '–' : fmtDuration(low)}</td><td>${avg === null ? '–' : fmtDuration(avg)}</td>`;
      weekMondays.forEach(w => {
        if(!weekAppliesToActivity(w, createdWeekStr)){ html += '<td class="hist-na">–</td>'; return; }
        html += `<td>${fmtDuration(weekTotalMinutes(a.id, w))}</td>`;
      });
      html += '</tr>';
    });
    html += '</tbody>';
    tableEl.innerHTML = html;
  }

  // ---------- timer: shared state across devices ----------
  // users/{uid}/meta/activeTimer is a single doc; its absence means no
  // timer is running. Every signed-in device subscribes to it, so starting
  // on the phone shows the banner on the laptop within a snapshot round trip.
  // Fields:
  //   activityId
  //   startTime      ms the session first started (used for the saved entry's
  //                  date and start time)
  //   status         'running' | 'paused'
  //   accumulatedMs  active time banked before the current run segment
  //   runStartedAt   ms of the last start/resume (null while paused)
  //   pausedAt       ms the current pause began (null while running)
  // Active time = accumulatedMs + (now - runStartedAt) while running, or just
  // accumulatedMs while paused, so paused time never counts and the math
  // stays correct across refreshes and devices. Docs written before pause
  // existed only have { activityId, startTime } and are read as running.
  let activeTimer = null;
  let unsubscribeTimer = null;
  let timerTickHandle = null;

  const timerBannerEl = document.getElementById('timerBanner');
  const timerActivityNameEl = document.getElementById('timerActivityName');
  const timerStartedLabelEl = document.getElementById('timerStartedLabel');
  const timerElapsedEl = document.getElementById('timerElapsed');
  const timerWarningEl = document.getElementById('timerWarning');
  const timerPausedLineEl = document.getElementById('timerPausedLine');
  const timerRunningActionsEl = document.getElementById('timerRunningActions');
  const timerPausedActionsEl = document.getElementById('timerPausedActions');

  function timerStatus(t){ return t.status === 'paused' ? 'paused' : 'running'; }
  function timerActiveMs(t, now = Date.now()){
    const banked = t.accumulatedMs ?? 0;
    if(timerStatus(t) === 'paused') return banked;
    return banked + Math.max(0, now - (t.runStartedAt ?? t.startTime));
  }
  // Total time spent paused so far this session (all pauses added up).
  function timerPausedMs(t, now = Date.now()){
    return Math.max(0, (now - t.startTime) - timerActiveMs(t, now));
  }
  function newTimerDoc(activityId){
    const now = Date.now();
    return { activityId, startTime: now, status: 'running', accumulatedMs: 0, runStartedAt: now, pausedAt: null };
  }

  // Read-modify-write in a transaction so two devices tapping at once can't
  // corrupt the banked time.
  // After the server confirms the change, apply it to this screen right away
  // instead of waiting for the live listener to echo it back — that echo can
  // lag on a flaky mobile connection, and a tap should respond immediately.
  async function pauseTimer(){
    const ref = metaDoc(currentUid, 'activeTimer');
    let applied = null;
    await db.runTransaction(async tx => {
      applied = null;
      const snap = await tx.get(ref);
      if(!snap.exists) return;
      const t = snap.data();
      if(timerStatus(t) === 'paused') return;
      const now = Date.now();
      const change = { status: 'paused', accumulatedMs: timerActiveMs(t, now), runStartedAt: null, pausedAt: now };
      tx.update(ref, change);
      applied = { ...t, ...change };
    });
    if(applied) setActiveTimer(applied);
  }
  async function resumeTimer(){
    const ref = metaDoc(currentUid, 'activeTimer');
    let applied = null;
    await db.runTransaction(async tx => {
      applied = null;
      const snap = await tx.get(ref);
      if(!snap.exists) return;
      const t = snap.data();
      if(timerStatus(t) !== 'paused') return;
      const change = { status: 'running', runStartedAt: Date.now(), pausedAt: null };
      tx.update(ref, change);
      applied = { ...t, ...change };
    });
    if(applied) setActiveTimer(applied);
  }

  document.getElementById('pauseTimerBtn').addEventListener('click', async ()=>{
    if(!currentUid || !activeTimer) return;
    try{ await pauseTimer(); }
    catch(err){ console.error('pause failed', err); alert('Could not pause — see console.'); }
  });
  document.getElementById('resumeTimerBtn').addEventListener('click', async ()=>{
    if(!currentUid || !activeTimer) return;
    // Short guard so a fast double-tap on Pause can't land on the Resume
    // button that replaces it in the same spot.
    if(activeTimer.pausedAt && Date.now() - activeTimer.pausedAt < 700) return;
    try{ await resumeTimer(); }
    catch(err){ console.error('resume failed', err); alert('Could not resume — see console.'); }
  });

  // One fixed limit for every activity: more than 4 hours of ACTIVE time
  // (paused time doesn't count) and we ask whether you forgot to stop it.
  const STALE_TIMER_MS = 4 * 60 * 60 * 1000;
  function isTimerStale(activeMs){
    return activeMs > STALE_TIMER_MS;
  }

  // ---------- goal countdowns under the running timer ----------
  // One entry per line to show for the running activity: a daily goal gives
  // "<name> today" and "<name> this week"; a weekly goal gives just "this
  // week". Remaining = target minus everything tracked toward the goal (saved
  // entries plus the running session). The session counts toward the day it
  // started; if that day isn't in the current week it doesn't count to it.
  function goalCountdownLines(activityId, activeMs){
    const sessionDate = msToDateStr(activeTimer.startTime);
    const today = periodBounds.today;
    const lines = [];
    sortedGoals().filter(g => (g.activityIds || []).includes(activityId)).forEach(g => {
      const r = scoreGoalForWeek(g, periodBounds.weekStart, periodEntries);
      const sessionInWeek = sessionDate >= periodBounds.weekStart && sessionDate <= periodBounds.weekEnd;
      const weekMs = r.weeklyMinutes * 60000 + (sessionInWeek ? activeMs : 0);
      if(g.type === 'daily'){
        const t = r.days.find(d => d.date === today);
        if(!t || !t.isWorking){
          lines.push({ label: `${g.name} today`, text: 'Day off', kind: 'off' });
        } else if(t.onVacation){
          lines.push({ label: `${g.name} today`, text: 'Vacation', kind: 'off' });
        } else {
          const dayMs = t.minutes * 60000 + (sessionDate === today ? activeMs : 0);
          lines.push({ label: `${g.name} today`, ...countdownValue(g.targetMinutes * 60000 - dayMs) });
        }
      }
      lines.push(r.skipped
        ? { label: `${g.name} this week`, text: 'Vacation', kind: 'off' }
        : { label: `${g.name} this week`, ...countdownValue(r.weeklyTarget * 60000 - weekMs) });
    });
    return lines;
  }

  // "3:42:10 left", or "Goal reached" plus "+0:12:00 over" once past the
  // target — never a negative number.
  function countdownValue(remainingMs){
    if(remainingMs > 0) return { text: `${fmtHMS(remainingMs)} left`, kind: 'left' };
    const over = -remainingMs;
    return { text: over >= 1000 ? `Goal reached · +${fmtHMS(over)} over` : 'Goal reached', kind: 'reached' };
  }

  function renderTimerGoalLines(activeMs){
    const el = document.getElementById('timerGoals');
    const lines = goalCountdownLines(activeTimer.activityId, activeMs);
    el.hidden = lines.length === 0;
    el.innerHTML = lines.map(l =>
      `<div class="timer-goal-line is-${l.kind}"><span class="timer-goal-label">${escapeHtml(l.label)}:</span> <span class="timer-goal-value">${l.text}</span></div>`
    ).join('');
  }

  function tickTimerBanner(){
    if(!activeTimer) return;
    const now = Date.now();
    const paused = timerStatus(activeTimer) === 'paused';
    const activeMs = timerActiveMs(activeTimer, now);

    timerElapsedEl.textContent = fmtHMS(activeMs);
    renderTimerGoalLines(activeMs);
    if(paused){
      timerPausedLineEl.textContent = `Paused for ${fmtElapsed(now - (activeTimer.pausedAt ?? now))}`;
    }

    const stale = !paused && isTimerStale(activeMs);
    timerWarningEl.hidden = !stale;
    timerBannerEl.classList.toggle('is-stale', stale);
  }

  function renderTimerBanner(){
    if(activeTimer){
      const paused = timerStatus(activeTimer) === 'paused';
      timerBannerEl.hidden = false;
      timerBannerEl.classList.toggle('is-paused', paused);
      timerRunningActionsEl.hidden = paused;   // while paused, Resume is the ONLY button
      timerPausedActionsEl.hidden = !paused;
      timerPausedLineEl.hidden = !paused;
      timerActivityNameEl.textContent = activityName(activeTimer.activityId);
      timerStartedLabelEl.textContent = ` · started ${fmt12h(msToHHMM(activeTimer.startTime))}`;
      tickTimerBanner();
      if(!timerTickHandle) timerTickHandle = setInterval(tickTimerBanner, 1000);
      if(!timerPollHandle) timerPollHandle = setInterval(()=>{ if(!document.hidden) refreshTimerFromServer(); }, 10000);
    } else {
      if(timerPollHandle){ clearInterval(timerPollHandle); timerPollHandle = null; }
      timerBannerEl.hidden = true;
      timerBannerEl.classList.remove('is-paused');
      closeStopModal(); // timer ended elsewhere — don't leave its pop-up stranded
      if(timerTickHandle){ clearInterval(timerTickHandle); timerTickHandle = null; }
    }
  }

  // Key-order-insensitive compare, so the same state arriving from the server
  // (keys in a different order) isn't mistaken for a change.
  function stableJson(o){
    return JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v))
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
  }
  function setActiveTimer(next){
    if(stableJson(next) === stableJson(activeTimer)) return; // nothing changed
    activeTimer = next;
    renderTimerBanner();
    renderHomeActivities(); renderHomeGoals(); // per-row Timer buttons enable/disable with activeTimer
  }
  function applyTimerSnapshot(snap){
    setActiveTimer(snap.exists ? snap.data() : null);
  }

  function startTimerListener(uid){
    if(unsubscribeTimer) unsubscribeTimer();
    unsubscribeTimer = metaDoc(uid, 'activeTimer').onSnapshot(
      snap => applyTimerSnapshot(snap),
      err => console.error('timer listener failed', err)
    );
  }

  // Safety net for flaky live connections. iPhones suspend a web app's
  // connection when it's backgrounded or the screen locks, and the live
  // listener above can then sit on stale state (e.g. a paused screen after
  // the timer was resumed on another device). So also ask the server
  // directly: when the app comes back to the foreground, when the network
  // returns, and every 10s while a timer is active and the app is visible.
  async function refreshTimerFromServer(){
    if(!currentUid) return;
    try{
      applyTimerSnapshot(await metaDoc(currentUid, 'activeTimer').get({ source: 'server' }));
    }catch(e){ /* offline — the live listener will catch up when it reconnects */ }
  }
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) refreshTimerFromServer(); });
  window.addEventListener('pageshow', refreshTimerFromServer);
  window.addEventListener('online', refreshTimerFromServer);
  window.addEventListener('focus', refreshTimerFromServer);
  let timerPollHandle = null;

  // ---------- stop-timer confirmation modal ----------
  const stopModalEl = document.getElementById('stopTimerModal');
  const stopModalSummaryEl = document.getElementById('stopModalSummary');
  const stopModalWarningEl = document.getElementById('stopModalWarning');
  const stopChoiceButtonsEl = document.getElementById('stopChoiceButtons');
  const stopEditEndPanelEl = document.getElementById('stopEditEndPanel');
  const stopEditEndTimeEl = document.getElementById('stopEditEndTime');
  const stopEditEndErrorEl = document.getElementById('stopEditEndError');

  function setStopEditEndError(msg){
    if(msg){ stopEditEndErrorEl.textContent = msg; stopEditEndErrorEl.hidden = false; }
    else { stopEditEndErrorEl.hidden = true; stopEditEndErrorEl.textContent = ''; }
  }

  function showStopChoice(){
    stopChoiceButtonsEl.hidden = false;
    stopEditEndPanelEl.hidden = true;
    setStopEditEndError(null);
  }

  function openStopModal(){
    if(!activeTimer) return;
    const activeMs = timerActiveMs(activeTimer);
    stopModalSummaryEl.textContent =
      `${activityName(activeTimer.activityId)} — started ${fmt12h(msToHHMM(activeTimer.startTime))}, ${fmtElapsed(activeMs)} active.`;
    stopModalWarningEl.hidden = !isTimerStale(activeMs);
    stopEditEndTimeEl.value = nowTimeStr();
    showStopChoice();
    stopModalEl.hidden = false;
  }
  function closeStopModal(){ stopModalEl.hidden = true; }

  // Dismissing (X, tapping outside, Escape) only hides the pop-up — it never
  // touches the timer, so a running or paused timer carries on with no time
  // lost. "Outside" only counts if the press both started and ended on the
  // dark backdrop, so dragging a text selection out of the card can't close it.
  document.getElementById('stopCloseBtn').addEventListener('click', closeStopModal);
  let stopPressStartedOnBackdrop = false;
  stopModalEl.addEventListener('pointerdown', e => { stopPressStartedOnBackdrop = (e.target === stopModalEl); });
  stopModalEl.addEventListener('click', e => {
    if(e.target === stopModalEl && stopPressStartedOnBackdrop) closeStopModal();
    stopPressStartedOnBackdrop = false;
  });
  document.addEventListener('keydown', e => {
    if(e.key === 'Escape' && !stopModalEl.hidden) closeStopModal();
  });

  document.getElementById('stopTimerBtn').addEventListener('click', openStopModal);

  // durationMs is active time only — paused time is never part of it.
  async function finalizeTimerEntry(endMs, durationMs){
    const { activityId, startTime } = activeTimer;
    await timeEntriesCol(currentUid).add({
      activityId,
      date: msToDateStr(startTime),
      weekday: weekdayFromDateStr(msToDateStr(startTime)),
      startTime: msToHHMM(startTime),
      endTime: msToHHMM(endMs),
      durationMinutes: Math.round(durationMs / 60000),
      source: 'timer',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await metaDoc(currentUid, 'activeTimer').delete();
  }

  document.getElementById('stopKeepBtn').addEventListener('click', async ()=>{
    if(!activeTimer) return;
    try{
      const now = Date.now();
      await finalizeTimerEntry(now, timerActiveMs(activeTimer, now));
      closeStopModal();
    }catch(err){
      console.error('stop (keep as-is) failed', err);
      alert('Could not save — see console.');
    }
  });

  document.getElementById('stopEditEndBtn').addEventListener('click', ()=>{
    stopChoiceButtonsEl.hidden = true;
    stopEditEndPanelEl.hidden = false;
  });
  document.getElementById('stopEditEndBackBtn').addEventListener('click', showStopChoice);

  document.getElementById('stopEditEndSaveBtn').addEventListener('click', async ()=>{
    if(!activeTimer) return;
    const hhmm = stopEditEndTimeEl.value;
    if(!hhmm){ setStopEditEndError('Enter an end time.'); return; }
    let endMs = combineDateWithTime(activeTimer.startTime, hhmm);
    if(endMs <= activeTimer.startTime) endMs += 24*60*60*1000; // crossed midnight
    if(endMs <= activeTimer.startTime){ setStopEditEndError('End time must be after the start time.'); return; }
    // The edited span minus any time spent paused (pauses are never counted).
    const durationMs = (endMs - activeTimer.startTime) - timerPausedMs(activeTimer);
    if(durationMs <= 0){ setStopEditEndError('That end time leaves no tracked time once pauses are removed.'); return; }
    try{
      await finalizeTimerEntry(endMs, durationMs);
      closeStopModal();
    }catch(err){
      console.error('stop (edit end) failed', err);
      setStopEditEndError('Save failed — see console.');
    }
  });

  document.getElementById('stopDiscardBtn').addEventListener('click', async ()=>{
    if(!activeTimer) return;
    const activityId = activeTimer.activityId;
    try{
      await metaDoc(currentUid, 'activeTimer').delete();
      closeStopModal();
      pendingLogTimePreset = activityId;
      navigateTo('logtime');
    }catch(err){
      console.error('discard timer failed', err);
      alert('Could not discard — see console.');
    }
  });

  // Shows which build this device is actually running (read from the ?v=N on
  // the script tag), so a stale cached copy on a phone is easy to spot.
  const RUNNING_VERSION = (()=>{
    const s = [...document.scripts].find(x => x.src.includes('app.js'));
    return Number(s && new URL(s.src).searchParams.get('v')) || 0;
  })();
  document.getElementById('appVersion').textContent = RUNNING_VERSION ? `Version ${RUNNING_VERSION}` : '';

  // ---------- self-update ----------
  // A home-screen app that stays suspended in the background keeps running
  // whatever code it loaded days ago, and the host lets pages be cached for
  // 10 minutes besides. So when the app comes back to the foreground (and
  // every few minutes while it's visible) it asks the server which version
  // is deployed, bypassing every cache, and reloads itself if it's newer.
  // The timer lives in Firestore, so a reload never loses it.
  let lastUpdateCheck = 0;
  function reloadForUpdate(){
    // Cache-busted URL so the reload can't be served a stale cached page;
    // the param is stripped again on load.
    const url = new URL(location.href);
    url.searchParams.set('r', String(Date.now()));
    location.replace(url.toString());
  }
  function safeToReloadNow(){
    const a = document.activeElement;
    const typing = a && ['INPUT','TEXTAREA','SELECT'].includes(a.tagName);
    const modalOpen = [...document.querySelectorAll('.modal-backdrop')].some(m => !m.hidden);
    return !typing && !modalOpen;
  }
  async function checkForNewVersion(){
    if(!RUNNING_VERSION || document.hidden) return;
    if(Date.now() - lastUpdateCheck < 30000) return;   // at most every 30s
    lastUpdateCheck = Date.now();
    try{
      const res = await fetch(new URL('index.html', location.href).pathname + '?c=' + Date.now(), { cache: 'no-store' });
      const m = (await res.text()).match(/app\.js\?v=(\d+)/);
      if(!m || Number(m[1]) <= RUNNING_VERSION) return;
      // Loop guard: never auto-reload more than once a minute.
      const last = Number(sessionStorage.getItem('tgLastAutoReload') || 0);
      if(safeToReloadNow() && Date.now() - last > 60000){
        sessionStorage.setItem('tgLastAutoReload', String(Date.now()));
        reloadForUpdate();
      } else {
        document.getElementById('updateBanner').hidden = false;
      }
    }catch(e){ /* offline — try again next time */ }
  }
  document.getElementById('updateReloadBtn').addEventListener('click', reloadForUpdate);
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) checkForNewVersion(); });
  window.addEventListener('pageshow', checkForNewVersion);
  window.addEventListener('focus', checkForNewVersion);
  setInterval(checkForNewVersion, 5 * 60 * 1000);
  checkForNewVersion();
  if(new URLSearchParams(location.search).has('r')){
    history.replaceState(null, '', location.pathname + location.hash);
  }

  // ---------- keep the screen awake on the home page ----------
  // Ported from Day Chain (same two strategies, same fallback logic, same
  // status line). The native Screen Wake Lock API is tried first; a silent
  // looping 1px <video> (muted + loop + playsinline — all required or iOS
  // no-ops or fullscreens it) is started alongside it as a fallback and
  // paused if the native lock succeeds. On iPhone BOTH only work when started
  // synchronously inside a real tap (before any await), so the first tap on
  // the home page engages it. It stays on while the timer runs, is paused or
  // isn't running at all, is released when you leave the home page, and is
  // re-acquired whenever the app returns to the foreground (iOS drops it when
  // the app is backgrounded or the screen locks).
  let wakeLock = null;
  let keepAwakeVideo = null;
  let keepAwakeMode = null; // 'wakelock' | 'video' | 'failed' | null

  // Uses the page we're navigating TO (set synchronously in navigateTo), not
  // the one currently shown, so a lock requested by the tap that heads home
  // isn't mistaken for a request made off the home page.
  function onHomePage(){ return !!currentUid && intendedPage === 'home'; }
  function keepAwakeEngaged(){
    return keepAwakeMode === 'wakelock' || (keepAwakeMode === 'video' && keepAwakeVideo && !keepAwakeVideo.paused);
  }

  function ensureKeepAwakeVideoEl(){
    if(keepAwakeVideo) return keepAwakeVideo;
    const v = document.createElement('video');
    v.src = 'keepawake.mp4';
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.muted = true;
    v.defaultMuted = true;
    v.loop = true;
    v.setAttribute('aria-hidden', 'true');
    v.style.cssText = 'position:fixed; top:0; left:0; width:1px; height:1px; opacity:0; pointer-events:none;';
    document.body.appendChild(v);
    keepAwakeVideo = v;
    return v;
  }

  function updateKeepAwakeIndicator(){
    const el = document.getElementById('keepAwakeStatus');
    if(!onHomePage()){ el.hidden = true; return; }
    if(keepAwakeMode === 'wakelock') el.textContent = 'Screen staying awake · Wake Lock API';
    else if(keepAwakeMode === 'video') el.textContent = 'Screen staying awake · video fallback';
    else if(keepAwakeMode === 'failed') el.textContent = 'Couldn’t keep the screen awake on this device';
    else el.textContent = 'Screen may sleep · tap anywhere to keep it awake';   // waiting for a tap (iPhone needs one)
    el.hidden = false;
  }

  function adoptWakeLock(lock){
    // A request can resolve after we've already left the home page: don't
    // hold the screen awake anywhere else.
    if(!onHomePage()){ lock.release().catch(()=>{}); return; }
    // Never leave an earlier lock orphaned (it would outlive release).
    if(wakeLock && wakeLock !== lock) wakeLock.release().catch(()=>{});
    wakeLock = lock;
    keepAwakeMode = 'wakelock';
    lock.addEventListener('release', ()=>{
      if(wakeLock === lock) wakeLock = null;
      if(keepAwakeMode === 'wakelock') keepAwakeMode = null;
      updateKeepAwakeIndicator();
    });
    if(keepAwakeVideo && !keepAwakeVideo.paused) keepAwakeVideo.pause(); // native lock is enough
    updateKeepAwakeIndicator();
  }

  // Call SYNCHRONOUSLY from a tap, before any await — that's the only way
  // iOS reliably grants either mechanism.
  function engageKeepAwakeFromGesture(){
    if(keepAwakeEngaged()) return;
    let wakeLockPromise = null;
    if('wakeLock' in navigator){
      try{ wakeLockPromise = navigator.wakeLock.request('screen'); }
      catch(e){ wakeLockPromise = Promise.reject(e); }
    }
    const video = ensureKeepAwakeVideoEl();
    let videoPlay;
    try{ videoPlay = video.play(); }   // synchronous, inside the tap — required on iOS
    catch(e){ videoPlay = Promise.reject(e); }
    const videoPlayPromise = Promise.resolve(videoPlay).then(
      () => true,
      e => { console.warn('[keep-awake] video fallback failed to start', e); return false; }
    );
    const fellBack = async (why)=>{
      console.warn('[keep-awake]', why);
      const playing = await videoPlayPromise;
      keepAwakeMode = playing ? 'video' : 'failed';
      if(keepAwakeMode === 'failed') console.error('[keep-awake] both mechanisms failed — screen may still auto-lock');
      updateKeepAwakeIndicator();
    };
    if(wakeLockPromise){
      wakeLockPromise.then(adoptWakeLock).catch(e => fellBack('native Wake Lock unavailable/denied — using video fallback: ' + e));
    } else {
      fellBack('Wake Lock API not supported here — using video fallback');
    }
  }

  // Quiet attempt with no tap (works on desktop browsers; iPhone will refuse,
  // which just leaves the "tap anywhere" hint showing — never marks failure).
  function tryWakeLockWithoutGesture(){
    if(!onHomePage() || keepAwakeEngaged() || !('wakeLock' in navigator)) return;
    if(document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(adoptWakeLock).catch(()=>{});
  }

  async function releaseKeepAwake(){
    if(wakeLock){
      const lock = wakeLock;
      wakeLock = null;
      try{ await lock.release(); }catch(e){}
    }
    if(keepAwakeVideo && !keepAwakeVideo.paused) keepAwakeVideo.pause();
    keepAwakeMode = null;
    updateKeepAwakeIndicator();
  }

  // Back in the foreground: both mechanisms were force-stopped by the OS.
  // Re-acquiring needs no fresh tap (documented pattern for wake locks; a
  // video that already played once from a tap may resume freely).
  function reacquireKeepAwake(){
    if(!onHomePage() || document.visibilityState !== 'visible') return;
    if(keepAwakeMode === 'wakelock' && wakeLock) return;   // still holding it
    const resumeVideo = ()=>{
      if(keepAwakeVideo && keepAwakeVideo.paused){
        keepAwakeVideo.play().then(()=>{ keepAwakeMode = 'video'; updateKeepAwakeIndicator(); })
          .catch(e => console.warn('[keep-awake] resume video failed', e));
      }
    };
    if('wakeLock' in navigator){
      navigator.wakeLock.request('screen').then(adoptWakeLock).catch(resumeVideo);
    } else resumeVideo();
  }
  document.addEventListener('visibilitychange', reacquireKeepAwake);
  window.addEventListener('pageshow', reacquireKeepAwake);

  // The first tap anywhere on the home page (and any later tap if it isn't
  // currently engaged — e.g. after Resume, or after the OS dropped it)
  // engages it, since a tap is the one thing iOS will honor.
  document.addEventListener('click', ()=>{
    if(onHomePage() && !keepAwakeEngaged()) engageKeepAwakeFromGesture();
  }, true);

  // ---------- page navigation ----------
  const PAGES = ['home', 'activities', 'goals', 'planner', 'logtime', 'history', 'settings'];
  let currentPage = 'home';
  let intendedPage = 'home';   // set the instant navigation starts (see onHomePage)
  let pendingLogTimePreset = null;

  function showPage(page){
    if(!PAGES.includes(page)) page = 'home';
    currentPage = page;
    PAGES.forEach(p => { document.getElementById('page-' + p).hidden = (p !== page); });
    document.querySelectorAll('.nav-btn, .nav-icon-btn').forEach(b => b.classList.toggle('is-active', b.dataset.page === page));
    intendedPage = page;
    if(page === 'home') tryWakeLockWithoutGesture();   // keep the screen awake on home only
    else releaseKeepAwake();
    updateKeepAwakeIndicator();
    if(page === 'logtime'){
      resetLogTimeForm(pendingLogTimePreset);
      pendingLogTimePreset = null;
    } else if(page === 'history'){
      renderHistoryPage();
    } else if(page === 'planner'){
      showPlannerListView();
    }
  }

  function navigateTo(page){
    intendedPage = page;
    // Heading to home from a tap: engage right here, synchronously, while we
    // still have the tap's user gesture (iPhone ignores it otherwise).
    if(page === 'home') engageKeepAwakeFromGesture();
    const newHash = page === 'home' ? '' : page;
    if(location.hash.slice(1) !== newHash) location.hash = newHash;
    else showPage(page); // hash unchanged, so hashchange won't fire on its own
  }

  document.getElementById('homeLink').addEventListener('click', ()=> navigateTo('home'));
  document.getElementById('homeLink').addEventListener('keydown', (e)=>{ if(e.key === 'Enter') navigateTo('home'); });
  document.getElementById('settingsNavBtn').addEventListener('click', ()=> navigateTo('settings'));
  document.querySelectorAll('.nav-btn, .nav-icon-btn').forEach(b => b.addEventListener('click', ()=> navigateTo(b.dataset.page)));
  window.addEventListener('hashchange', ()=> showPage(location.hash.slice(1) || 'home'));

  // ---------- AUTH ----------
  function setSigninError(msg){
    const el = document.getElementById('signinError');
    if(msg){ el.textContent = msg; el.hidden = false; }
    else { el.hidden = true; el.textContent = ''; }
  }

  document.getElementById('googleSigninBtn').addEventListener('click', async ()=>{
    setSigninError(null);
    const provider = new firebase.auth.GoogleAuthProvider();
    try{
      await auth.signInWithPopup(provider);
    }catch(e){
      console.error('sign-in failed', e);
      setSigninError('Sign-in failed. Please try again.');
    }
  });

  document.getElementById('signoutBtn').addEventListener('click', ()=> auth.signOut());

  auth.onAuthStateChanged(async (user)=>{
    if(user){
      currentUid = user.uid;
      document.getElementById('screen-signin').hidden = true;
      document.getElementById('appShell').hidden = false;
      showConnectionError(null);
      showPage(location.hash.slice(1) || 'home');

      // Listeners start immediately — they don't need seeding to finish
      // first, since a live onSnapshot naturally picks up seed writes
      // whenever they land. Blocking on three sequential seed-check round
      // trips before the list could even start loading was adding real,
      // needless delay.
      startActivitiesListener(user.uid);
      startTimeEntriesListener(user.uid);
      startPeriodEntriesListener(user.uid);
      startAllEntriesListener(user.uid);
      startTimerListener(user.uid);
      startGoalsListener(user.uid);
      startVacationsListener(user.uid);
      startSchedulesListener(user.uid);
      startSettingsListener(user.uid);
      periodRolloverIntervalHandle = setInterval(checkForPeriodRollover, 60 * 1000);

      (async ()=>{
        try{
          await seedActivitiesIfEmpty(user.uid);
          await ensureSettingsDoc(user.uid);
        }catch(e){
          console.error('Firestore seeding failed', e);
          showConnectionError('Firestore connection failed — see console.');
        }
      })();
    } else {
      currentUid = null;
      activities = [];
      timeEntries = [];
      periodEntries = [];
      allEntries = [];
      activeTimer = null;
      schedules = [];
      goals = [];
      vacations = [];
      editingScheduleId = null;
      currentSettings = {};
      if(unsubscribeActivities){ unsubscribeActivities(); unsubscribeActivities = null; }
      if(unsubscribeTimeEntries){ unsubscribeTimeEntries(); unsubscribeTimeEntries = null; }
      if(unsubscribePeriodEntries){ unsubscribePeriodEntries(); unsubscribePeriodEntries = null; }
      if(unsubscribeAllEntries){ unsubscribeAllEntries(); unsubscribeAllEntries = null; }
      if(unsubscribeTimer){ unsubscribeTimer(); unsubscribeTimer = null; }
      if(unsubscribeGoals){ unsubscribeGoals(); unsubscribeGoals = null; }
      if(unsubscribeVacations){ unsubscribeVacations(); unsubscribeVacations = null; }
      if(unsubscribeSchedules){ unsubscribeSchedules(); unsubscribeSchedules = null; }
      if(unsubscribeSettings){ unsubscribeSettings(); unsubscribeSettings = null; }
      if(timerTickHandle){ clearInterval(timerTickHandle); timerTickHandle = null; }
      if(timerPollHandle){ clearInterval(timerPollHandle); timerPollHandle = null; }
      if(periodRolloverIntervalHandle){ clearInterval(periodRolloverIntervalHandle); periodRolloverIntervalHandle = null; }
      if(homeSortable){ homeSortable.destroy(); homeSortable = null; }
      closeActivityForm();
      closeGoalForm();
      closeVacationForm();
      hideToast();
      closeAssignModal();
      closeStopModal();
      releaseKeepAwake();
      document.getElementById('appShell').hidden = true;
      document.getElementById('screen-signin').hidden = false;
    }
  });

})();
