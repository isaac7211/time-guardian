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

  const SEED_ACTIVITIES = [
    { name: 'Video ideas & notes',       cadence: 'daily',   goalMinutes: 90 },
    { name: 'Video recording & editing', cadence: 'daily',   goalMinutes: 90 },
    { name: 'Newsletter',                cadence: 'weekly',  goalMinutes: 60 },
    { name: 'ASMR Healing',              cadence: 'weekly',  goalMinutes: 60 },
    { name: 'Story',                     cadence: 'weekly',  goalMinutes: 60 },
    { name: 'Household needs',           cadence: 'weekly',  goalMinutes: 60 },
    { name: 'Learning',                  cadence: 'weekly',  goalMinutes: 60 },
    { name: 'Budget',                    cadence: 'monthly', goalMinutes: 60 },
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
    SEED_ACTIVITIES.forEach(a => {
      const ref = activitiesCol(uid).doc();
      batch.set(ref, {
        name: a.name,
        cadence: a.cadence,
        goalMinutes: a.goalMinutes,
        active: true,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
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
    const monthWord = b.daysLeftInMonth === 1 ? 'day' : 'days';
    document.getElementById('homeRemaining').textContent =
      `${b.daysLeftInWeek} ${weekWord} left this week · ${b.daysLeftInMonth} ${monthWord} left this month`;
  }

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

  // ---------- activities: live list + render ----------
  let currentUid = null;
  let activities = [];        // kept in sync via onSnapshot, used for edit-form lookups
  let unsubscribeActivities = null;

  const CADENCE_ORDER = { daily: 0, weekly: 1, monthly: 2 };

  function renderActivities(){
    const list = document.getElementById('activityList');
    list.innerHTML = '';
    const sorted = [...activities].sort((a, b) =>
      CADENCE_ORDER[a.cadence] - CADENCE_ORDER[b.cadence] || a.name.localeCompare(b.name));
    sorted.forEach(a => {
      const logged = loggedMinutesFor(a.id, a.cadence);
      const pct = Math.min(100, Math.round(logged / a.goalMinutes * 100));
      const done = logged >= a.goalMinutes;
      const isDouble = logged >= a.goalMinutes * 2; // well past the goal, not just a few minutes over
      const fillClass = isDouble ? ' is-over' : done ? ' is-full' : '';
      const li = document.createElement('li');
      li.className = 'activity-item';
      li.innerHTML = `
        <div class="activity-item-top">
          <div>
            <div class="name">${escapeHtml(a.name)}</div>
            <div class="meta">${logged} / ${a.goalMinutes} min ${periodLabel(a.cadence)}${done ? ' ✓' : ''}</div>
          </div>
          <div class="item-right">
            <span class="cadence-tag ${a.cadence}">${a.cadence}</span>
            <div class="item-actions">
              <button class="icon-btn edit-btn" data-id="${a.id}" title="Edit" type="button">✎</button>
              <button class="icon-btn danger delete-btn" data-id="${a.id}" title="Delete" type="button">✕</button>
            </div>
          </div>
        </div>
        <div class="progress-track"><div class="progress-fill${fillClass}" style="width:${pct}%"></div></div>
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
        renderActivities();
        populateActivitySelect(document.getElementById('logActivityId'));
        populateActivitySelect(document.getElementById('timerActivityId'));
        renderTimerBanner(); // activity names/goal may have changed
      },
      err => {
        console.error('activities listener failed', err);
        showConnectionError('Firestore connection failed — see console.');
      }
    );
  }

  function populateActivitySelect(sel){
    const prevValue = sel.value;
    sel.innerHTML = activities.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
    if(activities.some(a => a.id === prevValue)) sel.value = prevValue;
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
          name, cadence, goalMinutes, active: true,
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

  // ---------- time entries: live list + render ----------
  // Most-recently-created 15 entries — a confirmation feed for this build
  // step, not the full per-activity history (that's the detail view, later).
  let timeEntries = [];
  let unsubscribeTimeEntries = null;

  function activityName(activityId){
    const a = activities.find(x => x.id === activityId);
    return a ? a.name : '(deleted activity)';
  }

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
      const when = e.startTime && e.endTime
        ? `${fmt12h(e.startTime)}–${fmt12h(e.endTime)}`
        : `${e.durationMinutes} min`;
      li.innerHTML = `
        <div>
          <div class="name">${escapeHtml(activityName(e.activityId))}</div>
          <div class="meta">${e.date} · ${e.weekday} · ${when} · ${e.durationMinutes} min</div>
        </div>
        <span class="source-tag">${e.source}</span>
      `;
      list.appendChild(li);
    });
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
        renderActivities();
      },
      err => console.error('period entries listener failed', err)
    );
  }

  // ---------- log time form ----------
  const logFormEl = document.getElementById('logTimeForm');
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

  function openLogTimeForm(presetActivityId){
    setLogFormError(null);
    setLogMode('duration');
    logDurationEl.value = '';
    logStartTimeEl.value = nowTimeStr();
    logEndTimeEl.value = nowTimeStr();
    logDateEl.value = todayDateStr();
    if(presetActivityId && activities.some(a => a.id === presetActivityId)) logActivityEl.value = presetActivityId;
    else if(activities.length) logActivityEl.value = activities[0].id;
    logFormEl.hidden = false;
  }
  function closeLogTimeForm(){
    logFormEl.hidden = true;
    setLogFormError(null);
  }

  document.getElementById('logTimeBtn').addEventListener('click', openLogTimeForm);
  document.getElementById('logCancelBtn').addEventListener('click', closeLogTimeForm);

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

    const saveBtn = document.getElementById('logSaveBtn');
    saveBtn.disabled = true;
    try{
      await timeEntriesCol(currentUid).add({
        activityId,
        date,
        weekday: weekdayFromDateStr(date),
        startTime, endTime,
        durationMinutes,
        source: 'manual',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      closeLogTimeForm();
    }catch(err){
      console.error('save time entry failed', err);
      setLogFormError('Save failed — see console.');
    }finally{
      saveBtn.disabled = false;
    }
  });

  // ---------- timer: shared state across devices ----------
  // users/{uid}/meta/activeTimer is a single doc; its absence means no
  // timer is running. Every signed-in device subscribes to it, so starting
  // on the phone shows the banner on the laptop within a snapshot round trip.
  let activeTimer = null;   // { activityId, startTime(ms) } | null
  let unsubscribeTimer = null;
  let timerTickHandle = null;

  const timerBannerEl = document.getElementById('timerBanner');
  const timerStartPanelEl = document.getElementById('timerStartPanel');
  const timerActivityNameEl = document.getElementById('timerActivityName');
  const timerStartedLabelEl = document.getElementById('timerStartedLabel');
  const timerElapsedEl = document.getElementById('timerElapsed');
  const timerWarningEl = document.getElementById('timerWarning');
  const timerActivitySelectEl = document.getElementById('timerActivityId');

  function isTimerStale(activity, elapsedMs){
    return !!activity && elapsedMs > activity.goalMinutes * 60000 * 2;
  }

  function tickTimerBanner(){
    if(!activeTimer) return;
    const elapsedMs = Date.now() - activeTimer.startTime;
    timerElapsedEl.textContent = fmtElapsed(elapsedMs);
    const activity = activities.find(a => a.id === activeTimer.activityId);
    const stale = isTimerStale(activity, elapsedMs);
    timerWarningEl.hidden = !stale;
    timerBannerEl.classList.toggle('is-stale', stale);
  }

  function renderTimerBanner(){
    if(activeTimer){
      timerStartPanelEl.hidden = true;
      timerBannerEl.hidden = false;
      timerActivityNameEl.textContent = activityName(activeTimer.activityId);
      timerStartedLabelEl.textContent = `started ${fmt12h(msToHHMM(activeTimer.startTime))}`;
      tickTimerBanner();
      if(!timerTickHandle) timerTickHandle = setInterval(tickTimerBanner, 1000);
    } else {
      timerStartPanelEl.hidden = false;
      timerBannerEl.hidden = true;
      if(timerTickHandle){ clearInterval(timerTickHandle); timerTickHandle = null; }
    }
  }

  function startTimerListener(uid){
    if(unsubscribeTimer) unsubscribeTimer();
    unsubscribeTimer = metaDoc(uid, 'activeTimer').onSnapshot(
      snap => {
        activeTimer = snap.exists ? snap.data() : null;
        renderTimerBanner();
      },
      err => console.error('timer listener failed', err)
    );
  }

  document.getElementById('startTimerBtn').addEventListener('click', async ()=>{
    if(!currentUid || !activities.length) return;
    try{
      await metaDoc(currentUid, 'activeTimer').set({
        activityId: timerActivitySelectEl.value,
        startTime: Date.now(),
      });
    }catch(err){
      console.error('start timer failed', err);
      alert('Could not start timer — see console.');
    }
  });

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
    const elapsedMs = Date.now() - activeTimer.startTime;
    const activity = activities.find(a => a.id === activeTimer.activityId);
    stopModalSummaryEl.textContent =
      `${activityName(activeTimer.activityId)} — started ${fmt12h(msToHHMM(activeTimer.startTime))}, ${fmtElapsed(elapsedMs)} elapsed.`;
    stopModalWarningEl.hidden = !isTimerStale(activity, elapsedMs);
    stopEditEndTimeEl.value = nowTimeStr();
    showStopChoice();
    stopModalEl.hidden = false;
  }
  function closeStopModal(){ stopModalEl.hidden = true; }

  document.getElementById('stopTimerBtn').addEventListener('click', openStopModal);

  async function finalizeTimerEntry(endMs){
    const { activityId, startTime } = activeTimer;
    await timeEntriesCol(currentUid).add({
      activityId,
      date: msToDateStr(startTime),
      weekday: weekdayFromDateStr(msToDateStr(startTime)),
      startTime: msToHHMM(startTime),
      endTime: msToHHMM(endMs),
      durationMinutes: Math.round((endMs - startTime) / 60000),
      source: 'timer',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await metaDoc(currentUid, 'activeTimer').delete();
  }

  document.getElementById('stopKeepBtn').addEventListener('click', async ()=>{
    if(!activeTimer) return;
    try{
      await finalizeTimerEntry(Date.now());
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
    try{
      await finalizeTimerEntry(endMs);
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
      openLogTimeForm(activityId);
    }catch(err){
      console.error('discard timer failed', err);
      alert('Could not discard — see console.');
    }
  });

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
      try{
        await seedActivitiesIfEmpty(user.uid);
        await ensureSettingsDoc(user.uid);
        startActivitiesListener(user.uid);
        startTimeEntriesListener(user.uid);
        startPeriodEntriesListener(user.uid);
        startTimerListener(user.uid);
      }catch(e){
        console.error('Firestore check failed', e);
        showConnectionError('Firestore connection failed — see console.');
      }
    } else {
      currentUid = null;
      activities = [];
      timeEntries = [];
      periodEntries = [];
      activeTimer = null;
      if(unsubscribeActivities){ unsubscribeActivities(); unsubscribeActivities = null; }
      if(unsubscribeTimeEntries){ unsubscribeTimeEntries(); unsubscribeTimeEntries = null; }
      if(unsubscribePeriodEntries){ unsubscribePeriodEntries(); unsubscribePeriodEntries = null; }
      if(unsubscribeTimer){ unsubscribeTimer(); unsubscribeTimer = null; }
      if(timerTickHandle){ clearInterval(timerTickHandle); timerTickHandle = null; }
      closeActivityForm();
      closeLogTimeForm();
      closeStopModal();
      document.getElementById('appShell').hidden = true;
      document.getElementById('screen-signin').hidden = false;
    }
  });

})();
