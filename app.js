const STORAGE_KEY = "timeflow.goals.v1";
const REMINDER_KEY = "timeflow.reminders.v1";
const TARGET_KEY = "timeflow.targets.v1";
const SEED_KEY = "timeflow.seeded.v1";
const PREFS_KEY = "timeflow.prefs.v1";

const Importance = {
  VERY_IMPORTANT: { id: "VERY_IMPORTANT", label: "Very important", weight: 3, color: "red" },
  IMPORTANT: { id: "IMPORTANT", label: "Important", weight: 2, color: "orange" },
  NOT_SO_IMPORTANT: { id: "NOT_SO_IMPORTANT", label: "Not so important", weight: 1, color: "blue" },
};

const Urgency = {
  VERY_URGENT: { id: "VERY_URGENT", label: "Very urgent", weight: 3 },
  URGENT: { id: "URGENT", label: "Urgent", weight: 2 },
  NOT_SO_URGENT: { id: "NOT_SO_URGENT", label: "Not so urgent", weight: 1 },
};

const Period = {
  DAY: { id: "DAY", label: "Day" },
  WEEK: { id: "WEEK", label: "Week" },
  MONTH: { id: "MONTH", label: "Month" },
  YEAR: { id: "YEAR", label: "Year" },
};

const DURATION_PRESETS = [5, 15, 30, 45, 60, 90, 120];
const TIMER_PRESETS = [1, 5, 10, 15, 30, 60];
const FREQ_PRESETS = {
  DAY: [1, 2, 3, 4, 5],
  WEEK: [1, 2, 3, 4, 5, 6, 7],
  MONTH: [1, 2, 4, 8, 12, 15, 30],
  YEAR: [1, 2, 4, 6, 12],
};
const WEEKDAYS = [
  { id: 1, label: "Mon" },
  { id: 2, label: "Tue" },
  { id: 3, label: "Wed" },
  { id: 4, label: "Thu" },
  { id: 5, label: "Fri" },
  { id: 6, label: "Sat" },
  { id: 0, label: "Sun" },
];
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

function uid() {
  return crypto.randomUUID();
}

function loadGoals() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveGoals(goals) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(goals));
}

