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

  // scheduleRule: null means "active every week". The one rule type built so
  // far is { type: "firstFullWeekOfMonth" }; more types can be added later
  // by extending weekMatchesScheduleRule without touching this shape.
  //
  // Note: older activity docs may still carry a minSessionMinutes field from
  // the retired countdown-then-count-up timer. Nothing reads or writes it
  // anymore; it's left in Firestore untouched until the user decides whether
  // to clean it up.
  const SEED_ACTIVITIES = [
    { name: 'Video ideas & notes',       cadence: 'daily',   goalMinutes: 90, scheduleRule: null },
    { name: 'Video recording & editing', cadence: 'daily',   goalMinutes: 90, scheduleRule: null },
    { name: 'Newsletter',                cadence: 'weekly',  goalMinutes: 60, scheduleRule: null },
    { name: 'ASMR Healing',              cadence: 'weekly',  goalMinutes: 60, scheduleRule: null },
    { name: 'Story',                     cadence: 'weekly',  goalMinutes: 60, scheduleRule: null },
    { name: 'Household needs',           cadence: 'weekly',  goalMinutes: 60, scheduleRule: null },
    { name: 'Learning',                  cadence: 'weekly',  goalMinutes: 60, scheduleRule: null },
    { name: 'Budget',                    cadence: 'monthly', goalMinutes: 60, scheduleRule: null },
    { name: 'Budget Review',             cadence: 'weekly',  goalMinutes: 60, scheduleRule: { type: 'firstFullWeekOfMonth' } },
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
    SEED_ACTIVITIES.forEach((a, idx) => {
      const ref = activitiesCol(uid).doc();
      batch.set(ref, {
        name: a.name,
        cadence: a.cadence,
        goalMinutes: a.goalMinutes,
        scheduleRule: a.scheduleRule,
        sortOrder: idx,
        active: true,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
  }

  // Adds "Budget Review" to accounts that already existed before this
  // feature shipped (seedActivitiesIfEmpty only fires for brand-new,
  // fully-empty accounts). Matches by name, so it's safe to call every
  // sign-in without duplicating the row. sortOrder: Date.now() lands it
  // after any small-integer sortOrder without needing a count query.
  async function ensureBudgetReviewSeeded(uid){
    const seed = SEED_ACTIVITIES.find(a => a.name === 'Budget Review');
    const snap = await activitiesCol(uid).where('name', '==', seed.name).limit(1).get();
    if(!snap.empty) return;
    await activitiesCol(uid).add({
      name: seed.name,
      cadence: seed.cadence,
      goalMinutes: seed.goalMinutes,
      scheduleRule: seed.scheduleRule,
      sortOrder: Date.now(),
      active: true,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  // One-time migration for activities created before drag-reordering
  // existed: assigns sortOrder based on the old cadence+name sort, so
  // nothing visually jumps the first time this runs. No-ops forever after,
  // once every activity has a real sortOrder.
  async function backfillSortOrderIfNeeded(uid, docs){
    if(!docs.some(d => typeof d.sortOrder !== 'number')) return;
    const ordered = [...docs].sort((a, b) =>
      CADENCE_ORDER[a.cadence] - CADENCE_ORDER[b.cadence] || a.name.localeCompare(b.name));
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

  function fmtHours(goalMinutes){
    const hrs = goalMinutes / 60;
    return (hrs % 1 === 0 ? hrs : hrs.toFixed(2).replace(/0+$/,'').replace(/\.$/,''));
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

  function goalLabel(goalMinutes, cadence){
    const per = cadence === 'daily' ? 'day' : cadence === 'weekly' ? 'week' : 'month';
    return `${fmtDuration(goalMinutes)} / ${per}`;
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
    const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const lastDayNum = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
    const monthEnd = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(lastDayNum).padStart(2,'0')}`;
    return {
      today: dateToStr(now),
      weekStart: dateToStr(monday),
      weekEnd: dateToStr(sunday),
      monthStart, monthEnd,
      daysLeftInWeek: 7 - dowMonBased,
      daysLeftInMonth: lastDayNum - now.getDate() + 1,
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
    renderHomeActivities();
    renderHomePlan(); // the rolling day list shifts/refills as the day changes
    if(currentPage === 'history') renderHistoryPage();
  }
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) checkForPeriodRollover(); });

  function periodLabel(cadence){
    return cadence === 'daily' ? 'today' : cadence === 'weekly' ? 'this week' : 'this month';
  }

  function loggedMinutesFor(activityId, cadence){
    const b = periodBounds;
    const start = cadence === 'daily' ? b.today : cadence === 'weekly' ? b.weekStart : b.monthStart;
    const end = cadence === 'daily' ? b.today : cadence === 'weekly' ? b.weekEnd : b.monthEnd;
    return periodEntries
      .filter(e => e.activityId === activityId && e.date >= start && e.date <= end)
      .reduce((sum, e) => sum + e.durationMinutes, 0);
  }

  // ---------- scheduled weekly activities ----------
  // A weekly activity can carry a scheduleRule limiting which week(s) it's
  // active in. null = every week. Add new rule types as new `case`s in
  // weekMatchesScheduleRule — the activity doc shape doesn't need to change.
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
        return true; // unrecognized rule types stay visible rather than silently vanishing
    }
  }

  function isActivityVisibleThisWeek(activity){
    if(activity.cadence !== 'weekly' || !activity.scheduleRule) return true;
    const weekStartDate = new Date(periodBounds.weekStart + 'T00:00:00');
    return weekMatchesScheduleRule(activity.scheduleRule, weekStartDate);
  }

  function scheduleRuleLabel(rule){
    if(rule.type === 'firstFullWeekOfMonth') return 'Only in the first full week of the month';
    return 'Scheduled';
  }

  // ---------- shared activity state ----------
  let currentUid = null;
  let activities = [];        // kept in sync via onSnapshot
  let unsubscribeActivities = null;
  const CADENCE_ORDER = { daily: 0, weekly: 1, monthly: 2 };

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
    const visible = sortedActivities().filter(isActivityVisibleThisWeek);
    visible.forEach(a => {
      const logged = loggedMinutesFor(a.id, a.cadence);
      const pct = Math.min(100, Math.round(logged / a.goalMinutes * 100));
      const done = logged >= a.goalMinutes;
      const isDouble = logged >= a.goalMinutes * 2;
      const fillClass = isDouble ? ' is-over' : done ? ' is-full' : '';
      const li = document.createElement('li');
      li.className = 'activity-item home-activity-item';
      li.dataset.id = a.id;
      li.innerHTML = `
        <div class="activity-item-top">
          <div>
            <div class="name">${escapeHtml(a.name)}</div>
            <div class="meta">${fmtDuration(logged)} / ${fmtDuration(a.goalMinutes)} ${periodLabel(a.cadence)}${done ? ' ✓' : ''}</div>
          </div>
          <div class="home-row-right">
            <button class="btn-pill-icon timer-row-btn" data-id="${a.id}" type="button"${activeTimer ? ' disabled' : ''}>▶ Timer</button>
            <div class="drag-handle" title="Drag to reorder">⠿</div>
          </div>
        </div>
        <div class="progress-track"><div class="progress-fill${fillClass}" style="width:${pct}%"></div></div>
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

  document.getElementById('homeActivityList').addEventListener('click', async (e)=>{
    const btn = e.target.closest('.timer-row-btn');
    if(!btn || btn.disabled || !currentUid || activeTimer) return;
    try{
      await metaDoc(currentUid, 'activeTimer').set(newTimerDoc(btn.dataset.id));
    }catch(err){
      console.error('start timer failed', err);
      alert('Could not start timer — see console.');
    }
  });

  // ---------- PAGE: ACTIVITIES (management — shows every activity,
  // regardless of this week's scheduled visibility) ----------
  function renderActivitiesPage(){
    const list = document.getElementById('activityList');
    list.innerHTML = '';
    sortedActivities().forEach(a => {
      const li = document.createElement('li');
      li.className = 'activity-item';
      const scheduleNote = a.scheduleRule
        ? `<div class="schedule-note">${escapeHtml(scheduleRuleLabel(a.scheduleRule))}</div>` : '';
      li.innerHTML = `
        <div class="activity-item-top">
          <div>
            <div class="name">${escapeHtml(a.name)}</div>
            <div class="meta">${goalLabel(a.goalMinutes, a.cadence)}</div>
            ${scheduleNote}
          </div>
          <div class="item-right">
            <span class="cadence-tag ${a.cadence}">${a.cadence}</span>
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
        renderHomeActivities();
        renderActivitiesPage();
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
  const formCadenceEl = document.getElementById('formCadence');
  const formGoalHoursEl = document.getElementById('formGoalHours');
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
      formCadenceEl.value = activity.cadence;
      formGoalHoursEl.value = fmtHours(activity.goalMinutes);
    } else {
      formIdEl.value = '';
      formNameEl.value = '';
      formCadenceEl.value = 'daily';
      formGoalHoursEl.value = '';
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
    const cadence = formCadenceEl.value;
    const goalHours = parseFloat(formGoalHoursEl.value);
    if(!name){ setFormError('Name is required.'); return; }
    if(!goalHours || goalHours <= 0){ setFormError('Goal must be a positive number of hours.'); return; }

    const goalMinutes = Math.round(goalHours * 60);
    const id = formIdEl.value;
    const saveBtn = document.getElementById('formSaveBtn');
    saveBtn.disabled = true;
    try{
      if(id){
        await activitiesCol(currentUid).doc(id).update({ name, cadence, goalMinutes });
      } else {
        await activitiesCol(currentUid).add({
          name, cadence, goalMinutes, active: true, scheduleRule: null, sortOrder: Date.now(),
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
    const earliest = periodBounds.weekStart < periodBounds.monthStart ? periodBounds.weekStart : periodBounds.monthStart;
    unsubscribePeriodEntries = timeEntriesCol(uid).where('date', '>=', earliest).onSnapshot(
      snap => {
        periodEntries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderHomeActivities();
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

  function weekAppliesToActivity(activity, weekMondayStr, createdWeekStr){
    if(createdWeekStr && weekMondayStr < createdWeekStr) return false;
    if(activity.cadence !== 'weekly' || !activity.scheduleRule) return true;
    return weekMatchesScheduleRule(activity.scheduleRule, new Date(weekMondayStr + 'T00:00:00'));
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
      const applicableWeeks = weekMondays.filter(w => weekAppliesToActivity(a, w, createdWeekStr));
      const totals = applicableWeeks.map(w => weekTotalMinutes(a.id, w));
      const high = totals.length ? Math.max(...totals) : null;
      const low = totals.length ? Math.min(...totals) : null;
      const avg = totals.length ? Math.round(totals.reduce((s, x) => s + x, 0) / totals.length) : null;

      html += `<tr><td class="hist-activity-col">${escapeHtml(a.name)}</td>`;
      html += `<td>${high === null ? '–' : fmtDuration(high)}</td><td>${low === null ? '–' : fmtDuration(low)}</td><td>${avg === null ? '–' : fmtDuration(avg)}</td>`;
      weekMondays.forEach(w => {
        if(!weekAppliesToActivity(a, w, createdWeekStr)){ html += '<td class="hist-na">–</td>'; return; }
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

  function isTimerStale(activity, activeMs){
    return !!activity && activeMs > activity.goalMinutes * 60000 * 2;
  }

  function tickTimerBanner(){
    if(!activeTimer) return;
    const now = Date.now();
    const paused = timerStatus(activeTimer) === 'paused';
    const activeMs = timerActiveMs(activeTimer, now);
    const activity = activities.find(a => a.id === activeTimer.activityId);

    timerElapsedEl.textContent = fmtHMS(activeMs);
    if(paused){
      timerPausedLineEl.textContent = `Paused for ${fmtElapsed(now - (activeTimer.pausedAt ?? now))}`;
    }

    const stale = !paused && isTimerStale(activity, activeMs);
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
    renderHomeActivities(); // per-row Timer buttons enable/disable with activeTimer
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
    const activity = activities.find(a => a.id === activeTimer.activityId);
    stopModalSummaryEl.textContent =
      `${activityName(activeTimer.activityId)} — started ${fmt12h(msToHHMM(activeTimer.startTime))}, ${fmtElapsed(activeMs)} active.`;
    stopModalWarningEl.hidden = !isTimerStale(activity, activeMs);
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

  // ---------- page navigation ----------
  const PAGES = ['home', 'activities', 'planner', 'logtime', 'history', 'settings'];
  let currentPage = 'home';
  let pendingLogTimePreset = null;

  function showPage(page){
    if(!PAGES.includes(page)) page = 'home';
    currentPage = page;
    PAGES.forEach(p => { document.getElementById('page-' + p).hidden = (p !== page); });
    document.querySelectorAll('.nav-btn, .nav-icon-btn').forEach(b => b.classList.toggle('is-active', b.dataset.page === page));
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
      startSchedulesListener(user.uid);
      startSettingsListener(user.uid);
      periodRolloverIntervalHandle = setInterval(checkForPeriodRollover, 60 * 1000);

      (async ()=>{
        try{
          await seedActivitiesIfEmpty(user.uid);
          await ensureBudgetReviewSeeded(user.uid); // sequenced after: avoids racing a duplicate write on brand-new accounts
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
      editingScheduleId = null;
      currentSettings = {};
      if(unsubscribeActivities){ unsubscribeActivities(); unsubscribeActivities = null; }
      if(unsubscribeTimeEntries){ unsubscribeTimeEntries(); unsubscribeTimeEntries = null; }
      if(unsubscribePeriodEntries){ unsubscribePeriodEntries(); unsubscribePeriodEntries = null; }
      if(unsubscribeAllEntries){ unsubscribeAllEntries(); unsubscribeAllEntries = null; }
      if(unsubscribeTimer){ unsubscribeTimer(); unsubscribeTimer = null; }
      if(unsubscribeSchedules){ unsubscribeSchedules(); unsubscribeSchedules = null; }
      if(unsubscribeSettings){ unsubscribeSettings(); unsubscribeSettings = null; }
      if(timerTickHandle){ clearInterval(timerTickHandle); timerTickHandle = null; }
      if(timerPollHandle){ clearInterval(timerPollHandle); timerPollHandle = null; }
      if(periodRolloverIntervalHandle){ clearInterval(periodRolloverIntervalHandle); periodRolloverIntervalHandle = null; }
      if(homeSortable){ homeSortable.destroy(); homeSortable = null; }
      closeActivityForm();
      closeAssignModal();
      closeStopModal();
      document.getElementById('appShell').hidden = true;
      document.getElementById('screen-signin').hidden = false;
    }
  });

})();