function loadReminders() {
  try {
    const raw = localStorage.getItem(REMINDER_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveReminders(reminders) {
  localStorage.setItem(REMINDER_KEY, JSON.stringify(reminders));
}

function loadTargets() {
  try {
    const raw = localStorage.getItem(TARGET_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTargets(targets) {
  localStorage.setItem(TARGET_KEY, JSON.stringify(targets));
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const p = raw ? JSON.parse(raw) : {};
    const notifications = ["off", "soft", "full"].includes(p.notifications)
      ? p.notifications
      : "soft";
    return { notifications };
  } catch {
    return { notifications: "soft" };
  }
}

function savePrefs(prefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

function getNotificationMode() {
  return state.prefs?.notifications || "soft";
}

function setNotificationMode(mode) {
  state.prefs = { ...state.prefs, notifications: mode };
  savePrefs(state.prefs);
  if (mode === "off") {
    clearNativeReminders();
    clearNativeTimers();
  } else {
    syncNativeReminders();
    syncNativeTimers();
    if (mode !== "off") ensureNotificationPermission();
  }
  render();
}

/** Monday-based local week / calendar day / month / year starts */
function startOfPeriod(period, from = new Date()) {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  if (period === "DAY") return d.getTime();
  if (period === "WEEK") {
    const day = d.getDay();
    const diff = day === 0 ? 6 : day - 1;
    d.setDate(d.getDate() - diff);
    return d.getTime();
  }
  if (period === "MONTH") {
    d.setDate(1);
    return d.getTime();
  }
  d.setMonth(0, 1);
  return d.getTime();
}

function nextPeriodStart(period, periodStart) {
  const d = new Date(periodStart);
  if (period === "DAY") d.setDate(d.getDate() + 1);
  else if (period === "WEEK") d.setDate(d.getDate() + 7);
  else if (period === "MONTH") d.setMonth(d.getMonth() + 1);
  else d.setFullYear(d.getFullYear() + 1);
  return d.getTime();
}

function ensureTargetPeriod(target, now = Date.now()) {
  const start = startOfPeriod(target.period, new Date(now));
  if (target.periodStart !== start) {
    return {
      ...target,
      periodStart: start,
      completionsInPeriod: 0,
      completedForPeriod: false,
      updatedAt: now,
    };
  }
  return target;
}

function isTargetCompletedForPeriod(target) {
  if (!target) return false;
  return target.completionsInPeriod >= target.frequency;
}

function refreshAllTargets(targets, now = Date.now()) {
  let changed = false;
  const next = targets.map((t) => {
    const refreshed = ensureTargetPeriod(t, now);
    if (refreshed !== t && refreshed.periodStart !== t.periodStart) changed = true;
    if (refreshed.completionsInPeriod !== t.completionsInPeriod) changed = true;
    return refreshed;
  });
  return { targets: next, changed };
}

function goalUrgencyWeight(goal, now = Date.now()) {
  if (goal.scheduling.type === "URGENCY") {
    return Urgency[goal.scheduling.urgency].weight;
  }
  const remaining = goal.scheduling.deadlineEpochMillis - now;
  const day = 24 * 60 * 60 * 1000;
  if (remaining < 0 || remaining <= day) return 3;
  if (remaining <= 7 * day) return 2;
  return 1;
}

function targetUrgencyWeight(target, now = Date.now()) {
  const t = ensureTargetPeriod(target, now);
  const remaining = t.frequency - t.completionsInPeriod;
  if (remaining <= 0) return 0;
  const start = t.periodStart;
  const end = nextPeriodStart(t.period, start);
  const elapsed = Math.min(1, Math.max(0, (now - start) / (end - start)));
  const expectedDone = t.frequency * elapsed;
  const behind = expectedDone - t.completionsInPeriod;
  if (behind >= 1 || (elapsed > 0.75 && remaining > 0)) return 3;
  if (behind >= 0.25 || remaining >= Math.ceil(t.frequency / 2)) return 2;
  return 1;
}

function importanceWeight(importanceId) {
  return Importance[importanceId]?.weight || 1;
}

/** score = urgency × importance (1–9) */
function scoreGoal(goal, now = Date.now()) {
  return goalUrgencyWeight(goal, now) * importanceWeight(goal.importance);
}

function scoreTarget(target, now = Date.now()) {
  return targetUrgencyWeight(target, now) * importanceWeight(target.importance);
}

function goalToPackItem(goal, now = Date.now()) {
  return {
    kind: "goal",
    id: `goal:${goal.id}`,
    sourceId: goal.id,
    title: goal.title,
    estimatedMinutes: goal.estimatedMinutes,
    importance: goal.importance,
    scheduling: goal.scheduling,
    createdAt: goal.createdAt,
    urgencyWeight: goalUrgencyWeight(goal, now),
    score: scoreGoal(goal, now),
  };
}

function targetToPackItem(target, now = Date.now()) {
  const t = ensureTargetPeriod(target, now);
  return {
    kind: "target",
    id: `target:${t.id}`,
    sourceId: t.id,
    title: t.title,
    estimatedMinutes: t.estimatedMinutes,
    importance: t.importance,
    period: t.period,
    frequency: t.frequency,
    completionsInPeriod: t.completionsInPeriod,
    createdAt: t.createdAt,
    urgencyWeight: targetUrgencyWeight(t, now),
    score: scoreTarget(t, now),
  };
}

function availableTargets(targets, now = Date.now()) {
  return targets
    .map((t) => ensureTargetPeriod(t, now))
    .filter((t) => !t.paused && t.completionsInPeriod < t.frequency);
}

function packTasks(goals, targets, freeMinutes, now = Date.now()) {
  const goalItems = goals
    .filter((g) => g.status === "PENDING" || g.status === "OVERDUE")
    .map((g) => goalToPackItem(g, now));
  const targetItems = availableTargets(targets, now).map((t) => targetToPackItem(t, now));

  const candidates = [...goalItems, ...targetItems].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.estimatedMinutes !== b.estimatedMinutes) return a.estimatedMinutes - b.estimatedMinutes;
    return a.createdAt - b.createdAt;
  });

  const selected = [];
  let remaining = freeMinutes;
  for (const item of candidates) {
    if (item.estimatedMinutes <= remaining) {
      selected.push(item);
      remaining -= item.estimatedMinutes;
    }
    if (remaining <= 0) break;
  }
  return selected;
}

function packItemLabel(item) {
  if (item.kind === "sprint") {
    return `Sprint · ${formatMinutes(item.estimatedMinutes)}`;
  }
  if (item.kind === "target") {
    return `Target · ${Period[item.period].label} ${item.completionsInPeriod}/${item.frequency} · ${formatMinutes(item.estimatedMinutes)} · score ${item.score}`;
  }
  return `${schedulingLabel({ scheduling: item.scheduling })} · ${formatMinutes(item.estimatedMinutes)} · score ${item.score}`;
}

function formatMinutes(mins) {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function schedulingLabel(goal) {
  if (goal.scheduling.type === "URGENCY") {
    return Urgency[goal.scheduling.urgency].label;
  }
  const d = new Date(goal.scheduling.deadlineEpochMillis);
  return `Due ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}${
    d.getHours() || d.getMinutes()
      ? ` ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
      : ""
  }`;
}

function createSeedGoals() {
  const now = Date.now();
  return [
    {
      id: uid(),
      title: "Reply to landlord email",
      notes: null,
      importance: "VERY_IMPORTANT",
      scheduling: { type: "URGENCY", urgency: "VERY_URGENT" },
      estimatedMinutes: 15,
      status: "PENDING",
      createdAt: now - 100000,
      updatedAt: now - 100000,
      completedAt: null,
    },
    {
      id: uid(),
      title: "Grocery run",
      notes: null,
      importance: "IMPORTANT",
      scheduling: { type: "DEADLINE", deadlineEpochMillis: now + 6 * 60 * 60 * 1000 },
      estimatedMinutes: 30,
      status: "PENDING",
      createdAt: now - 90000,
      updatedAt: now - 90000,
      completedAt: null,
    },
    {
      id: uid(),
      title: "Tidy desk",
      notes: null,
      importance: "NOT_SO_IMPORTANT",
      scheduling: { type: "URGENCY", urgency: "NOT_SO_URGENT" },
      estimatedMinutes: 10,
      status: "PENDING",
      createdAt: now - 80000,
      updatedAt: now - 80000,
      completedAt: null,
    },
  ];
}

const state = {
  screen: "home",
  goals: loadGoals(),
  reminders: loadReminders(),
  targets: loadTargets(),
  wizard: null,
  remind: null,
  targetWizard: null,
  freeMinutes: 45,
  packed: [],
  sprintItems: [],
  sprintDraft: null,
  session: null,
  tickHandle: null,
  reminderPoll: null,
  now: Date.now(),
  calendarView: "month",
  calendarCursor: Date.now(),
  returnScreen: null,
  itemDetail: null,
  dialog: null,
  prefs: loadPrefs(),
  quickCapture: false,
  completeFlash: null,
};

{
  const refreshed = refreshAllTargets(state.targets);
  if (refreshed.changed) {
    state.targets = refreshed.targets;
    saveTargets(state.targets);
  }
}

if (!state.goals.length && !localStorage.getItem(SEED_KEY)) {
  state.goals = createSeedGoals();
  saveGoals(state.goals);
  localStorage.setItem(SEED_KEY, "1");
} else if (!localStorage.getItem(SEED_KEY)) {
  localStorage.setItem(SEED_KEY, "1");
}

const app = document.getElementById("app");

function setGoals(next) {
  state.goals = next;
  saveGoals(next);
}

function setReminders(next) {
  state.reminders = next;
  saveReminders(next);
  syncNativeReminders();
}

function setTargets(next) {
  state.targets = next;
  saveTargets(next);
}

function androidBridge() {
  return typeof window !== "undefined" && window.TimeFlowAndroid ? window.TimeFlowAndroid : null;
}

function notificationsSupported() {
  return Boolean(androidBridge()) || ("Notification" in window);
}

function hasNotificationPermission() {
  const bridge = androidBridge();
  if (bridge) {
    try {
      return bridge.hasNotificationPermission();
    } catch {
      return false;
    }
  }
  return "Notification" in window && Notification.permission === "granted";
}

async function ensureNotificationPermission() {
  const bridge = androidBridge();
  if (bridge) {
    try {
      if (bridge.hasNotificationPermission()) return true;
      if (typeof bridge.requestNotificationPermission === "function") {
        bridge.requestNotificationPermission();
      }
      return false;
    } catch {
      // fall through
    }
  }
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

window.onAndroidNotificationPermissionResult = (granted) => {
  if (granted) {
    syncNativeReminders();
    syncNativeTimers();
  }
  render();
};

function syncNativeReminders() {
  const bridge = androidBridge();
  if (!bridge) return;
  try {
    if (getNotificationMode() === "off") {
      bridge.syncReminders(JSON.stringify([]));
      return;
    }
    const payload = state.reminders
      .filter((r) => r.status === "SCHEDULED" && r.triggerAt && r.triggerAt > Date.now())
      .map((r) => ({ id: r.id, title: r.title, triggerAt: r.triggerAt }));
    bridge.syncReminders(JSON.stringify(payload));
  } catch {
    // ignore
  }
}

function clearNativeReminders() {
  const bridge = androidBridge();
  if (!bridge) return;
  try {
    bridge.syncReminders(JSON.stringify([]));
  } catch {
    // ignore
  }
}

const recentNotifications = new Map();

function playAlertSound(mode = getNotificationMode()) {
  if (mode === "off") return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const volume = mode === "soft" ? 0.14 : 0.22;
    const playTone = (freq, start, dur) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(volume, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.02);
    };
    playTone(880, 0, 0.16);
    playTone(1175, 0.2, 0.2);
    setTimeout(() => {
      try {
        ctx.close();
      } catch {
        // ignore
      }
    }, 600);
  } catch {
    // ignore — sound is best-effort
  }
}

function fireAppNotification({ heading, body, tag }) {
  const mode = getNotificationMode();
  if (mode === "off") return;

  const key = tag || body;
  const now = Date.now();
  if (recentNotifications.get(key) && now - recentNotifications.get(key) < 3000) return;
  recentNotifications.set(key, now);

  playAlertSound(mode);
  const soft = mode === "soft";

  const bridge = androidBridge();
  if (bridge) {
    try {
      if (bridge.hasNotificationPermission()) {
        if (soft && typeof bridge.showNotificationSoft === "function") {
          bridge.showNotificationSoft(heading, body);
        } else {
          bridge.showNotification(heading, body);
        }
      }
      return;
    } catch {
      // fall through
    }
  }

  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(heading, {
        body,
        tag: tag || `timeflow-${now}`,
        requireInteraction: !soft,
        silent: false,
      });
      n.onclick = () => {
        window.focus();
        go("home");
        n.close();
      };
      return;
    } catch {
      // fall through
    }
  }

  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: "APP_NOTIFICATION",
      heading,
      body,
      tag: tag || `timeflow-${now}`,
      soft,
    });
  }
}

function fireReminderNotification(reminder) {
  fireAppNotification({
    heading: "Time Flow — Remind me",
    body: reminder.title,
    tag: `reminder-${reminder.id}`,
  });
}

function fireTimeUpNotification(title, tag) {
  fireAppNotification({
    heading: "Time Flow — Time's up",
    body: title,
    tag: tag || `timer-${Date.now()}`,
  });
}

function syncNativeTimers() {
  const bridge = androidBridge();
  if (!bridge) return;
  try {
    const session = state.session;
    if (getNotificationMode() === "off" || !session || session.paused) {
      bridge.syncTimers(JSON.stringify([]));
      return;
    }
    const now = Date.now();
    const timers = [];
    const current = session.queue[session.index];
    if (current && session.taskLeft > 0) {
      timers.push({
        id: `task-${session.index}`,
        title: current.title,
        triggerAt: now + session.taskLeft * 1000,
        heading: "Time Flow — Time's up",
      });
    }
    if (session.sessionLeft > 0) {
      timers.push({
        id: "session-end",
        title: session.mode === "sprint" ? "Sprint finished" : "Focus session finished",
        triggerAt: now + session.sessionLeft * 1000,
        heading: "Time Flow — Time's up",
      });
    }
    bridge.syncTimers(JSON.stringify(timers));
  } catch {
    // ignore
  }
}

function clearNativeTimers() {
  const bridge = androidBridge();
  if (!bridge) return;
  try {
    bridge.syncTimers(JSON.stringify([]));
  } catch {
    // ignore
  }
}

function checkReminders() {
  state.now = Date.now();
  let changed = false;
  const next = state.reminders.map((r) => {
    // Completed repeating reminders renew when the next occurrence arrives
    if (
      r.mode === "REPEAT" &&
      r.status === "COMPLETED" &&
      r.triggerAt &&
      r.triggerAt <= state.now
    ) {
      changed = true;
      if (!r.notified) fireReminderNotification(r);
      return {
        ...r,
        status: "DUE",
        notified: true,
        completedAt: null,
        updatedAt: state.now,
      };
    }
    if (r.status === "SCHEDULED" && r.triggerAt <= state.now) {
      changed = true;
      if (!r.notified) fireReminderNotification(r);
      return { ...r, status: "DUE", notified: true, updatedAt: state.now };
    }
    return r;
  });
  if (changed) {
    setReminders(next);
    if (state.screen === "home" || state.screen === "reminders" || state.screen === "calendar") {
      render();
    }
  } else if (state.screen === "home" || state.screen === "remind" || state.screen === "reminders") {
    // refresh countdowns on home without full rebuild every second only for scheduled timers
    const hasLive = state.reminders.some((r) => r.status === "SCHEDULED");
    if (hasLive && state.screen === "home") render();
  }
}

function startReminderPoll() {
  if (state.reminderPoll) return;
  state.reminderPoll = setInterval(checkReminders, 1000);
  checkReminders();
}

function go(screen, extra = {}) {
  Object.assign(state, extra, { screen });
  render();
}

function stopTick() {
  if (state.tickHandle) {
    clearInterval(state.tickHandle);
    state.tickHandle = null;
  }
}

function startTick() {
  stopTick();
  state.tickHandle = setInterval(() => {
    if (!state.session || state.session.paused) return;
    state.session.sessionLeft = Math.max(0, state.session.sessionLeft - 1);
    state.session.taskLeft = Math.max(0, state.session.taskLeft - 1);

    if (state.session.taskLeft === 0) {
      const current = state.session.queue[state.session.index];
      if (current && !androidBridge()) {
        fireTimeUpNotification(current.title, `task-${state.session.index}`);
      }
      autoAdvance("auto");
      return;
    }
    if (state.session.sessionLeft === 0) {
      if (!androidBridge()) {
        fireTimeUpNotification(
          state.session.mode === "sprint" ? "Sprint finished" : "Focus session finished",
          "session-end"
        );
      }
      endSession();
      return;
    }
    render();
  }, 1000);
}

function autoAdvance(reason) {
  const session = state.session;
  if (!session) return;
  const current = session.queue[session.index];
  if (current && reason === "auto") {
    session.completed.push(current.id);
  }
  const nextIndex = session.index + 1;
  if (nextIndex >= session.queue.length || session.sessionLeft <= 0) {
    endSession();
    return;
  }
  session.index = nextIndex;
  const next = session.queue[nextIndex];
  session.taskTotal = next.estimatedMinutes * 60;
  session.taskLeft = session.taskTotal;
  syncNativeTimers();
  render();
}

function endSession() {
  stopTick();
  clearNativeTimers();
  const session = state.session;
  if (!session) return;
  const now = Date.now();
  const completedIds = new Set(session.completed);
  const isSprint = session.mode === "sprint";

  // Sprint tasks are temporary — never write to goals / targets / calendar
  if (!isSprint) {
    setGoals(
      state.goals.map((g) =>
        completedIds.has(`goal:${g.id}`) || completedIds.has(g.id)
          ? { ...g, status: "COMPLETED", completedAt: now, updatedAt: now }
          : g
      )
    );

    let targets = state.targets.map((t) => ensureTargetPeriod(t, now));
    targets = targets.map((t) => {
      if (completedIds.has(`target:${t.id}`)) {
        const next = Math.min(t.frequency, t.completionsInPeriod + 1);
        return {
          ...t,
          completionsInPeriod: next,
          completedForPeriod: next >= t.frequency,
          updatedAt: now,
        };
      }
      return t;
    });
    setTargets(targets);
  } else {
    state.sprintItems = [];
    state.sprintDraft = null;
  }

  state.summary = {
    mode: isSprint ? "sprint" : "freetime",
    completed: session.completed.length,
    skipped: session.skipped.length,
    total: session.queue.length,
    usedSeconds: session.totalSeconds - session.sessionLeft,
  };
  state.session = null;
  go("summary");
}

function completeTarget(id) {
  const now = Date.now();
  let nextTargets = state.targets.map((t) => {
    if (t.id !== id) return ensureTargetPeriod(t, now);
    const cur = ensureTargetPeriod(t, now);
    if (cur.completionsInPeriod >= cur.frequency) return cur;
    const next = cur.completionsInPeriod + 1;
    return {
      ...cur,
      completionsInPeriod: next,
      completedForPeriod: next >= cur.frequency,
      updatedAt: now,
    };
  });
  setTargets(nextTargets);
  const updated = nextTargets.find((t) => t.id === id);
  if (updated && updated.completionsInPeriod >= updated.frequency) {
    state.packed = state.packed.filter((p) => !(p.kind === "target" && p.sourceId === id));
  }
  render();
}

function deleteTarget(id) {
  setTargets(state.targets.filter((t) => t.id !== id));
  render();
}

function openTargetWizard(existing = null) {
  if (existing) {
    const t = ensureTargetPeriod(existing);
    state.targetWizard = {
      step: 1,
      id: t.id,
      title: t.title,
      importance: t.importance,
      estimatedMinutes: t.estimatedMinutes,
      period: t.period,
      frequency: t.frequency,
    };
  } else {
    state.targetWizard = {
      step: 1,
      id: null,
      title: "",
      importance: null,
      estimatedMinutes: 30,
      period: null,
      frequency: 1,
    };
  }
  go("targetWizard");
}

function saveTargetFromWizard() {
  const w = state.targetWizard;
  const now = Date.now();
  const periodStart = startOfPeriod(w.period, new Date(now));
  if (w.id) {
    setTargets(
      state.targets.map((t) =>
        t.id === w.id
          ? {
              ...t,
              title: w.title.trim(),
              importance: w.importance,
              estimatedMinutes: w.estimatedMinutes,
              period: w.period,
              frequency: w.frequency,
              periodStart,
              // keep completions if same period type continuing; reset if period kind changed
              completionsInPeriod: t.period === w.period ? t.completionsInPeriod : 0,
              completedForPeriod:
                t.period === w.period
                  ? t.completionsInPeriod >= w.frequency
                    ? Boolean(t.completedForPeriod)
                    : false
                  : false,
              updatedAt: now,
            }
          : t
      )
    );
  } else {
    setTargets([
      {
        id: uid(),
        title: w.title.trim(),
        importance: w.importance,
        estimatedMinutes: w.estimatedMinutes,
        period: w.period,
        frequency: w.frequency,
        periodStart,
        completionsInPeriod: 0,
        completedForPeriod: false,
        createdAt: now,
        updatedAt: now,
      },
      ...state.targets,
    ]);
  }
  state.targetWizard = null;
  finishWizard("targets");
}

function closeDialog() {
  state.dialog = null;
  render();
}

function showAlert(message, { title = "Time Flow", okLabel = "OK" } = {}) {
  state.dialog = {
    kind: "alert",
    title,
    message,
    okLabel,
  };
  render();
}

function showConfirm(
  message,
  onConfirm,
  {
    title = "Time Flow",
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    danger = false,
  } = {}
) {
  state.dialog = {
    kind: "confirm",
    title,
    message,
    confirmLabel,
    cancelLabel,
    danger,
    onConfirm,
  };
  render();
}

function renderDialog() {
  const d = state.dialog;
  if (!d) return null;

  const dismiss = () => closeDialog();
  const actions =
    d.kind === "confirm"
      ? [
          el("button", {
            className: "btn btn-ghost btn-block btn-touch",
            type: "button",
            text: d.cancelLabel || "Cancel",
            onClick: dismiss,
          }),
          el("button", {
            className: `btn ${d.danger ? "btn-danger-solid" : "btn-primary"} btn-block btn-touch`,
            type: "button",
            text: d.confirmLabel || "Confirm",
            onClick: () => {
              const fn = d.onConfirm;
              state.dialog = null;
              if (typeof fn === "function") fn();
              else render();
            },
          }),
        ]
      : [
          el("button", {
            className: "btn btn-primary btn-block btn-touch",
            type: "button",
            text: d.okLabel || "OK",
            onClick: dismiss,
          }),
        ];

  return el(
    "div",
    {
      className: "dialog-backdrop",
      role: "presentation",
      onClick: (e) => {
        if (e.target === e.currentTarget) dismiss();
      },
    },
    [
      el(
        "div",
        {
          className: "dialog-card",
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "dialog-title",
        },
        [
          el("h2", { id: "dialog-title", className: "dialog-title", text: d.title || "Time Flow" }),
          el("p", { className: "dialog-message", text: d.message || "" }),
          el("div", { className: "dialog-actions" }, actions),
        ]
      ),
    ]
  );
}

function render() {
  const map = {
    home: renderHome,
    calendar: renderCalendar,
    wizard: renderWizard,
    remind: renderRemind,
    reminders: renderReminders,
    targetWizard: renderTargetWizard,
    targets: renderTargets,
    goals: renderGoals,
    freetime: renderFreeTime,
    arrange: renderArrange,
    sprint: renderSprint,
    sprintArrange: renderSprintArrange,
    focus: renderFocus,
    summary: renderSummary,
    itemDetail: renderItemDetail,
    alerts: renderAlerts,
  };
  app.innerHTML = "";
  const root = map[state.screen]();
  if (state.session && state.screen !== "focus" && state.screen !== "summary") {
    root.classList.add("shell-with-sticky");
  }
  app.appendChild(root);
  const sticky = renderStickySession();
  if (sticky) app.appendChild(sticky);
  const flash = renderCompleteFlash();
  if (flash) app.appendChild(flash);
  const dialog = renderDialog();
  if (dialog) app.appendChild(dialog);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** Soft keyboards often lack Enter — keep Enter when available, always show a Next button. */
function wireGoKey(input, onGo) {
  input.setAttribute("enterkeyhint", "go");
  if (!input.getAttribute("inputmode")) {
    input.setAttribute("inputmode", input.type === "number" ? "numeric" : "text");
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onGo();
    }
  });
}

function nextButton(label, onClick) {
  return el("button", {
    className: "btn btn-primary btn-block btn-touch",
    type: "button",
    text: label,
    onClick,
  });
}

function shell(children) {
  return el("div", { className: "shell" }, children);
}

function flashComplete() {
  state.completeFlash = Date.now();
  setTimeout(() => {
    if (!state.completeFlash) return;
    state.completeFlash = null;
    render();
  }, 750);
}

function renderCompleteFlash() {
  if (!state.completeFlash) return null;
  return el("div", { className: "complete-flash", "aria-live": "polite" }, [
    el("div", { className: "complete-flash-mark", text: "✓" }),
  ]);
}

function renderStickySession() {
  if (!state.session || state.screen === "focus" || state.screen === "summary") return null;
  const session = state.session;
  const current = session.queue[session.index];
  const isSprint = session.mode === "sprint";
  return el("div", { className: "sticky-session", role: "status" }, [
    el(
      "button",
      {
        className: "sticky-session-main",
        type: "button",
        onClick: () => go("focus"),
      },
      [
        el("span", {
          className: "sticky-session-label",
          text: session.paused ? "Paused" : isSprint ? "Sprint" : "In focus",
        }),
        el("span", {
          className: "sticky-session-title",
          text: current?.title || "Session",
        }),
        el("span", {
          className: "sticky-session-time",
          text: formatClock(session.taskLeft),
        }),
      ]
    ),
    el("button", {
      className: "sticky-session-pause",
      type: "button",
      title: session.paused ? "Resume" : "Pause",
      "aria-label": session.paused ? "Resume" : "Pause",
      text: session.paused ? "▶" : "❚❚",
      onClick: (e) => {
        e.stopPropagation();
        session.paused = !session.paused;
        syncNativeTimers();
        render();
      },
    }),
  ]);
}

function renderAlerts() {
  const mode = getNotificationMode();
  const options = [
    {
      id: "off",
      label: "Off",
      hint: "No sound or push alerts. Lists and timers still work in the app.",
    },
    {
      id: "soft",
      label: "Soft",
      hint: "Gentle sound + notification. Less sticky, lighter vibration.",
    },
    {
      id: "full",
      label: "Full",
      hint: "Louder cue and stronger vibration when time is up.",
    },
  ];
  return shell([
    el("button", { className: "nav-back", text: "← Home", onClick: () => go("home") }),
    el("div", { className: "panel stack" }, [
      el("h2", { text: "Alerts" }),
      el("p", {
        className: "meta",
        text: "You can turn alerts off anytime — your lists still work.",
      }),
      ...options.map((opt) =>
        el(
          "button",
          {
            className: `choice ${mode === opt.id ? "selected" : ""}`,
            onClick: () => setNotificationMode(opt.id),
          },
          [
            el("span", { className: "label", text: opt.label }),
            el("span", { className: "hint", text: opt.hint }),
          ]
        )
      ),
      mode !== "off" &&
      notificationsSupported() &&
      !hasNotificationPermission()
        ? el("button", {
            className: "btn btn-primary btn-block",
            text: "Enable device notifications",
            onClick: () => ensureNotificationPermission().then(() => render()),
          })
        : null,
    ]),
  ]);
}

function quickStartTimer(minutes) {
  const now = Date.now();
  setReminders([
    {
      id: uid(),
      createdAt: now,
      title: `${minutes}-minute timer`,
      mode: "TIMER",
      timerMinutes: minutes,
      repeat: null,
      triggerAt: now + minutes * 60 * 1000,
      status: "SCHEDULED",
      notified: false,
      updatedAt: now,
      completedAt: null,
    },
    ...state.reminders,
  ]);
  if (getNotificationMode() !== "off") ensureNotificationPermission();
  showAlert(`${minutes}-minute timer is running.`, { title: "Timer started", okLabel: "Got it" });
}

function quickCaptureGoal(title) {
  const trimmed = (title || "").trim();
  if (!trimmed) {
    showAlert("Name the goal first.");
    return;
  }
  const now = Date.now();
  setGoals([
    {
      id: uid(),
      title: trimmed,
      notes: null,
      importance: "IMPORTANT",
      scheduling: { type: "URGENCY", urgency: "NOT_SO_URGENT" },
      estimatedMinutes: 25,
      status: "PENDING",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    },
    ...state.goals,
  ]);
  state.quickCapture = false;
  flashComplete();
  render();
}

function startFreeTimeWindow(minutes) {
  state.freeMinutes = minutes;
  const packed = packTasks(state.goals, state.targets, minutes);
  if (!packed.length) {
    showAlert("Nothing fits that window. Add a shorter goal or target first.");
    return;
  }
  state.packed = packed;
  state.arrangeAddOpen = false;
  state.editingPackId = null;
  go("arrange");
}

function pauseTarget(id) {
  const now = Date.now();
  setTargets(
    state.targets.map((t) =>
      t.id === id ? { ...ensureTargetPeriod(t, now), paused: true, updatedAt: now } : t
    )
  );
  state.packed = state.packed.filter((p) => !(p.kind === "target" && p.sourceId === id));
  if (state.screen === "itemDetail") closeItemDetail();
  else render();
}

function resumeTarget(id) {
  const now = Date.now();
  setTargets(
    state.targets.map((t) =>
      t.id === id ? { ...ensureTargetPeriod(t, now), paused: false, updatedAt: now } : t
    )
  );
  if (state.screen === "itemDetail") closeItemDetail();
  else render();
}

function activeGoals() {
  return state.goals.filter((g) => g.status === "PENDING" || g.status === "OVERDUE");
}

function dueReminders() {
  return state.reminders.filter((r) => r.status === "DUE");
}

function scheduledReminders() {
  return state.reminders
    .filter((r) => r.status === "SCHEDULED")
    .slice()
    .sort((a, b) => a.triggerAt - b.triggerAt);
}

function parseTimeParts(timeStr) {
  const [h, m] = (timeStr || "09:00").split(":").map(Number);
  return { hours: h || 0, minutes: m || 0 };
}

function nextWeeklyTrigger(weekdays, timeStr, from = Date.now()) {
  const { hours, minutes } = parseTimeParts(timeStr);
  const days = new Set(weekdays);
  for (let i = 0; i < 8; i++) {
    const d = new Date(from);
    d.setSeconds(0, 0);
    d.setDate(d.getDate() + i);
    d.setHours(hours, minutes, 0, 0);
    if (days.has(d.getDay()) && d.getTime() > from) return d.getTime();
  }
  return from + 7 * 24 * 60 * 60 * 1000;
}

function nextMonthlyTrigger(monthDays, timeStr, from = Date.now()) {
  const { hours, minutes } = parseTimeParts(timeStr);
  const days = [...monthDays].sort((a, b) => a - b);
  const start = new Date(from);
  for (let monthOffset = 0; monthOffset < 14; monthOffset++) {
    const year = start.getFullYear();
    const month = start.getMonth() + monthOffset;
    for (const day of days) {
      const d = new Date(year, month, day, hours, minutes, 0, 0);
      if (d.getDate() !== day) continue; // e.g. Feb 31 invalid
      if (d.getTime() > from) return d.getTime();
    }
  }
  return from + 30 * 24 * 60 * 60 * 1000;
}

function nextTriggerForReminder(reminder, from = Date.now()) {
  if (reminder.mode === "REPEAT" && reminder.repeat?.cadence === "WEEKLY") {
    return nextWeeklyTrigger(reminder.repeat.weekdays || [], reminder.repeat.time || "09:00", from);
  }
  if (reminder.mode === "REPEAT" && reminder.repeat?.cadence === "MONTHLY") {
    return nextMonthlyTrigger(reminder.repeat.monthDays || [], reminder.repeat.time || "09:00", from);
  }
  return null;
}

function computeTriggerFromWizard(w, now = Date.now()) {
  if (w.mode === "DATETIME") return new Date(w.datetimeLocal).getTime();
  if (w.mode === "TIMER") return now + w.timerMinutes * 60 * 1000;
  if (w.mode === "REPEAT" && w.repeatCadence === "WEEKLY") {
    return nextWeeklyTrigger(w.weekdays, w.repeatTime, now);
  }
  if (w.mode === "REPEAT" && w.repeatCadence === "MONTHLY") {
    return nextMonthlyTrigger(w.monthDays, w.repeatTime, now);
  }
  return null;
}

function formatRepeatSummary(reminder) {
  if (reminder.mode !== "REPEAT" || !reminder.repeat) return null;
  const time = reminder.repeat.time || "09:00";
  if (reminder.repeat.cadence === "WEEKLY") {
    const labels = WEEKDAYS.filter((d) => (reminder.repeat.weekdays || []).includes(d.id))
      .map((d) => d.label)
      .join(", ");
    return `Weekly · ${labels || "—"} · ${time}`;
  }
  const days = [...(reminder.repeat.monthDays || [])].sort((a, b) => a - b).join(", ");
  return `Monthly · day ${days || "—"} · ${time}`;
}

function formatTrigger(reminder, now = Date.now()) {
  if (reminder.status === "DUE") return "Due now";
  if (reminder.status === "COMPLETED") {
    const renew = reminder.triggerAt
      ? new Date(reminder.triggerAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : null;
    if (reminder.mode === "REPEAT" && renew) return `Completed · renews ${renew}`;
    return "Completed";
  }
  const left = Math.max(0, reminder.triggerAt - now);
  if (reminder.mode === "TIMER" && left < 24 * 60 * 60 * 1000) {
    return `in ${formatClock(Math.ceil(left / 1000))}`;
  }
  const d = new Date(reminder.triggerAt);
  const when = d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const repeat = formatRepeatSummary(reminder);
  return repeat ? `${repeat} · next ${when}` : when;
}

function toDatetimeLocal(epochMillis) {
  const d = new Date(epochMillis);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openGoalWizard(existing = null) {
  if (existing) {
    const isDeadline = existing.scheduling.type === "DEADLINE";
    state.wizard = {
      step: 1,
      id: existing.id,
      title: existing.title,
      notes: existing.notes || "",
      importance: existing.importance,
      mode: isDeadline ? "DEADLINE" : "URGENCY",
      urgency: isDeadline ? null : existing.scheduling.urgency,
      deadlineLocal: isDeadline ? toDatetimeLocal(existing.scheduling.deadlineEpochMillis) : "",
      estimatedMinutes: existing.estimatedMinutes,
      createdAt: existing.createdAt,
      status: existing.status,
      completedAt: existing.completedAt,
    };
  } else {
    state.wizard = {
      step: 1,
      id: null,
      title: "",
      notes: "",
      importance: null,
      mode: null,
      urgency: null,
      deadlineLocal: "",
      estimatedMinutes: 30,
      createdAt: null,
      status: "PENDING",
      completedAt: null,
    };
  }
  go("wizard");
}

function saveGoalFromWizard() {
  const w = state.wizard;
  const now = Date.now();
  const scheduling =
    w.mode === "DEADLINE"
      ? { type: "DEADLINE", deadlineEpochMillis: new Date(w.deadlineLocal).getTime() }
      : { type: "URGENCY", urgency: w.urgency };

  if (w.id) {
    setGoals(
      state.goals.map((g) =>
        g.id === w.id
          ? {
              ...g,
              title: w.title.trim(),
              notes: (w.notes || "").trim() || null,
              importance: w.importance,
              scheduling,
              estimatedMinutes: w.estimatedMinutes,
              updatedAt: now,
            }
          : g
      )
    );
  } else {
    setGoals([
      {
        id: uid(),
        title: w.title.trim(),
        notes: (w.notes || "").trim() || null,
        importance: w.importance,
        scheduling,
        estimatedMinutes: w.estimatedMinutes,
        status: "PENDING",
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      },
      ...state.goals,
    ]);
  }
  state.wizard = null;
  finishWizard("home");
}

function trySaveRepeatReminder() {
  const w = state.remind;
  if (w.mode !== "REPEAT" || !w.repeatCadence || !w.repeatTime) return false;
  if (w.repeatCadence === "WEEKLY" && !w.weekdays.length) return false;
  if (w.repeatCadence === "MONTHLY" && !w.monthDays.length) return false;
  saveReminderFromWizard();
  return true;
}

function openRemindWizard({ existing = null, reschedule = false } = {}) {
  const r = existing?.repeat;
  let datetimeLocal = "";
  if (existing?.mode === "DATETIME" && existing.triggerAt) {
    datetimeLocal = toDatetimeLocal(existing.triggerAt);
  }
  state.remind = {
    step: reschedule && existing ? 2 : 1,
    id: existing?.id || null,
    title: existing?.title || "",
    mode: null,
    datetimeLocal,
    timerMinutes: existing?.timerMinutes || 10,
    repeatCadence: null,
    weekdays: r?.weekdays ? [...r.weekdays] : [],
    monthDays: r?.monthDays ? [...r.monthDays] : [],
    repeatTime: r?.time || "09:00",
  };
  // Prefill mode when editing/rescheduling so Back still works; selection still auto-saves
  if (existing && reschedule) {
    state.remind.mode = existing.mode;
    state.remind.repeatCadence = r?.cadence || null;
  }
  go("remind");
}

function completeReminder(id) {
  const now = Date.now();
  setReminders(
    state.reminders.map((r) => {
      if (r.id !== id) return r;
      if (r.mode === "REPEAT") {
        // Mark done until the next occurrence; then checkReminders renews it
        const anchor = r.triggerAt != null ? Math.max(now, r.triggerAt) : now;
        const nextAt = nextTriggerForReminder(r, anchor);
        return {
          ...r,
          status: "COMPLETED",
          triggerAt: nextAt,
          notified: false,
          updatedAt: now,
          completedAt: now,
        };
      }
      return { ...r, status: "COMPLETED", completedAt: now, updatedAt: now };
    })
  );
  render();
}

function deleteReminder(id) {
  setReminders(state.reminders.filter((r) => r.id !== id));
  render();
}

function completeGoal(id) {
  const now = Date.now();
  setGoals(
    state.goals.map((g) =>
      g.id === id
        ? { ...g, status: "COMPLETED", completedAt: now, updatedAt: now }
        : g
    )
  );
  state.packed = state.packed.filter((p) => !(p.kind === "goal" && p.sourceId === id));
  render();
}

function deleteGoal(id) {
  setGoals(state.goals.filter((g) => g.id !== id));
  state.packed = state.packed.filter((p) => !(p.kind === "goal" && p.sourceId === id));
  render();
}

function getEntity(kind, id) {
  if (kind === "goal") return state.goals.find((g) => g.id === id) || null;
  if (kind === "reminder") return state.reminders.find((r) => r.id === id) || null;
  if (kind === "target") {
    const t = state.targets.find((x) => x.id === id);
    return t ? ensureTargetPeriod(t) : null;
  }
  return null;
}

function canCompleteEntity(kind, entity) {
  if (!entity) return false;
  if (kind === "goal") {
    return entity.status === "PENDING" || entity.status === "OVERDUE" || entity.status === "IN_PROGRESS";
  }
  if (kind === "reminder") return entity.status !== "COMPLETED";
  if (kind === "target") return !entity.paused && entity.completionsInPeriod < entity.frequency;
  return false;
}

function canUncompleteEntity(kind, entity) {
  if (!entity) return false;
  if (kind === "goal" || kind === "reminder") return entity.status === "COMPLETED";
  if (kind === "target") return entity.completionsInPeriod >= entity.frequency;
  return false;
}

function uncompleteGoal(id) {
  const now = Date.now();
  setGoals(
    state.goals.map((g) =>
      g.id === id ? { ...g, status: "PENDING", completedAt: null, updatedAt: now } : g
    )
  );
}

function uncompleteReminder(id) {
  const now = Date.now();
  setReminders(
    state.reminders.map((r) => {
      if (r.id !== id) return r;
      const status = r.triggerAt && r.triggerAt <= now ? "DUE" : "SCHEDULED";
      return { ...r, status, completedAt: null, notified: false, updatedAt: now };
    })
  );
}

function uncompleteTarget(id) {
  const now = Date.now();
  setTargets(
    state.targets.map((t) => {
      if (t.id !== id) return ensureTargetPeriod(t, now);
      const cur = ensureTargetPeriod(t, now);
      // Reset period progress so they start the quota again
      return {
        ...cur,
        completionsInPeriod: 0,
        completedForPeriod: false,
        updatedAt: now,
      };
    })
  );
}

function completeEntity(kind, id) {
  flashComplete();
  if (kind === "goal") completeGoal(id);
  else if (kind === "reminder") completeReminder(id);
  else if (kind === "target") completeTarget(id);
  if (state.itemDetail && state.itemDetail.kind === kind && state.itemDetail.id === id) {
    if (state.screen === "itemDetail") closeItemDetail();
  }
}

function uncompleteEntity(kind, id) {
  if (kind === "goal") uncompleteGoal(id);
  else if (kind === "reminder") uncompleteReminder(id);
  else if (kind === "target") uncompleteTarget(id);
  if (state.screen === "itemDetail") closeItemDetail();
  else render();
}

function editEntity(kind, id) {
  const entity = getEntity(kind, id);
  if (!entity) return;
  state.returnScreen = state.screen === "itemDetail" ? "itemDetail" : state.screen;
  if (kind === "goal") openGoalWizard(entity);
  else if (kind === "reminder") openRemindWizard({ existing: entity });
  else if (kind === "target") openTargetWizard(entity);
}

function deleteEntity(kind, id) {
  showConfirm(
    "Delete this permanently? This can’t be undone.",
    () => {
      if (kind === "goal") deleteGoal(id);
      else if (kind === "reminder") deleteReminder(id);
      else if (kind === "target") {
        state.packed = state.packed.filter((p) => !(p.kind === "target" && p.sourceId === id));
        deleteTarget(id);
      }
      if (state.screen === "itemDetail") closeItemDetail();
      else render();
    },
    {
      title: "Delete",
      confirmLabel: "Delete",
      cancelLabel: "Keep it",
      danger: true,
    }
  );
}

function openItemDetail(kind, id) {
  const from = state.screen === "itemDetail" ? state.itemDetail?.from || "home" : state.screen;
  state.itemDetail = { kind, id, from };
  go("itemDetail");
}

function closeItemDetail() {
  const back = state.itemDetail?.from || "home";
  state.itemDetail = null;
  go(back === "itemDetail" ? "home" : back);
}

function renderItemDetail() {
  const detail = state.itemDetail;
  if (!detail) {
    return shell([
      el("p", { className: "empty", text: "Nothing selected." }),
      el("button", {
        className: "btn btn-primary btn-block",
        text: "Back",
        onClick: () => closeItemDetail(),
      }),
    ]);
  }

  const { kind, id } = detail;
  const entity = getEntity(kind, id);
  if (!entity) {
    return shell([
      el("p", { className: "empty", text: "This item was removed." }),
      el("button", {
        className: "btn btn-primary btn-block",
        text: "Back",
        onClick: () => closeItemDetail(),
      }),
    ]);
  }

  let title = entity.title;
  let meta = "";
  let tone = "blue";

  if (kind === "goal") {
    const imp = Importance[entity.importance];
    tone = imp.color;
    meta = `${schedulingLabel(entity)} · ${formatMinutes(entity.estimatedMinutes)} · score ${scoreGoal(entity)} · ${entity.status}`;
  } else if (kind === "reminder") {
    tone = entity.status === "COMPLETED" ? "done" : entity.status === "DUE" ? "red" : "orange";
    meta = `${entity.mode === "TIMER" ? "Timer" : entity.mode === "REPEAT" ? "Repeat" : "At"} · ${formatTrigger(entity)} · ${entity.status}`;
  } else if (kind === "target") {
    const t = ensureTargetPeriod(entity);
    const imp = Importance[t.importance];
    tone = t.paused ? "blue" : imp.color;
    title = `◎ ${t.title}`;
    meta = t.paused
      ? `Paused · ${Period[t.period].label} · ${t.completionsInPeriod}/${t.frequency}`
      : `${Period[t.period].label} · ${t.completionsInPeriod}/${t.frequency} · ${formatMinutes(t.estimatedMinutes)} · score ${scoreTarget(t)}`;
  }

  return shell([
    el("button", {
      className: "nav-back",
      text: "← Back",
      onClick: () => closeItemDetail(),
    }),
    el("div", { className: "panel stack" }, [
      el("p", {
        className: "step-meta",
        text: kind === "goal" ? "Goal" : kind === "reminder" ? "Reminder" : "Target",
      }),
      el("h2", {}, [el("span", { className: `dot ${tone}` }), title]),
      el("p", { className: "meta", text: meta }),
      el("div", { className: "item-actions item-actions-stack" }, [
        canCompleteEntity(kind, entity)
          ? el("button", {
              className: "btn btn-primary btn-block",
              text: "Complete",
              onClick: () => completeEntity(kind, id),
            })
          : null,
        canUncompleteEntity(kind, entity)
          ? el("button", {
              className: "btn btn-primary btn-block",
              text: "Uncomplete",
              onClick: () => uncompleteEntity(kind, id),
            })
          : null,
        kind === "target" && !entity.paused
          ? el("button", {
              className: "btn btn-ghost btn-block",
              text: "Pause target",
              onClick: () => pauseTarget(id),
            })
          : null,
        kind === "target" && entity.paused
          ? el("button", {
              className: "btn btn-primary btn-block",
              text: "Resume target",
              onClick: () => resumeTarget(id),
            })
          : null,
        el("button", {
          className: "btn btn-ghost btn-block",
          text: "Edit",
          onClick: () => editEntity(kind, id),
        }),
        el("button", {
          className: "btn btn-danger btn-block",
          text: "Delete",
          onClick: () => deleteEntity(kind, id),
        }),
      ]),
    ]),
  ]);
}

function finishWizard(defaultScreen = "home") {
  const back = state.returnScreen || defaultScreen;
  state.returnScreen = null;
  const allowed = new Set([
    "home",
    "calendar",
    "goals",
    "reminders",
    "targets",
    "freetime",
    "arrange",
    "itemDetail",
  ]);
  go(allowed.has(back) ? back : defaultScreen);
}

function renderItemActions(
  kind,
  id,
  { complete = true, edit = true, remove = true, uncomplete = false } = {}
) {
  const entity = getEntity(kind, id);
  if (!entity) return null;
  const showComplete = complete && canCompleteEntity(kind, entity);
  const showUncomplete = uncomplete && canUncompleteEntity(kind, entity);
  if (!showComplete && !showUncomplete && !edit && !remove) return null;
  return el("div", { className: "item-actions" }, [
    showComplete
      ? el("button", {
          className: "btn btn-primary",
          text: "Complete",
          onClick: (e) => {
            e.stopPropagation();
            completeEntity(kind, id);
          },
        })
      : null,
    showUncomplete
      ? el("button", {
          className: "btn btn-primary",
          text: "Uncomplete",
          onClick: (e) => {
            e.stopPropagation();
            uncompleteEntity(kind, id);
          },
        })
      : null,
    edit
      ? el("button", {
          className: "btn btn-ghost",
          text: "Edit",
          onClick: (e) => {
            e.stopPropagation();
            editEntity(kind, id);
          },
        })
      : null,
    remove
      ? el("button", {
          className: "btn btn-danger",
          text: "Delete",
          onClick: (e) => {
            e.stopPropagation();
            deleteEntity(kind, id);
          },
        })
      : null,
  ]);
}

function renderEntityCard({
  kind,
  id,
  title,
  meta,
  tone,
  muted = false,
  actions = { complete: true, edit: true, remove: true },
  openOnClick = false,
}) {
  return el(
    "div",
    {
      className: `goal-card entity-card ${muted ? "is-muted" : ""} ${openOnClick ? "is-clickable" : ""}`,
      onClick: openOnClick
        ? (e) => {
            if (e.target.closest("button")) return;
            openItemDetail(kind, id);
          }
        : undefined,
    },
    [
      el("div", { style: "flex:1;min-width:0" }, [
        el("p", { className: "goal-title" }, [
          tone ? el("span", { className: `dot ${tone}` }) : null,
          title,
        ]),
        meta ? el("p", { className: "meta", text: meta }) : null,
      ]),
      renderItemActions(kind, id, actions),
    ]
  );
}

function buildReminderPayload(w, now) {
  const triggerAt = computeTriggerFromWizard(w, now);
  const base = {
    title: w.title.trim(),
    mode: w.mode,
    timerMinutes: w.mode === "TIMER" ? w.timerMinutes : null,
    repeat:
      w.mode === "REPEAT"
        ? {
            cadence: w.repeatCadence,
            weekdays: w.repeatCadence === "WEEKLY" ? [...w.weekdays].sort((a, b) => a - b) : [],
            monthDays: w.repeatCadence === "MONTHLY" ? [...w.monthDays].sort((a, b) => a - b) : [],
            time: w.repeatTime || "09:00",
          }
        : null,
    triggerAt,
    status: "SCHEDULED",
    notified: false,
    updatedAt: now,
    completedAt: null,
  };
  return base;
}

function saveReminderFromWizard() {
  const w = state.remind;
  const now = Date.now();
  const payload = buildReminderPayload(w, now);

  if (w.id) {
    setReminders(
      state.reminders.map((r) => (r.id === w.id ? { ...r, ...payload } : r))
    );
  } else {
    setReminders([{ id: uid(), createdAt: now, ...payload }, ...state.reminders]);
  }
  state.remind = null;
  if (getNotificationMode() !== "off") ensureNotificationPermission();
  finishWizard("home");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function dayKeyFromDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dayKeyFromMs(ms) {
  return dayKeyFromDate(new Date(ms));
}

function startOfLocalDay(ms = Date.now()) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addLocalDays(ms, days) {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function startOfLocalWeek(ms = Date.now()) {
  return startOfPeriod("WEEK", new Date(ms));
}

function startOfLocalMonth(ms = Date.now()) {
  return startOfPeriod("MONTH", new Date(ms));
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function eachDay(fromMs, toMsExclusive) {
  const out = [];
  for (let t = startOfLocalDay(fromMs); t < toMsExclusive; t = addLocalDays(t, 1)) {
    out.push(t);
  }
  return out;
}

function applyTimeOnDay(dayMs, timeStr) {
  const { hours, minutes } = parseTimeParts(timeStr);
  const d = new Date(dayMs);
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
}

/**
 * Build calendar entries for [rangeStart, rangeEnd).
 * Free-time sessions and urgency-only goals are excluded.
 * Completed goals / one-shot reminders / period-done targets are excluded.
 * Completed repeating reminders show a muted “renews” chip on the next occurrence day.
 */
function buildCalendarEvents(rangeStart, rangeEnd) {
  const events = [];
  const now = Date.now();
  const todayStart = startOfLocalDay(now);

  // Keep target period roll-overs persisted so calendar matches lists
  const refreshed = refreshAllTargets(state.targets, now);
  if (refreshed.changed) setTargets(refreshed.targets);

  for (const goal of state.goals) {
    if (goal.status === "COMPLETED") continue;
    if (goal.scheduling?.type !== "DEADLINE") continue;
    const at = goal.scheduling.deadlineEpochMillis;
    if (at < rangeStart || at >= rangeEnd) continue;
    const imp = Importance[goal.importance];
    events.push({
      id: `goal-${goal.id}`,
      kind: "goal",
      sourceId: goal.id,
      title: goal.title,
      at,
      dayKey: dayKeyFromMs(at),
      allDay: false,
      tone: imp?.color || "blue",
      meta: `Goal · due · ${formatMinutes(goal.estimatedMinutes)}`,
    });
  }

  for (const reminder of state.reminders) {
    // Completed repeating: muted chip on the renew day only
    if (reminder.status === "COMPLETED") {
      if (reminder.mode !== "REPEAT" || !reminder.triggerAt) continue;
      const at = reminder.triggerAt;
      if (at < rangeStart || at >= rangeEnd) continue;
      const cadence =
        reminder.repeat?.cadence === "MONTHLY"
          ? "monthly"
          : reminder.repeat?.cadence === "WEEKLY"
            ? "weekly"
            : "repeat";
      events.push({
        id: `rem-${reminder.id}-renew`,
        kind: "reminder",
        sourceId: reminder.id,
        title: reminder.title,
        at,
        dayKey: dayKeyFromMs(at),
        allDay: false,
        tone: "done",
        meta: `Renews · ${cadence}`,
        muted: true,
        renewChip: true,
      });
      continue;
    }

    if (reminder.mode === "REPEAT" && reminder.repeat?.cadence === "WEEKLY") {
      const days = new Set(reminder.repeat.weekdays || []);
      const time = reminder.repeat.time || "09:00";
      for (const dayMs of eachDay(rangeStart, rangeEnd)) {
        if (!days.has(new Date(dayMs).getDay())) continue;
        const at = applyTimeOnDay(dayMs, time);
        // Don't show past occurrences; due day still shows
        if (dayMs < todayStart) continue;
        events.push({
          id: `rem-${reminder.id}-${dayKeyFromMs(dayMs)}`,
          kind: "reminder",
          sourceId: reminder.id,
          title: reminder.title,
          at,
          dayKey: dayKeyFromMs(dayMs),
          allDay: false,
          tone: reminder.status === "DUE" && dayMs === todayStart ? "red" : "orange",
          meta:
            reminder.status === "DUE" && dayMs === todayStart
              ? "Reminder · weekly · due"
              : "Reminder · weekly",
        });
      }
      continue;
    }

    if (reminder.mode === "REPEAT" && reminder.repeat?.cadence === "MONTHLY") {
      const monthDays = new Set(reminder.repeat.monthDays || []);
      const time = reminder.repeat.time || "09:00";
      for (const dayMs of eachDay(rangeStart, rangeEnd)) {
        if (!monthDays.has(new Date(dayMs).getDate())) continue;
        const at = applyTimeOnDay(dayMs, time);
        if (dayMs < todayStart) continue;
        events.push({
          id: `rem-${reminder.id}-${dayKeyFromMs(dayMs)}`,
          kind: "reminder",
          sourceId: reminder.id,
          title: reminder.title,
          at,
          dayKey: dayKeyFromMs(dayMs),
          allDay: false,
          tone: reminder.status === "DUE" && dayMs === todayStart ? "red" : "orange",
          meta:
            reminder.status === "DUE" && dayMs === todayStart
              ? "Reminder · monthly · due"
              : "Reminder · monthly",
        });
      }
      continue;
    }

    // DATETIME / TIMER / DUE one-shot — use triggerAt
    const at = reminder.triggerAt;
    if (!at || at < rangeStart || at >= rangeEnd) continue;
    events.push({
      id: `rem-${reminder.id}`,
      kind: "reminder",
      sourceId: reminder.id,
      title: reminder.title,
      at,
      dayKey: dayKeyFromMs(at),
      allDay: false,
      tone: reminder.status === "DUE" ? "red" : "orange",
      meta:
        reminder.status === "DUE"
          ? "Reminder · due"
          : reminder.mode === "TIMER"
            ? "Reminder · timer"
            : "Reminder",
    });
  }

  // Target period markers — only while still open this period
  const rangeDays = Math.round((rangeEnd - rangeStart) / (24 * 60 * 60 * 1000));
  for (const raw of state.targets) {
    const t = ensureTargetPeriod(raw, now);
    if (t.paused || isTargetCompletedForPeriod(t)) continue;
    const imp = Importance[t.importance];
    const periodStart = t.periodStart;
    const periodEnd = nextPeriodStart(t.period, periodStart);
    for (const dayMs of eachDay(rangeStart, rangeEnd)) {
      if (dayMs < periodStart || dayMs >= periodEnd) continue;

      // In wide (month) views, only pin week/month/year markers to anchor days
      if (rangeDays > 7) {
        const d = new Date(dayMs);
        const isToday = dayKeyFromMs(dayMs) === dayKeyFromMs(now);
        if (t.period === "WEEK" && d.getDay() !== 1 && !isToday) continue;
        if (t.period === "MONTH" && d.getDate() !== 1 && !isToday) continue;
        if (t.period === "YEAR" && !(d.getMonth() === 0 && d.getDate() === 1) && !isToday) continue;
      }

      events.push({
        id: `tgt-${t.id}-${dayKeyFromMs(dayMs)}`,
        kind: "target",
        sourceId: t.id,
        title: t.title,
        at: null,
        dayKey: dayKeyFromMs(dayMs),
        allDay: true,
        tone: imp?.color || "blue",
        meta: `Target · ${Period[t.period].label} · ${t.completionsInPeriod}/${t.frequency}`,
        muted: false,
      });
    }
  }

  return events.sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? 1 : -1;
    const aAt = a.at ?? 0;
    const bAt = b.at ?? 0;
    if (aAt !== bAt) return aAt - bAt;
    return a.title.localeCompare(b.title);
  });
}

function eventsForDay(dayMs) {
  const start = startOfLocalDay(dayMs);
  return buildCalendarEvents(start, addLocalDays(start, 1));
}

function openCalendarItem(ev) {
  // Same path as home/lists: detail → complete / edit / delete
  openItemDetail(ev.kind, ev.sourceId);
}

function formatCalHeading(view, cursorMs) {
  const d = new Date(cursorMs);
  if (view === "day") {
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  if (view === "week") {
    const start = new Date(startOfLocalWeek(cursorMs));
    const end = new Date(addLocalDays(start.getTime(), 6));
    return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  }
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function shiftCalendar(delta) {
  const view = state.calendarView;
  const d = new Date(state.calendarCursor);
  if (view === "day") d.setDate(d.getDate() + delta);
  else if (view === "week") d.setDate(d.getDate() + delta * 7);
  else d.setMonth(d.getMonth() + delta);
  state.calendarCursor = d.getTime();
  render();
}

function renderCalendarEventRow(ev) {
  const timeLabel = ev.allDay
    ? "All day"
    : new Date(ev.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (ev.renewChip) {
    return renderEntityCard({
      kind: ev.kind,
      id: ev.sourceId,
      title: ev.title,
      meta: `${timeLabel} · ${ev.meta}`,
      tone: "done",
      muted: true,
      actions: { complete: false, edit: false, remove: false, uncomplete: true },
      openOnClick: true,
    });
  }
  return renderEntityCard({
    kind: ev.kind,
    id: ev.sourceId,
    title: ev.title,
    meta: `${timeLabel} · ${ev.meta}`,
    tone: ev.tone,
    muted: Boolean(ev.muted),
    actions: { complete: true, edit: false, remove: false },
    openOnClick: true,
  });
}

function renderCalendar() {
  const view = state.calendarView || "month";
  const cursor = state.calendarCursor || Date.now();
  const todayKey = dayKeyFromMs(Date.now());

  let body;
  if (view === "day") {
    const dayStart = startOfLocalDay(cursor);
    const events = eventsForDay(dayStart);
    body = el("div", { className: "panel stack" }, [
      el("h2", { text: "Schedule" }),
      ...(events.length
        ? events.map(renderCalendarEventRow)
        : [el("p", { className: "empty", text: "Nothing on this day." })]),
    ]);
  } else if (view === "week") {
    const weekStart = startOfLocalWeek(cursor);
    const days = eachDay(weekStart, addLocalDays(weekStart, 7));
    body = el(
      "div",
      { className: "stack" },
      days.map((dayMs) => {
        const key = dayKeyFromMs(dayMs);
        const events = eventsForDay(dayMs);
        const label = new Date(dayMs).toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
        return el("div", { className: `panel stack cal-day-card ${key === todayKey ? "is-today" : ""}` }, [
          el("button", {
            className: "cal-day-heading",
            text: `${label}${key === todayKey ? " · Today" : ""} · ${events.length}`,
            onClick: () => {
              state.calendarView = "day";
              state.calendarCursor = dayMs;
              render();
            },
          }),
          ...events.slice(0, 4).map(renderCalendarEventRow),
          events.length > 4
            ? el("p", { className: "meta small", text: `+${events.length - 4} more` })
            : null,
        ]);
      })
    );
  } else {
    const monthStart = startOfLocalMonth(cursor);
    const monthDate = new Date(monthStart);
    const year = monthDate.getFullYear();
    const month = monthDate.getMonth();
    const firstDow = new Date(year, month, 1).getDay();
    const mondayFirst = firstDow === 0 ? 6 : firstDow - 1;
    const totalDays = daysInMonth(year, month);
    const monthEnd = addLocalDays(monthStart, totalDays);
    const allEvents = buildCalendarEvents(monthStart, monthEnd);
    const byDay = new Map();
    for (const ev of allEvents) {
      if (!byDay.has(ev.dayKey)) byDay.set(ev.dayKey, []);
      byDay.get(ev.dayKey).push(ev);
    }

    const cells = [];
    for (let i = 0; i < mondayFirst; i++) {
      cells.push(el("div", { className: "cal-cell empty" }));
    }
    for (let day = 1; day <= totalDays; day++) {
      const dayMs = new Date(year, month, day).getTime();
      const key = dayKeyFromMs(dayMs);
      const list = byDay.get(key) || [];
      const hasGoal = list.some((e) => e.kind === "goal");
      const hasRem = list.some((e) => e.kind === "reminder" && !e.renewChip);
      const hasRenew = list.some((e) => e.renewChip);
      const hasTgt = list.some((e) => e.kind === "target" && !e.muted);
      cells.push(
        el(
          "button",
          {
            className: `cal-cell ${key === todayKey ? "is-today" : ""}`,
            onClick: () => {
              state.calendarView = "day";
              state.calendarCursor = dayMs;
              render();
            },
          },
          [
            el("span", { className: "cal-date", text: String(day) }),
            el("div", { className: "cal-dots" }, [
              hasGoal ? el("span", { className: "cal-dot red" }) : null,
              hasRem ? el("span", { className: "cal-dot orange" }) : null,
              hasRenew ? el("span", { className: "cal-dot done" }) : null,
              hasTgt ? el("span", { className: "cal-dot blue" }) : null,
            ]),
          ]
        )
      );
    }

    const selectedDay = startOfLocalDay(cursor);
    const selectedKey = dayKeyFromMs(selectedDay);
    // If cursor is in this month, show that day; else show today if in month else day 1
    let detailMs = selectedDay;
    if (new Date(selectedDay).getMonth() !== month || new Date(selectedDay).getFullYear() !== year) {
      detailMs = monthStart;
    }
    const detailEvents = eventsForDay(detailMs);

    body = el("div", { className: "stack" }, [
      el("div", { className: "panel" }, [
        el("div", { className: "cal-weekdays" }, [
          "Mon",
          "Tue",
          "Wed",
          "Thu",
          "Fri",
          "Sat",
          "Sun",
        ].map((d) => el("span", { text: d }))),
        el("div", { className: "cal-grid" }, cells),
        el("p", {
          className: "meta small",
          text: "Dots: red = goal · orange = reminder · green = renews · blue = target",
        }),
      ]),
      el("div", { className: "panel stack" }, [
        el("h2", {
          text: new Date(detailMs).toLocaleDateString(undefined, {
            weekday: "long",
            month: "short",
            day: "numeric",
          }),
        }),
        ...(detailEvents.length
          ? detailEvents.map(renderCalendarEventRow)
          : [el("p", { className: "empty", text: "Nothing on this day." })]),
      ]),
    ]);
  }

  return shell([
    el("button", { className: "nav-back", text: "← Home", onClick: () => go("home") }),
    el("div", { className: "panel stack" }, [
      el("h2", { text: "Calendar" }),
      el("div", { className: "chips" }, [
        el("button", {
          className: `chip ${view === "day" ? "selected" : ""}`,
          text: "Day",
          onClick: () => {
            state.calendarView = "day";
            render();
          },
        }),
        el("button", {
          className: `chip ${view === "week" ? "selected" : ""}`,
          text: "Week",
          onClick: () => {
            state.calendarView = "week";
            state.calendarCursor = startOfLocalWeek(state.calendarCursor);
            render();
          },
        }),
        el("button", {
          className: `chip ${view === "month" ? "selected" : ""}`,
          text: "Month",
          onClick: () => {
            state.calendarView = "month";
            render();
          },
        }),
      ]),
      el("div", { className: "row cal-nav" }, [
        el("button", {
          className: "btn btn-ghost",
          text: "←",
          onClick: () => shiftCalendar(-1),
        }),
        el("p", {
          className: "cal-heading",
          text: formatCalHeading(view, cursor),
          style: "flex:1;text-align:center;margin:0;font-weight:600",
        }),
        el("button", {
          className: "btn btn-ghost",
          text: "→",
          onClick: () => shiftCalendar(1),
        }),
      ]),
      el("button", {
        className: "btn btn-ghost btn-block",
        text: "Today",
        onClick: () => {
          state.calendarCursor = Date.now();
          render();
        },
      }),
    ]),
    body,
  ]);
}

function renderHome() {
  const active = activeGoals();
  const due = dueReminders();
  const mode = getNotificationMode();

  return shell([
    el("div", { className: "home-top" }, [
      el("p", { className: "brand", text: "Time Flow" }),
      el("div", { className: "home-top-actions" }, [
        el(
          "button",
          {
            className: "cal-icon-btn",
            title: "Alerts",
            "aria-label": "Alerts",
            onClick: () => go("alerts"),
          },
          [
            (() => {
              const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
              svg.setAttribute("viewBox", "0 0 24 24");
              svg.setAttribute("width", "20");
              svg.setAttribute("height", "20");
              svg.setAttribute("aria-hidden", "true");
              svg.innerHTML =
                '<path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11a6 6 0 1 0-12 0v5l-2 2v1h16v-1l-2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>';
              return svg;
            })(),
          ]
        ),
        el(
          "button",
          {
            className: "cal-icon-btn",
            title: "Calendar",
            "aria-label": "Calendar",
            onClick: () => {
              state.calendarCursor = Date.now();
              go("calendar");
            },
          },
          [
            (() => {
              const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
              svg.setAttribute("viewBox", "0 0 24 24");
              svg.setAttribute("width", "22");
              svg.setAttribute("height", "22");
              svg.setAttribute("aria-hidden", "true");
              svg.innerHTML =
                '<rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
                '<path d="M3 10h18" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
                '<path d="M8 3v4M16 3v4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
              return svg;
            })(),
          ]
        ),
      ]),
    ]),
    el("p", {
      className: "lede",
      text: "Capture goals. Spend free time on what matters.",
    }),
    el("div", { className: "panel stack quick-strip" }, [
      el("p", { className: "step-meta", text: "Quick" }),
      el(
        "div",
        { className: "chips" },
        [5, 10, 15].map((m) =>
          el("button", {
            className: "chip",
            text: `${m} min`,
            onClick: () => quickStartTimer(m),
          })
        )
      ),
      el(
        "div",
        { className: "chips" },
        [
          el("button", {
            className: "chip",
            text: "Start 25",
            onClick: () => startFreeTimeWindow(25),
          }),
          el("button", {
            className: "chip chip-accent",
            text: "+ Capture",
            onClick: () => {
              state.quickCapture = true;
              render();
            },
          }),
        ]
      ),
      state.quickCapture
        ? (() => {
            let titleVal = "";
            const input = el("input", {
              type: "text",
              placeholder: "What’s on your mind?",
              value: "",
              onInput: (e) => {
                titleVal = e.target.value;
              },
            });
            wireGoKey(input, () => quickCaptureGoal(titleVal || input.value));
            setTimeout(() => input.focus(), 0);
            return el("div", { className: "stack quick-capture" }, [
              el("div", { className: "field" }, [
                el("label", { text: "Quick goal" }),
                input,
              ]),
              el("div", { className: "row" }, [
                el("button", {
                  className: "btn btn-ghost",
                  style: "flex:1",
                  text: "Cancel",
                  onClick: () => {
                    state.quickCapture = false;
                    render();
                  },
                }),
                el("button", {
                  className: "btn btn-primary",
                  style: "flex:1",
                  text: "Save",
                  onClick: () => quickCaptureGoal(titleVal || input.value),
                }),
              ]),
            ]);
          })()
        : null,
    ]),
    mode !== "off" &&
    !hasNotificationPermission() &&
    notificationsSupported() &&
    state.reminders.some((r) => r.status === "SCHEDULED" || r.status === "DUE")
      ? el("div", { className: "panel stack" }, [
          el("p", {
            className: "meta",
            text: "Turn on notifications so reminders alert you when time is up — even if the app is closed (APK). You can soften or turn them off in Alerts.",
          }),
          el("button", {
            className: "btn btn-primary btn-block",
            text: "Enable notifications",
            onClick: () => {
              ensureNotificationPermission().then(() => render());
            },
          }),
        ])
      : null,
    el("div", { className: "panel stack" }, [
      el("button", {
        className: "btn btn-primary btn-block",
        text: "I have free time",
        onClick: () => go("freetime"),
      }),
      el("button", {
        className: "btn btn-ghost btn-block",
        text: "Sprint",
        onClick: () => openSprint(),
      }),
      el("button", {
        className: "btn btn-ghost btn-block",
        text: `Reminders (${scheduledReminders().length + due.length})`,
        onClick: () => go("reminders"),
      }),
      el("button", {
        className: "btn btn-ghost btn-block",
        text: `Targets (${availableTargets(state.targets).length})`,
        onClick: () => go("targets"),
      }),
      el("button", {
        className: "btn btn-ghost btn-block",
        text: `Goals (${active.length})`,
        onClick: () => go("goals"),
      }),
    ]),
    (() => {
      const homeGoals = active
        .map((g) => goalToPackItem(g))
        .sort((a, b) => b.score - a.score);
      const homeTargets = availableTargets(state.targets)
        .map((t) => targetToPackItem(t))
        .sort((a, b) => b.score - a.score);
      const homeReminders = [
        ...due,
        ...scheduledReminders().filter((r) => !due.some((d) => d.id === r.id)),
      ];

      const cardActions = { complete: true, edit: false, remove: false };
      const preview = (list) => list.slice(0, 2);
      const seeMore = (screen, total, label) =>
        total > 2
          ? el("button", {
              className: "btn btn-ghost btn-block",
              text: `See all ${label} (${total})`,
              onClick: () => go(screen),
            })
          : null;

      return el("div", { className: "stack home-sections" }, [
        el("div", { className: "panel stack" }, [
          el("h2", { text: "Reminders" }),
          ...(homeReminders.length
            ? preview(homeReminders).map((r) =>
                renderEntityCard({
                  kind: "reminder",
                  id: r.id,
                  title: r.title,
                  meta:
                    r.status === "DUE"
                      ? "Due now"
                      : `${r.mode === "TIMER" ? "Timer" : r.mode === "REPEAT" ? "Repeat" : "At"} · ${formatTrigger(r, state.now)}`,
                  tone: r.status === "DUE" ? "red" : "orange",
                  actions: cardActions,
                  openOnClick: true,
                })
              )
            : [el("p", { className: "empty", text: "No reminders right now." })]),
          seeMore("reminders", homeReminders.length, "reminders"),
        ]),
        el("div", { className: "panel stack" }, [
          el("h2", { text: "Goals" }),
          ...(homeGoals.length
            ? preview(homeGoals).map((item) => {
                const imp = Importance[item.importance];
                return renderEntityCard({
                  kind: "goal",
                  id: item.sourceId,
                  title: item.title,
                  meta: packItemLabel(item),
                  tone: imp.color,
                  actions: cardActions,
                  openOnClick: true,
                });
              })
            : [el("p", { className: "empty", text: "No pending goals — that’s fine." })]),
          seeMore("goals", homeGoals.length, "goals"),
        ]),
        el("div", { className: "panel stack" }, [
          el("h2", { text: "Targets" }),
          ...(homeTargets.length
            ? preview(homeTargets).map((item) => {
                const imp = Importance[item.importance];
                return renderEntityCard({
                  kind: "target",
                  id: item.sourceId,
                  title: `◎ ${item.title}`,
                  meta: packItemLabel(item),
                  tone: imp.color,
                  actions: cardActions,
                  openOnClick: true,
                });
              })
            : [el("p", { className: "empty", text: "Nothing open — that’s fine." })]),
          seeMore("targets", homeTargets.length, "targets"),
        ]),
      ]);
    })(),
  ]);
}

function renderRemind() {
  const w = state.remind;
  const editing = Boolean(w.id);
  const back = el("button", {
    className: "nav-back",
    text: "← Back",
    onClick: () => {
      if (w.step <= 1) {
        state.remind = null;
        const back = state.returnScreen || (editing ? "reminders" : "home");
        state.returnScreen = null;
        go(back);
      } else {
        w.step = 1;
        w.mode = null;
        w.repeatCadence = null;
        render();
      }
    },
  });

  const toggleInList = (listKey, value) => {
    const set = new Set(w[listKey]);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    w[listKey] = [...set];
    if (!trySaveRepeatReminder()) render();
  };

  let body;
  if (w.step === 1) {
    const titleInput = el("input", {
      value: w.title,
      placeholder: "e.g. Take medication",
      autocomplete: "off",
      onInput: (e) => {
        w.title = e.target.value;
      },
    });
    const goNext = () => {
      if (!w.title.trim()) return;
      w.step = 2;
      render();
    };
    wireGoKey(titleInput, goNext);
    body = el("div", { className: "panel stack" }, [
      el("p", { className: "step-meta", text: editing ? "Edit reminder" : "Remind me" }),
      el("h2", { text: "Remind me to…" }),
      el("div", { className: "field" }, [el("label", { text: "What?" }), titleInput]),
      nextButton("Next", goNext),
    ]);
    setTimeout(() => titleInput.focus(), 0);
  } else {
    body = el("div", { className: "panel stack" }, [
      el("p", { className: "step-meta", text: editing ? "Edit when" : "When?" }),
      el("h2", { text: editing ? `When for “${w.title}”?` : "When?" }),
      el("p", { className: "meta", text: "Tap a choice — it moves on automatically." }),
      el(
        "button",
        {
          className: `choice ${w.mode === "DATETIME" ? "selected" : ""}`,
          onClick: () => {
            w.mode = "DATETIME";
            w.repeatCadence = null;
            render();
          },
        },
        [
          el("span", { className: "label", text: "Date and time" }),
          el("span", { className: "hint", text: "One-shot at an exact moment" }),
        ]
      ),
      el(
        "button",
        {
          className: `choice ${w.mode === "TIMER" ? "selected" : ""}`,
          onClick: () => {
            w.mode = "TIMER";
            w.repeatCadence = null;
            render();
          },
        },
        [
          el("span", { className: "label", text: "Timer" }),
          el("span", { className: "hint", text: "Remind me in N minutes" }),
        ]
      ),
      el(
        "button",
        {
          className: `choice ${w.mode === "REPEAT" ? "selected" : ""}`,
          onClick: () => {
            w.mode = "REPEAT";
            render();
          },
        },
        [
          el("span", { className: "label", text: "Repeat" }),
          el("span", { className: "hint", text: "Weekly or monthly on chosen days" }),
        ]
      ),
      w.mode === "DATETIME" &&
        (() => {
          const saveAt = () => {
            if (!w.datetimeLocal) {
              showAlert("Pick a date and time.");
              return;
            }
            if (new Date(w.datetimeLocal).getTime() <= Date.now()) {
              showAlert("Pick a time in the future.");
              return;
            }
            saveReminderFromWizard();
          };
          return el("div", { className: "stack" }, [
            el("div", { className: "field" }, [
              el("label", { text: "Date & time" }),
              el("input", {
                type: "datetime-local",
                value: w.datetimeLocal,
                onChange: (e) => {
                  w.datetimeLocal = e.target.value;
                },
              }),
            ]),
            nextButton("Save reminder", saveAt),
          ]);
        })(),
      w.mode === "TIMER" &&
        el("div", { className: "stack" }, [
          el(
            "div",
            { className: "chips" },
            TIMER_PRESETS.map((m) =>
              el("button", {
                className: `chip ${w.timerMinutes === m ? "selected" : ""}`,
                text: formatMinutes(m),
                onClick: () => {
                  w.timerMinutes = m;
                  saveReminderFromWizard();
                },
              })
            )
          ),
          (() => {
            const custom = el("input", {
              type: "number",
              min: "1",
              inputmode: "numeric",
              value: String(w.timerMinutes),
              onInput: (e) => {
                w.timerMinutes = Math.max(1, Number(e.target.value) || 1);
              },
            });
            const saveCustom = () => saveReminderFromWizard();
            wireGoKey(custom, saveCustom);
            return el("div", { className: "stack" }, [
              el("div", { className: "field" }, [
                el("label", { text: "Custom minutes" }),
                custom,
              ]),
              nextButton("Save timer", saveCustom),
            ]);
          })(),
        ]),
      w.mode === "REPEAT" &&
        el("div", { className: "stack" }, [
          el(
            "button",
            {
              className: `choice ${w.repeatCadence === "WEEKLY" ? "selected" : ""}`,
              onClick: () => {
                w.repeatCadence = "WEEKLY";
                render();
              },
            },
            [
              el("span", { className: "label", text: "Weekly" }),
              el("span", { className: "hint", text: "Pick weekdays and a time" }),
            ]
          ),
          el(
            "button",
            {
              className: `choice ${w.repeatCadence === "MONTHLY" ? "selected" : ""}`,
              onClick: () => {
                w.repeatCadence = "MONTHLY";
                render();
              },
            },
            [
              el("span", { className: "label", text: "Monthly" }),
              el("span", { className: "hint", text: "Pick days of the month" }),
            ]
          ),
          w.repeatCadence === "WEEKLY" &&
            el("div", { className: "stack" }, [
              el("p", { className: "meta", text: "Days" }),
              el(
                "div",
                { className: "chips" },
                WEEKDAYS.map((d) =>
                  el("button", {
                    className: `chip ${w.weekdays.includes(d.id) ? "selected" : ""}`,
                    text: d.label,
                    onClick: () => toggleInList("weekdays", d.id),
                  })
                )
              ),
              el("div", { className: "field" }, [
                el("label", { text: "Time" }),
                el("input", {
                  type: "time",
                  value: w.repeatTime,
                  onChange: (e) => {
                    w.repeatTime = e.target.value;
                  },
                }),
              ]),
              nextButton("Save reminder", () => {
                if (!trySaveRepeatReminder()) {
                  showAlert("Pick at least one day and a time.");
                }
              }),
            ]),
          w.repeatCadence === "MONTHLY" &&
            el("div", { className: "stack" }, [
              el("p", { className: "meta", text: "Days of the month" }),
              el(
                "div",
                { className: "chips month-days" },
                MONTH_DAYS.map((day) =>
                  el("button", {
                    className: `chip ${w.monthDays.includes(day) ? "selected" : ""}`,
                    text: String(day),
                    onClick: () => toggleInList("monthDays", day),
                  })
                )
              ),
              el("div", { className: "field" }, [
                el("label", { text: "Time" }),
                el("input", {
                  type: "time",
                  value: w.repeatTime,
                  onChange: (e) => {
                    w.repeatTime = e.target.value;
                  },
                }),
              ]),
              nextButton("Save reminder", () => {
                if (!trySaveRepeatReminder()) {
                  showAlert("Pick at least one day and a time.");
                }
              }),
            ]),
        ]),
    ]);
  }

  return shell([back, body]);
}

function renderReminders() {
  const due = dueReminders();
  const scheduled = scheduledReminders();
  const done = state.reminders
    .filter((r) => r.status === "COMPLETED")
    .slice()
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    .slice(0, 20);

  return shell([
    el("button", { className: "nav-back", text: "← Home", onClick: () => go("home") }),
    el("div", { className: "panel stack" }, [
      el("h2", { text: "Reminders" }),
      el("button", {
        className: "btn btn-primary btn-block",
        text: "Remind me to…",
        onClick: () => {
          state.returnScreen = "reminders";
          openRemindWizard();
        },
      }),
    ]),
    due.length
      ? el("div", { className: "due-banner stack" }, [
          el("h2", { text: "Due now" }),
          ...due.map((r) =>
            renderEntityCard({
              kind: "reminder",
              id: r.id,
              title: r.title,
              meta: "Due now",
              tone: "red",
            })
          ),
        ])
      : null,
    el("div", { className: "panel stack" }, [
      el("h2", { text: "Scheduled" }),
      ...(scheduled.length
        ? scheduled.map((r) =>
            renderEntityCard({
              kind: "reminder",
              id: r.id,
              title: r.title,
              meta: `${r.mode === "TIMER" ? "Timer" : r.mode === "REPEAT" ? "Repeat" : "At"} · ${formatTrigger(r, state.now)}`,
              tone: "orange",
            })
          )
        : [el("p", { className: "empty", text: "None scheduled." })]),
    ]),
    done.length
      ? el("div", { className: "panel stack" }, [
          el("h2", { text: "Completed" }),
          ...done.map((r) =>
            renderEntityCard({
              kind: "reminder",
              id: r.id,
              title: r.title,
              meta: formatTrigger(r, state.now),
              tone: "done",
              muted: true,
              actions: { complete: false, edit: false, remove: true, uncomplete: true },
            })
          ),
        ])
      : null,
  ]);
}
function goalRow(goal) {
  const imp = Importance[goal.importance];
  return el("div", { className: "goal-card" }, [
    el("div", {}, [
      el("p", { className: "goal-title" }, [
        el("span", { className: `dot ${imp.color}` }),
        goal.title,
      ]),
      el("p", {
        className: "meta",
        text: `${schedulingLabel(goal)} · ${formatMinutes(goal.estimatedMinutes)} · score ${scoreGoal(goal)}`,
      }),
    ]),
  ]);
}

function renderWizard() {
  const w = state.wizard;
  const editing = Boolean(w.id);
  const back = el("button", {
    className: "nav-back",
    text: "← Back",
    onClick: () => {
      if (w.step === 1) {
        const back = state.returnScreen || (editing ? "goals" : "home");
        state.returnScreen = null;
        state.wizard = null;
        go(back);
      } else {
        w.step -= 1;
        render();
      }
    },
  });

  let body;
  if (w.step === 1) {
    const titleInput = el("input", {
      value: w.title,
      placeholder: "e.g. Pay electricity bill",
      autocomplete: "off",
      onInput: (e) => {
        w.title = e.target.value;
      },
    });
    const goNext = () => {
      if (!w.title.trim()) return;
      w.step = 2;
      render();
    };
    wireGoKey(titleInput, goNext);
    body = el("div", { className: "panel stack" }, [
      el("p", { className: "step-meta", text: editing ? "Edit goal · 1 of 4" : "Step 1 of 4" }),
      el("h2", { text: editing ? "Edit goal" : "What’s the goal?" }),
      el("div", { className: "field" }, [el("label", { text: "Goal" }), titleInput]),
      el("div", { className: "field" }, [
        el("label", { text: "Notes (optional)" }),
        el("textarea", {
          text: w.notes,
          rows: "3",
          onInput: (e) => {
            w.notes = e.target.value;
          },
        }),
      ]),
      nextButton("Next", goNext),
    ]);
    setTimeout(() => titleInput.focus(), 0);
  } else if (w.step === 2) {
    body = el("div", { className: "panel stack" }, [
      el("p", { className: "step-meta", text: editing ? "Edit goal · 2 of 4" : "Step 2 of 4" }),
      el("h2", { text: "How important?" }),
      el("p", { className: "meta", text: "Tap to continue." }),
      ...Object.values(Importance).map((item) =>
        el(
          "button",
          {
            className: `choice ${w.importance === item.id ? "selected" : ""}`,
            onClick: () => {
              w.importance = item.id;
              w.step = 3;
              render();
            },
          },
          [
            el("span", { className: "label" }, [
              el("span", { className: `dot ${item.color}` }),
              item.label,
            ]),
          ]
        )
      ),
    ]);
  } else if (w.step === 3) {
    body = el("div", { className: "panel stack" }, [
      el("p", { className: "step-meta", text: editing ? "Edit goal · 3 of 4" : "Step 3 of 4" }),
      el("h2", { text: "Deadline or urgency?" }),
      el("p", {
        className: "meta",
        text: "Tap one. Deadline = you know when. Urgency = no date, but it can’t wait.",
      }),
      el(
        "button",
        {
          className: `choice ${w.mode === "DEADLINE" ? "selected" : ""}`,
          onClick: () => {
            w.mode = "DEADLINE";
            w.urgency = null;
            render();
          },
        },
        [
          el("span", { className: "label", text: "Set a deadline" }),
          el("span", { className: "hint", text: "Specific date / time" }),
        ]
      ),
      el(
        "button",
        {
          className: `choice ${w.mode === "URGENCY" ? "selected" : ""}`,
          onClick: () => {
            w.mode = "URGENCY";
            w.deadlineLocal = "";
            render();
          },
        },
        [
          el("span", { className: "label", text: "Set urgency" }),
          el("span", { className: "hint", text: "No date — just can’t be delayed" }),
        ]
      ),
      w.mode === "DEADLINE" &&
        el("div", { className: "field" }, [
          el("label", { text: "Deadline" }),
          el("input", {
            type: "datetime-local",
            value: w.deadlineLocal,
            onChange: (e) => {
              w.deadlineLocal = e.target.value;
              if (!w.deadlineLocal) return;
              w.step = 4;
              render();
            },
          }),
        ]),
      w.mode === "URGENCY" &&
        el(
          "div",
          { className: "stack" },
          Object.values(Urgency).map((u) =>
            el(
              "button",
              {
                className: `choice ${w.urgency === u.id ? "selected" : ""}`,
                onClick: () => {
                  w.urgency = u.id;
                  w.step = 4;
                  render();
                },
              },
              [el("span", { className: "label", text: u.label })]
            )
          )
        ),
    ]);
  } else {
    body = el("div", { className: "panel stack" }, [
      el("p", { className: "step-meta", text: editing ? "Edit goal · 4 of 4" : "Step 4 of 4" }),
      el("h2", { text: "How long will it take?" }),
      el("p", { className: "meta", text: "Tap a duration to save." }),
      el(
        "div",
        { className: "chips" },
        DURATION_PRESETS.map((m) =>
          el("button", {
            className: `chip ${w.estimatedMinutes === m ? "selected" : ""}`,
            text: formatMinutes(m),
            onClick: () => {
              w.estimatedMinutes = m;
              saveGoalFromWizard();
            },
          })
        )
      ),
      (() => {
        const custom = el("input", {
          type: "number",
          min: "1",
          inputmode: "numeric",
          value: String(w.estimatedMinutes),
          onInput: (e) => {
            w.estimatedMinutes = Math.max(1, Number(e.target.value) || 1);
          },
        });
        const save = () => saveGoalFromWizard();
        wireGoKey(custom, save);
        return el("div", { className: "stack" }, [
          el("div", { className: "field" }, [
            el("label", { text: "Custom minutes" }),
            custom,
          ]),
          nextButton("Save goal", save),
        ]);
      })(),
    ]);
  }

  return shell([back, body]);
}

function renderGoals() {
  const active = activeGoals();
  const done = state.goals
    .filter((g) => g.status === "COMPLETED")
    .slice()
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  return shell([
    el("button", { className: "nav-back", text: "← Home", onClick: () => go("home") }),
    el("div", { className: "panel stack" }, [
      el("h2", { text: "Pending" }),
      el("button", {
        className: "btn btn-primary btn-block",
        text: "Add a goal",
        onClick: () => {
          state.returnScreen = "goals";
          openGoalWizard();
        },
      }),
      ...(active.length
        ? active.map((goal) => {
            const imp = Importance[goal.importance];
            return renderEntityCard({
              kind: "goal",
              id: goal.id,
              title: goal.title,
              meta: `${schedulingLabel(goal)} · ${formatMinutes(goal.estimatedMinutes)} · score ${scoreGoal(goal)}`,
              tone: imp.color,
            });
          })
        : [el("p", { className: "empty", text: "None yet." })]),
    ]),
    done.length
      ? el("div", { className: "panel stack" }, [
          el("h2", { text: "Completed" }),
          ...done.slice(0, 10).map((g) =>
            renderEntityCard({
              kind: "goal",
              id: g.id,
              title: g.title,
              meta: "Completed",
              tone: Importance[g.importance]?.color || "blue",
              muted: true,
              actions: { complete: false, edit: false, remove: true, uncomplete: true },
            })
          ),
        ])
      : null,
  ]);
}

function goalRowWithDelete(goal) {
  const imp = Importance[goal.importance];
  return renderEntityCard({
    kind: "goal",
    id: goal.id,
    title: goal.title,
    meta: `${schedulingLabel(goal)} · ${formatMinutes(goal.estimatedMinutes)} · score ${scoreGoal(goal)}`,
    tone: imp.color,
  });
}

function renderTargetWizard() {
  const w = state.targetWizard;
  const editing = Boolean(w.id);
  const back = el("button", {
    className: "nav-back",
    text: "← Back",
    onClick: () => {
      if (w.step <= 1) {
        state.targetWizard = null;
        const back = state.returnScreen || "targets";
        state.returnScreen = null;
        go(back);
      } else {
        w.step -= 1;
        render();
      }
    },
  });

  let body;
  if (w.step === 1) {
    const titleInput = el("input", {
      value: w.title,
      placeholder: "e.g. Workout",
      autocomplete: "off",
      onInput: (e) => {
        w.title = e.target.value;
      },
    });
    const goNext = () => {
      if (!w.title.trim()) return;
      w.step = 2;
      render();
    };
    wireGoKey(titleInput, goNext);
    body = el("div", { className: "panel stack" }, [
      el("p", { className: "step-meta", text: editing ? "Edit target" : "New target" }),
      el("h2", { text: "What’s the target?" }),
      el("div", { className: "field" }, [el("label", { text: "Target" }), titleInput]),
      nextButton("Next", goNext),
    ]);
    setTimeout(() => titleInput.focus(), 0);
  } else if (w.step === 2) {
    body = el("div", { className: "panel stack" }, [
      el("p", { className: "step-meta", text: "Importance" }),
      el("h2", { text: "How important?" }),
      el("p", { className: "meta", text: "Used in free-time score: urgency × importance." }),
      ...Object.values(Importance).map((item) =>
        el(
          "button",
          {
            className: `choice ${w.importance === item.id ? "selected" : ""}`,
            onClick: () => {
              w.importance = item.id;
              w.step = 3;
              render();
            },
          },
          [
            el("span", { className: "label" }, [
              el("span", { className: `dot ${item.color}` }),
              item.label,
            ]),
          ]
        )
      ),
    ]);
  } else if (w.step === 3) {
    body = el("div", { className: "panel stack" }, [
      el("p", { className: "step-meta", text: "Duration" }),
      el("h2", { text: "How long each time?" }),
      el(
        "div",
        { className: "chips" },
        DURATION_PRESETS.map((m) =>
          el("button", {
            className: `chip ${w.estimatedMinutes === m ? "selected" : ""}`,
            text: formatMinutes(m),
            onClick: () => {
              w.estimatedMinutes = m;
              w.step = 4;
              render();
            },
          })
        )
      ),
      (() => {
        const custom = el("input", {
          type: "number",
          min: "1",
          inputmode: "numeric",
          value: String(w.estimatedMinutes),
          onInput: (e) => {
            w.estimatedMinutes = Math.max(1, Number(e.target.value) || 1);
          },
        });
        const goNext = () => {
          w.step = 4;
          render();
        };
        wireGoKey(custom, goNext);
        return el("div", { className: "stack" }, [
          el("div", { className: "field" }, [
            el("label", { text: "Custom minutes" }),
            custom,
          ]),
          nextButton("Next", goNext),
        ]);
      })(),
    ]);
  } else if (w.step === 4) {
    body = el("div", { className: "panel stack" }, [
      el("p", { className: "step-meta", text: "Period" }),
      el("h2", { text: "How often?" }),
      el("p", { className: "meta", text: "Day, week, month, or year — then pick frequency." }),
      ...Object.values(Period).map((p) =>
        el(
          "button",
          {
            className: `choice ${w.period === p.id ? "selected" : ""}`,
            onClick: () => {
              w.period = p.id;
              w.step = 5;
              render();
            },
          },
          [
            el("span", { className: "label", text: p.label }),
            el("span", {
              className: "hint",
              text: `N times per ${p.label.toLowerCase()}`,
            }),
          ]
        )
      ),
    ]);
  } else {
    const presets = FREQ_PRESETS[w.period] || [1, 2, 3];
    body = el("div", { className: "panel stack" }, [
      el("p", { className: "step-meta", text: "Frequency" }),
      el("h2", { text: `Times per ${Period[w.period].label.toLowerCase()}?` }),
      el(
        "div",
        { className: "chips" },
        presets.map((n) =>
          el("button", {
            className: `chip ${w.frequency === n ? "selected" : ""}`,
            text: String(n),
            onClick: () => {
              w.frequency = n;
              saveTargetFromWizard();
            },
          })
        )
      ),
      (() => {
        const custom = el("input", {
          type: "number",
          min: "1",
          inputmode: "numeric",
          value: String(w.frequency),
          onInput: (e) => {
            w.frequency = Math.max(1, Number(e.target.value) || 1);
          },
        });
        const save = () => saveTargetFromWizard();
        wireGoKey(custom, save);
        return el("div", { className: "stack" }, [
          el("div", { className: "field" }, [
            el("label", { text: "Custom times" }),
            custom,
          ]),
          nextButton("Save target", save),
        ]);
      })(),
    ]);
  }

  return shell([back, body]);
}

function renderTargets() {
  const now = Date.now();
  const targets = state.targets.map((t) => ensureTargetPeriod(t, now));
  // persist period resets if needed
  if (targets.some((t, i) => t.periodStart !== state.targets[i].periodStart)) {
    setTargets(targets);
  }

  const active = targets.filter((t) => !t.paused && !isTargetCompletedForPeriod(t));
  const paused = targets.filter((t) => t.paused && !isTargetCompletedForPeriod(t));
  const donePeriod = targets.filter((t) => isTargetCompletedForPeriod(t));

  return shell([
    el("button", { className: "nav-back", text: "← Home", onClick: () => go("home") }),
    el("div", { className: "panel stack" }, [
      el("h2", { text: "Targets" }),
      el("p", {
        className: "meta",
        text: "Habits with a quota. Pause anytime — it’s parked, not failed.",
      }),
      el("button", {
        className: "btn btn-primary btn-block",
        text: "Add target",
        onClick: () => {
          state.returnScreen = "targets";
          openTargetWizard();
        },
      }),
    ]),
    el("div", { className: "panel" }, [
      el("h2", { text: "This period (resets gently)" }),
      ...(active.length
        ? active.map((t) => {
            const imp = Importance[t.importance];
            return renderEntityCard({
              kind: "target",
              id: t.id,
              title: t.title,
              meta: `${Period[t.period].label} · ${t.completionsInPeriod}/${t.frequency} · ${formatMinutes(t.estimatedMinutes)} · score ${scoreTarget(t)}`,
              tone: imp.color,
            });
          })
        : [el("p", { className: "empty", text: "Nothing open — that’s fine." })]),
    ]),
    paused.length
      ? el("div", { className: "panel stack" }, [
          el("h2", { text: "Paused" }),
          el("p", {
            className: "meta",
            text: "Hidden from packing until you resume.",
          }),
          ...paused.map((t) =>
            renderEntityCard({
              kind: "target",
              id: t.id,
              title: t.title,
              meta: `${Period[t.period].label} · ${t.completionsInPeriod}/${t.frequency} · paused`,
              tone: "blue",
              muted: true,
              actions: { complete: false, edit: true, remove: true, uncomplete: false },
            })
          ),
        ])
      : null,
    donePeriod.length
      ? el("div", { className: "panel stack" }, [
          el("h2", { text: "Completed" }),
          ...donePeriod.map((t) =>
            renderEntityCard({
              kind: "target",
              id: t.id,
              title: t.title,
              meta: `${Period[t.period].label} · ${t.completionsInPeriod}/${t.frequency} — done for this period`,
              tone: Importance[t.importance]?.color || "blue",
              muted: true,
              actions: { complete: false, edit: false, remove: true, uncomplete: true },
            })
          ),
        ])
      : null,
  ]);
}

function renderFreeTime() {
  return shell([
    el("button", { className: "nav-back", text: "← Home", onClick: () => go("home") }),
    el("div", { className: "panel stack" }, [
      el("h2", { text: "How much free time?" }),
      el(
        "div",
        { className: "chips" },
        [15, 25, 30, 45, 60, 90].map((m) =>
          el("button", {
            className: `chip ${state.freeMinutes === m ? "selected" : ""}`,
            text: formatMinutes(m),
            onClick: () => {
              state.freeMinutes = m;
              render();
            },
          })
        )
      ),
      el("div", { className: "field" }, [
        el("label", { text: "Minutes" }),
        el("input", {
          type: "number",
          min: "1",
          value: String(state.freeMinutes),
          onInput: (e) => {
            state.freeMinutes = Math.max(1, Number(e.target.value) || 1);
          },
        }),
      ]),
      el("button", {
        className: "btn btn-primary btn-block",
        text: "Find tasks that fit",
        onClick: () => {
          const packed = packTasks(state.goals, state.targets, state.freeMinutes);
          if (!packed.length) {
            showAlert("Nothing fits that window. Add a shorter goal or target first.");
            return;
          }
          state.packed = packed;
          state.arrangeAddOpen = false;
          state.editingPackId = null;
          go("arrange");
        },
      }),
    ]),
  ]);
}

function openSprint() {
  state.sprintItems = [];
  state.sprintDraft = {
    step: 1,
    title: "",
    estimatedMinutes: 25,
  };
  state.editingSprintId = null;
  go("sprint");
}

function sprintItemFromDraft(draft) {
  const now = Date.now();
  return {
    id: `sprint:${uid()}`,
    kind: "sprint",
    sourceId: null,
    title: draft.title.trim(),
    estimatedMinutes: Math.max(1, Number(draft.estimatedMinutes) || 1),
    importance: "IMPORTANT",
    createdAt: now,
    score: 0,
  };
}

function commitSprintDraft({ thenPrepare = false } = {}) {
  const d = state.sprintDraft;
  if (!d || !d.title.trim()) {
    showAlert("Name this sprint task first.");
    return false;
  }
  state.sprintItems = [...state.sprintItems, sprintItemFromDraft(d)];
  state.sprintDraft = {
    step: 1,
    title: "",
    estimatedMinutes: 25,
  };
  if (thenPrepare) {
    if (!state.sprintItems.length) {
      showAlert("Add at least one task.");
      return false;
    }
    state.editingSprintId = null;
    go("sprintArrange");
    return true;
  }
  render();
  return true;
}

function sprintTotalMinutes() {
  return state.sprintItems.reduce((s, g) => s + g.estimatedMinutes, 0);
}

function moveSprintItem(index, delta) {
  const to = index + delta;
  if (to < 0 || to >= state.sprintItems.length) return;
  const next = state.sprintItems.slice();
  const [moved] = next.splice(index, 1);
  next.splice(to, 0, moved);
  state.sprintItems = next;
  render();
}

function removeSprintItem(id) {
  state.sprintItems = state.sprintItems.filter((g) => g.id !== id);
  if (state.editingSprintId === id) state.editingSprintId = null;
  render();
}

function shuffleSprintItems() {
  const arr = state.sprintItems.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  state.sprintItems = arr;
  render();
}

function renderSprint() {
  const d = state.sprintDraft || { step: 1, title: "", estimatedMinutes: 25 };
  const count = state.sprintItems.length;

  const back = el("button", {
    className: "nav-back",
    text: count ? "← Arrange" : "← Home",
    onClick: () => {
      if (count) {
        state.sprintDraft = { step: 1, title: "", estimatedMinutes: 25 };
        go("sprintArrange");
      } else {
        state.sprintDraft = null;
        state.sprintItems = [];
        go("home");
      }
    },
  });

  if (d.step === 1) {
    const titleInput = el("input", {
      value: d.title,
      placeholder: "e.g. Draft intro slides",
      autocomplete: "off",
      onInput: (e) => {
        d.title = e.target.value;
      },
    });
    const goNext = () => {
      if (!d.title.trim()) return;
      d.step = 2;
      render();
    };
    wireGoKey(titleInput, goNext);
    return shell([
      back,
      el("div", { className: "panel stack" }, [
        el("p", {
          className: "step-meta",
          text: count ? `Sprint · task ${count + 1}` : "Sprint · temporary tasks",
        }),
        el("h2", { text: "What are you working on?" }),
        el("p", {
          className: "meta",
          text: "Sprint tasks exist only for this run — nothing is saved to Goals, Targets, or the calendar.",
        }),
        el("div", { className: "field" }, [el("label", { text: "Name" }), titleInput]),
        nextButton("Next", goNext),
        count
          ? el("button", {
              className: "btn btn-ghost btn-block btn-touch",
              text: `Prepare ${count} task${count === 1 ? "" : "s"}`,
              onClick: () => {
                state.sprintDraft = { step: 1, title: "", estimatedMinutes: 25 };
                go("sprintArrange");
              },
            })
          : null,
      ]),
    ]);
  }

  // Step 2 — duration
  return shell([
    back,
    el("div", { className: "panel stack" }, [
      el("p", { className: "step-meta", text: d.title.trim() || "Sprint task" }),
      el("h2", { text: "How long will it take?" }),
      el(
        "div",
        { className: "chips" },
        DURATION_PRESETS.map((m) =>
          el("button", {
            className: `chip ${d.estimatedMinutes === m ? "selected" : ""}`,
            text: formatMinutes(m),
            onClick: () => {
              d.estimatedMinutes = m;
              render();
            },
          })
        )
      ),
      el("div", { className: "field" }, [
        el("label", { text: "Minutes" }),
        el("input", {
          type: "number",
          min: "1",
          value: String(d.estimatedMinutes),
          onInput: (e) => {
            d.estimatedMinutes = Math.max(1, Number(e.target.value) || 1);
          },
        }),
      ]),
      el("button", {
        className: "btn btn-primary btn-block",
        text: "Add more",
        onClick: () => commitSprintDraft({ thenPrepare: false }),
      }),
      el("button", {
        className: "btn btn-ghost btn-block",
        text: "Prepare",
        onClick: () => commitSprintDraft({ thenPrepare: true }),
      }),
      el("button", {
        className: "btn btn-ghost btn-block",
        text: "← Back",
        onClick: () => {
          d.step = 1;
          render();
        },
      }),
    ]),
  ]);
}

function renderSprintArrange() {
  const total = sprintTotalMinutes();
  const list = el("div", { className: "stack", id: "sprint-list" });

  state.sprintItems.forEach((goal, index) => {
    const imp = Importance[goal.importance] || Importance.IMPORTANT;
    const editing = state.editingSprintId === goal.id;

    const item = el(
      "div",
      {
        className: "sortable-item",
        draggable: !editing,
        "data-index": String(index),
      },
      [
        el("span", { className: "handle", text: "⋮⋮" }),
        el("div", { style: "flex:1; min-width:0" }, [
          editing
            ? el("div", { className: "stack" }, [
                el("div", { className: "field" }, [
                  el("label", { text: "Title" }),
                  el("input", {
                    value: goal.title,
                    onInput: (e) => {
                      goal.title = e.target.value;
                    },
                  }),
                ]),
                el("div", { className: "field" }, [
                  el("label", { text: "Minutes" }),
                  el("input", {
                    type: "number",
                    min: "1",
                    value: String(goal.estimatedMinutes),
                    onInput: (e) => {
                      goal.estimatedMinutes = Math.max(1, Number(e.target.value) || 1);
                    },
                  }),
                ]),
                el("div", { className: "row" }, [
                  el("button", {
                    className: "btn btn-primary",
                    text: "Save",
                    style: "flex:1",
                    onClick: () => {
                      goal.title = goal.title.trim() || goal.title;
                      state.editingSprintId = null;
                      render();
                    },
                  }),
                  el("button", {
                    className: "btn btn-ghost",
                    text: "Cancel",
                    style: "flex:1",
                    onClick: () => {
                      state.editingSprintId = null;
                      render();
                    },
                  }),
                ]),
              ])
            : el("div", {}, [
                el("p", { className: "goal-title", style: "margin:0" }, [
                  el("span", { className: `dot ${imp.color}` }),
                  goal.title,
                ]),
                el("p", {
                  className: "meta",
                  text: packItemLabel(goal),
                }),
              ]),
        ]),
        !editing &&
          el("div", { className: "pack-actions" }, [
            el("button", {
              className: "icon-btn",
              text: "↑",
              title: "Move up",
              onClick: (e) => {
                e.stopPropagation();
                moveSprintItem(index, -1);
              },
            }),
            el("button", {
              className: "icon-btn",
              text: "↓",
              title: "Move down",
              onClick: (e) => {
                e.stopPropagation();
                moveSprintItem(index, 1);
              },
            }),
            el("button", {
              className: "icon-btn",
              text: "✎",
              title: "Quick edit",
              onClick: (e) => {
                e.stopPropagation();
                state.editingSprintId = goal.id;
                render();
              },
            }),
            el("button", {
              className: "icon-btn danger",
              text: "✕",
              title: "Remove",
              onClick: (e) => {
                e.stopPropagation();
                removeSprintItem(goal.id);
              },
            }),
          ]),
      ]
    );

    if (!editing) {
      item.addEventListener("dragstart", () => {
        item.classList.add("dragging");
        state.dragIndex = index;
      });
      item.addEventListener("dragend", () => {
        item.classList.remove("dragging");
        state.dragIndex = null;
      });
      item.addEventListener("dragover", (e) => {
        e.preventDefault();
      });
      item.addEventListener("drop", () => {
        const from = state.dragIndex;
        const to = index;
        if (from == null || from === to) return;
        const next = state.sprintItems.slice();
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        state.sprintItems = next;
        render();
      });
    }

    list.appendChild(item);
  });

  return shell([
    el("button", {
      className: "nav-back",
      text: "← Add tasks",
      onClick: () => {
        state.sprintDraft = { step: 1, title: "", estimatedMinutes: 25 };
        go("sprint");
      },
    }),
    el("div", { className: "panel stack" }, [
      el("h2", { text: "Prepare sprint" }),
      el("p", {
        className: "meta",
        text: `${state.sprintItems.length} task${state.sprintItems.length === 1 ? "" : "s"} · ${formatMinutes(total)} total. Drag or use arrows to arrange — temporary for this sprint only.`,
      }),
      el("div", { className: "row" }, [
        el("button", {
          className: "btn btn-ghost",
          text: "Shuffle",
          style: "flex:1",
          onClick: () => shuffleSprintItems(),
        }),
        el("button", {
          className: "btn btn-ghost",
          text: "Add more",
          style: "flex:1",
          onClick: () => {
            state.sprintDraft = { step: 1, title: "", estimatedMinutes: 25 };
            go("sprint");
          },
        }),
      ]),
      list,
      !state.sprintItems.length &&
        el("p", { className: "empty", text: "No sprint tasks yet. Add some first." }),
      el("button", {
        className: "btn btn-primary btn-block",
        text: "Start sprint",
        onClick: () => {
          if (!state.sprintItems.length) {
            showAlert("Add at least one task.");
            return;
          }
          const totalMins = sprintTotalMinutes();
          const firstTaskSecs = state.sprintItems[0].estimatedMinutes * 60;
          state.session = {
            mode: "sprint",
            queue: state.sprintItems.slice(),
            index: 0,
            sessionLeft: totalMins * 60,
            totalSeconds: totalMins * 60,
            taskTotal: firstTaskSecs,
            taskLeft: firstTaskSecs,
            paused: false,
            completed: [],
            skipped: [],
          };
          startTick();
          syncNativeTimers();
          go("focus");
        },
      }),
      el("button", {
        className: "btn btn-danger btn-block",
        text: "Cancel sprint",
        onClick: () => {
          state.sprintItems = [];
          state.sprintDraft = null;
          go("home");
        },
      }),
    ]),
  ]);
}

function packedTotalMinutes() {
  return state.packed.reduce((s, g) => s + g.estimatedMinutes, 0);
}

function shufflePacked() {
  const arr = state.packed.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  state.packed = arr;
  render();
}

function movePacked(index, delta) {
  const to = index + delta;
  if (to < 0 || to >= state.packed.length) return;
  const next = state.packed.slice();
  const [moved] = next.splice(index, 1);
  next.splice(to, 0, moved);
  state.packed = next;
  render();
}

function removeFromPacked(id) {
  state.packed = state.packed.filter((g) => g.id !== id);
  if (state.editingPackId === id) state.editingPackId = null;
  render();
}

function addToPacked(item) {
  if (state.packed.some((g) => g.id === item.id)) return;
  const nextTotal = packedTotalMinutes() + item.estimatedMinutes;
  const finishAdd = () => {
    state.packed = [...state.packed, { ...item }];
    state.arrangeAddOpen = false;
    render();
  };
  if (nextTotal > state.freeMinutes) {
    showConfirm(
      `This goes over your free time (${formatMinutes(nextTotal)} / ${formatMinutes(state.freeMinutes)}). Add anyway?`,
      finishAdd,
      {
        title: "Over free time",
        confirmLabel: "Add anyway",
        cancelLabel: "Cancel",
      }
    );
    return;
  }
  finishAdd();
}

function updatePackedItem(item, patch) {
  state.packed = state.packed.map((g) => (g.id === item.id ? { ...g, ...patch } : g));
  if (item.kind === "goal") {
    setGoals(
      state.goals.map((g) =>
        g.id === item.sourceId ? { ...g, ...patch, updatedAt: Date.now() } : g
      )
    );
  } else if (item.kind === "target") {
    setTargets(
      state.targets.map((t) =>
        t.id === item.sourceId ? { ...t, ...patch, updatedAt: Date.now() } : t
      )
    );
  }
}

function candidatesToAdd() {
  const inPack = new Set(state.packed.map((g) => g.id));
  const now = Date.now();
  const goals = activeGoals()
    .map((g) => goalToPackItem(g, now))
    .filter((g) => !inPack.has(g.id));
  const targets = availableTargets(state.targets, now)
    .map((t) => targetToPackItem(t, now))
    .filter((t) => !inPack.has(t.id));
  return [...goals, ...targets].sort((a, b) => b.score - a.score);
}

function renderArrange() {
  const total = packedTotalMinutes();
  const over = total > state.freeMinutes;
  const list = el("div", { className: "stack", id: "pack-list" });

  state.packed.forEach((goal, index) => {
    const imp = Importance[goal.importance];
    const editing = state.editingPackId === goal.id;

    const item = el("div", {
      className: "sortable-item",
      draggable: !editing,
      "data-index": String(index),
    }, [
      el("span", { className: "handle", text: "⋮⋮" }),
      el("div", { style: "flex:1; min-width:0" }, [
        editing
          ? el("div", { className: "stack" }, [
              el("div", { className: "field" }, [
                el("label", { text: "Title" }),
                el("input", {
                  value: goal.title,
                  onInput: (e) => {
                    goal.title = e.target.value;
                  },
                }),
              ]),
              el("div", { className: "field" }, [
                el("label", { text: "Minutes" }),
                el("input", {
                  type: "number",
                  min: "1",
                  value: String(goal.estimatedMinutes),
                  onInput: (e) => {
                    goal.estimatedMinutes = Math.max(1, Number(e.target.value) || 1);
                  },
                }),
              ]),
              el("div", { className: "row" }, [
                el("button", {
                  className: "btn btn-primary",
                  text: "Save",
                  style: "flex:1",
                  onClick: () => {
                    updatePackedItem(goal, {
                      title: goal.title.trim() || goal.title,
                      estimatedMinutes: goal.estimatedMinutes,
                    });
                    state.editingPackId = null;
                    render();
                  },
                }),
                el("button", {
                  className: "btn btn-ghost",
                  text: "Cancel",
                  style: "flex:1",
                  onClick: () => {
                    state.editingPackId = null;
                    render();
                  },
                }),
              ]),
            ])
          : el("div", {}, [
              el("p", { className: "goal-title", style: "margin:0" }, [
                el("span", { className: `dot ${imp.color}` }),
                goal.kind === "target" ? `◎ ${goal.title}` : goal.title,
              ]),
              el("p", {
                className: "meta",
                text: packItemLabel(goal),
              }),
            ]),
      ]),
      !editing &&
        el("div", { className: "stack", style: "gap:6px" }, [
          el("div", { className: "pack-actions" }, [
            el("button", {
              className: "icon-btn",
              text: "↑",
              title: "Move up",
              onClick: (e) => {
                e.stopPropagation();
                movePacked(index, -1);
              },
            }),
            el("button", {
              className: "icon-btn",
              text: "↓",
              title: "Move down",
              onClick: (e) => {
                e.stopPropagation();
                movePacked(index, 1);
              },
            }),
            el("button", {
              className: "icon-btn",
              text: "✎",
              title: "Quick edit",
              onClick: (e) => {
                e.stopPropagation();
                state.editingPackId = goal.id;
                render();
              },
            }),
            el("button", {
              className: "icon-btn danger",
              text: "✕",
              title: "Remove from stack",
              onClick: (e) => {
                e.stopPropagation();
                removeFromPacked(goal.id);
              },
            }),
          ]),
          renderItemActions(goal.kind, goal.sourceId),
        ]),
    ]);

    if (!editing) {
      item.addEventListener("dragstart", () => {
        item.classList.add("dragging");
        state.dragIndex = index;
      });
      item.addEventListener("dragend", () => {
        item.classList.remove("dragging");
        state.dragIndex = null;
      });
      item.addEventListener("dragover", (e) => {
        e.preventDefault();
      });
      item.addEventListener("drop", () => {
        const from = state.dragIndex;
        const to = index;
        if (from == null || from === to) return;
        const next = state.packed.slice();
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        state.packed = next;
        render();
      });
    }

    list.appendChild(item);
  });

  const addPool = candidatesToAdd();

  return shell([
    el("button", { className: "nav-back", text: "← Back", onClick: () => go("freetime") }),
    el("div", { className: "panel stack" }, [
      el("h2", { text: "Arrange your stack" }),
      el("p", {
        className: `meta ${over ? "warn" : ""}`,
        text: `${state.packed.length} tasks · ${formatMinutes(total)} of ${formatMinutes(state.freeMinutes)}${over ? " (over)" : ""}. Drag, shuffle, edit, or swap tasks.`,
      }),
      el("div", { className: "row" }, [
        el("button", {
          className: "btn btn-ghost",
          text: "Shuffle",
          style: "flex:1",
          onClick: () => shufflePacked(),
        }),
        el("button", {
          className: "btn btn-ghost",
          text: "Re-suggest",
          style: "flex:1",
          onClick: () => {
            state.packed = packTasks(state.goals, state.targets, state.freeMinutes);
            state.editingPackId = null;
            state.arrangeAddOpen = false;
            render();
          },
        }),
        el("button", {
          className: "btn btn-ghost",
          text: state.arrangeAddOpen ? "Hide add" : "Add task",
          style: "flex:1",
          onClick: () => {
            state.arrangeAddOpen = !state.arrangeAddOpen;
            render();
          },
        }),
      ]),
      list,
      !state.packed.length &&
        el("p", { className: "empty", text: "Stack is empty. Add a task to start." }),
      state.arrangeAddOpen &&
        el("div", { className: "add-pool stack" }, [
          el("p", { className: "step-meta", text: "Add from goals & targets" }),
          ...(addPool.length
            ? addPool.map((g) => {
                const imp = Importance[g.importance];
                return el("button", {
                  className: "choice",
                  onClick: () => addToPacked(g),
                }, [
                  el("span", { className: "label" }, [
                    el("span", { className: `dot ${imp.color}` }),
                    g.kind === "target" ? `◎ ${g.title}` : g.title,
                  ]),
                  el("span", {
                    className: "hint",
                    text: packItemLabel(g),
                  }),
                ]);
              })
            : [el("p", { className: "empty", text: "No other pending items." })]),
        ]),
      el("button", {
        className: "btn btn-primary btn-block",
        text: "Start focus",
        onClick: () => {
          if (!state.packed.length) {
            showAlert("Add at least one task.");
            return;
          }
          const firstTaskSecs = state.packed[0].estimatedMinutes * 60;
          state.session = {
            mode: "freetime",
            queue: state.packed.slice(),
            index: 0,
            sessionLeft: state.freeMinutes * 60,
            totalSeconds: state.freeMinutes * 60,
            taskTotal: firstTaskSecs,
            taskLeft: firstTaskSecs,
            paused: false,
            completed: [],
            skipped: [],
          };
          startTick();
          syncNativeTimers();
          go("focus");
        },
      }),
    ]),
  ]);
}

function renderTaskRing(session) {
  const total = Math.max(1, session.taskTotal || session.taskLeft || 1);
  const left = Math.max(0, session.taskLeft);
  const remaining = Math.min(1, left / total);
  const urgent = left <= 30 && left > 0;
  const size = 200;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - remaining);
  const cx = size / 2;
  const cy = size / 2;

  let ticksHtml = "";
  if (total >= 15 * 60) {
    const tickEvery = 15 * 60;
    for (let t = tickEvery; t < total; t += tickEvery) {
      const frac = t / total;
      const angle = frac * 2 * Math.PI;
      const inner = r - 6;
      const outer = r + 6;
      const x1 = cx + Math.cos(angle) * inner;
      const y1 = cy + Math.sin(angle) * inner;
      const x2 = cx + Math.cos(angle) * outer;
      const y2 = cy + Math.sin(angle) * outer;
      ticksHtml +=
        `<line class="task-ring-tick" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" ` +
        `x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" />`;
    }
  }

  const minsLeft = Math.max(0, Math.ceil(left / 60));
  const subText = session.paused
    ? "Paused"
    : left < 60
      ? `${left}s left`
      : `${minsLeft} min left · ${Math.round(remaining * 100)}%`;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("class", `task-ring-svg${urgent ? " is-urgent" : ""}${session.paused ? " is-paused" : ""}`);
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML =
    `<circle class="task-ring-track" cx="${cx}" cy="${cy}" r="${r}" ` +
    `fill="none" stroke-width="${stroke}"/>` +
    ticksHtml +
    `<circle class="task-ring-progress" cx="${cx}" cy="${cy}" r="${r}" ` +
    `fill="none" stroke-width="${stroke}" stroke-linecap="round" ` +
    `stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/>`;

  return el(
    "div",
    { className: `task-ring${urgent ? " is-urgent" : ""}${session.paused ? " is-paused" : ""}` },
    [
      svg,
      el("div", { className: "task-ring-center" }, [
        el("div", { className: "name", text: "This task" }),
        el("div", { className: "time", text: formatClock(left) }),
        el("div", {
          className: "task-ring-sub",
          text: subText,
        }),
      ]),
    ]
  );
}

function renderFocus() {
  const session = state.session;
  const current = session.queue[session.index];
  const upcoming = session.queue.slice(session.index + 1);
  const imp = Importance[current.importance] || Importance.IMPORTANT;
  const isSprint = session.mode === "sprint";
  // Backfill taskTotal for any in-flight session started before this feature
  if (!session.taskTotal) {
    session.taskTotal = Math.max(session.taskLeft, current.estimatedMinutes * 60);
  }
  const sessionTotal = Math.max(1, session.totalSeconds || session.sessionLeft || 1);
  const sessionElapsed = Math.min(1, (sessionTotal - session.sessionLeft) / sessionTotal);
  const sessionMinsLeft = Math.max(0, Math.ceil(session.sessionLeft / 60));

  return shell([
    el("div", { className: "panel stack focus-panel" }, [
      el("div", { className: "session-strip" }, [
        el("span", { className: "name", text: isSprint ? "Sprint" : "Session" }),
        el("span", {
          className: "time",
          text: `${formatClock(session.sessionLeft)} · ${sessionMinsLeft} min left`,
        }),
      ]),
      el("div", {
        className: "session-progress",
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": String(Math.round(sessionElapsed * 100)),
      }, [
        el("div", {
          className: "session-progress-fill",
          style: `width:${Math.round(sessionElapsed * 100)}%`,
        }),
      ]),
      renderTaskRing(session),
      el("div", {}, [
        el("p", {
          className: "step-meta",
          text: `${isSprint ? "Sprint" : "Task"} ${session.index + 1} of ${session.queue.length}`,
        }),
        el("h2", {}, [
          el("span", { className: `dot ${imp.color}` }),
          current.title,
        ]),
        el("p", { className: "meta", text: packItemLabel(current) }),
      ]),
      el("div", { className: "row" }, [
        el("button", {
          className: "btn btn-primary",
          text: "Done",
          style: "flex:1",
          onClick: () => {
            flashComplete();
            session.completed.push(current.id);
            autoAdvance("done");
          },
        }),
        el("button", {
          className: "btn btn-ghost",
          text: "Skip",
          style: "flex:1",
          onClick: () => {
            session.skipped.push(current.id);
            autoAdvance("skip");
          },
        }),
      ]),
      el("button", {
        className: "btn btn-ghost btn-block",
        text: session.paused ? "Resume" : "Pause",
        onClick: () => {
          session.paused = !session.paused;
          syncNativeTimers();
          render();
        },
      }),
      el("button", {
        className: "btn btn-ghost btn-block",
        text: "Leave (keep running)",
        onClick: () => go("home"),
      }),
      el("button", {
        className: "btn btn-danger btn-block",
        text: isSprint ? "End sprint" : "End session",
        onClick: () => endSession(),
      }),
      upcoming.length
        ? el("div", {}, [
            el("p", { className: "step-meta", text: "Up next" }),
            ...upcoming.slice(0, 3).map((g) =>
              el("p", {
                className: "meta",
                text: `${g.title} · ${formatMinutes(g.estimatedMinutes)}`,
              })
            ),
          ])
        : null,
    ]),
  ]);
}

function renderSummary() {
  const s = state.summary;
  const isSprint = s.mode === "sprint";
  return shell([
    el("div", { className: "panel stack" }, [
      el("h2", { text: isSprint ? "Sprint done" : "Session done" }),
      el("div", { className: "summary-stat" }, [
        el("span", { text: "Completed" }),
        el("strong", { text: String(s.completed) }),
      ]),
      el("div", { className: "summary-stat" }, [
        el("span", { text: "Skipped" }),
        el("strong", { text: String(s.skipped) }),
      ]),
      el("div", { className: "summary-stat" }, [
        el("span", { text: "Time used" }),
        el("strong", { text: formatClock(s.usedSeconds) }),
      ]),
      el("p", {
        className: "meta",
        text: "Skipped is allowed. Come back when you’re ready.",
      }),
      isSprint
        ? el("p", {
            className: "meta",
            text: "Sprint tasks were temporary and weren’t saved.",
          })
        : null,
      el("button", {
        className: "btn btn-primary btn-block",
        text: "Back home",
        onClick: () => go("home"),
      }),
    ]),
  ]);
}

render();
startReminderPoll();
syncNativeReminders();
if (
  getNotificationMode() !== "off" &&
  state.reminders.some((r) => r.status === "SCHEDULED")
) {
  ensureNotificationPermission();
}
