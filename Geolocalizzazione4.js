/**
 * geo-start.js — RallyNav Geolocation Start Banner + GPS Adaptive Race Navigator
 * ────────────────────────────────────────────────────────────────────────────────
 *
 * MODULO 1 — Start Banner
 *   Mostra un banner quando il pilota è vicino al punto di partenza.
 *
 * MODULO 2 — GPS Adaptive Race Navigator
 *   Logica di avanzamento basata su TEMPO DI ARRIVO, non distanza fissa.
 *
 *   Formula core:
 *     ETA_s = distanza_m / velocità_ms          ← secondi alla nota
 *     SOGLIA_s = leadTime(nota) + latenza_TTS   ← quanto preavviso serve
 *     → avanza quando ETA_s ≤ SOGLIA_s
 *
 *   leadTime per tipo di nota:
 *     tornante / hairpin  → 6s   (serve frenata e cambio marcia)
 *     curva stretta (4-6) → 5s
 *     curva media  (3)    → 4s
 *     curva ampia  (1-2)  → 3s
 *     chicane             → 5s   (doppia direzione)
 *     rettilineo / dritto → 2s
 *
 *   Il preavviso vocale (speakCurrentNote) viene sparato a 2×leadTime
 *   così il pilota sente la lettura PRIMA che il passo sia avanzato.
 *
 *   Velocità: media mobile smoothed su 5 fix GPS (evita spike).
 *   Fallback: se GPS non ha speed, usa la speed_kmh della nota corrente.
 *
 * Variabili globali lette dal viewer:
 *   window.raceIdx, window.raceNotes, window.raceNext(),
 *   window.renderRaceNote(), window.speakCurrentNote(), window.routeData
 */

(function GeoStartAndRace() {
  'use strict';

  // ══════════════════════════════════════════════════════════════
  // ── CONFIGURAZIONE ───────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════

  // Banner di partenza
  const PROXIMITY_M = 100;
  const DISMISS_M   = 250;
  const VIBRATE_PAT = [80, 60, 120];

  // Preavviso minimo/massimo in secondi per tipo di nota
  // (tempo tra il momento in cui il passo viene mostrato e il momento
  //  in cui si arriva fisicamente alla coordinata)
  const LEAD_TIME = {
    tornante : 6.5,   // hairpin, rotatoria — massimo preavviso
    stretta  : 5.0,   // curva angolo 4-6
    media    : 4.0,   // curva angolo 3
    ampia    : 3.0,   // curva angolo 1-2
    chicane  : 5.5,   // doppia inversione
    dritta   : 2.0,   // rettilineo / dritto
    default  : 4.0,
  };

  // Latenza attesa per TTS (WaveNet ~0.8s, fallback browser ~0.3s)
  const TTS_LATENCY_S = 0.9;

  // Preavviso vocale: lo spariamo a questo multiplo del lead time
  // (es. 1.8× → se lead=5s, voce parte a 9s dall'arrivo)
  const VOICE_FACTOR = 1.8;

  // Velocità GPS: numero di fix usati per la media mobile
  const SPEED_SMOOTH_N = 5;

  // Velocità minima sotto cui non triggeriamo (fermi o camminata)
  const SPEED_MIN_MS = 2.0;   // ~7 km/h

  // Accuratezza GPS massima per fidarsi del fix
  const GPS_ACC_MAX_M = 40;

  // Distanza di sicurezza assoluta: anche a 0 km/h, avanza se < X metri
  const FORCE_TRIGGER_M = 25;

  // Distanza massima per il pre-annuncio (cap) — evita annunci troppo presto
  const PREWARN_CAP_M = 200;

  // Intervallo refresh HUD
  const HUD_TICK_MS = 600;

  const WATCH_OPTS = { enableHighAccuracy: true, maximumAge: 500, timeout: 15000 };

  const VIBRATE_ADV = [50, 40, 90, 40, 50];

  // ══════════════════════════════════════════════════════════════
  // ── STATO ────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════

  // Banner
  let startCoord  = null;
  let bannerWatchId = null;
  let bannerEl    = null;
  let bannerShown = false;
  let dismissed   = false;
  let raceStarted = false;

  // GPS Race Navigator
  let gpsActive      = false;
  let gpsAutoScroll  = true;
  let lastPos        = null;    // { lat, lon, accuracy, speedMs, ts }
  let speedHistory   = [];      // ultimi N valori di velocità in m/s
  let hudEl          = null;
  let hudTimer       = null;
  let raceWatchId    = null;

  // Per ogni nota: stato { prewarn: bool, triggered: bool }
  let noteState      = {};      // noteState[idx] = { prewarn, triggered }

  // ══════════════════════════════════════════════════════════════
  // ── UTILITÀ ──────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════

  function distM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * Math.PI / 180)
            * Math.cos(lat2 * Math.PI / 180)
            * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function vibrate(pat) {
    try { if (navigator.vibrate) navigator.vibrate(pat); } catch (_) {}
  }

  /** Media mobile smoothed della velocità (m/s) */
  function smoothSpeed(newSample) {
    if (newSample != null && newSample >= 0) {
      speedHistory.push(newSample);
      if (speedHistory.length > SPEED_SMOOTH_N) speedHistory.shift();
    }
    if (speedHistory.length === 0) return null;
    const sum = speedHistory.reduce((a, b) => a + b, 0);
    return sum / speedHistory.length;
  }

  /**
   * Stima la velocità corrente in m/s.
   * Priorità: GPS speed smoothed → speed_kmh nota corrente → null
   */
  function estimateSpeedMs() {
    const smoothed = smoothSpeed(null); // legge senza aggiungere
    if (smoothed != null && smoothed >= SPEED_MIN_MS) return smoothed;

    // Fallback: usa speed_kmh della nota corrente
    const notes = window.raceNotes;
    const idx   = window.raceIdx;
    const note  = notes?.[idx];
    if (note?.speed_kmh) return note.speed_kmh / 3.6;

    return null;
  }

  /**
   * Determina il lead time in secondi in base al tipo di nota.
   * Legge: note.turn_angle, note.direction, note.is_chicane
   */
  function noteLeadTime(note) {
    if (!note) return LEAD_TIME.default;

    const dir = (note.direction || '').toLowerCase();
    const ang = note.turn_angle || 0;

    if (note.is_chicane)                           return LEAD_TIME.chicane;
    if (dir.includes('tornante') || dir.includes('hairpin') || ang >= 6)
                                                   return LEAD_TIME.tornante;
    if (ang >= 4)                                  return LEAD_TIME.stretta;
    if (ang === 3)                                 return LEAD_TIME.media;
    if (ang >= 1 && ang <= 2)                      return LEAD_TIME.ampia;
    if (dir.includes('dritto') || dir.includes('rettilineo') || dir.includes('straight'))
                                                   return LEAD_TIME.dritta;

    // Nessun angolo definito: usa la speed per stimare il tipo
    const spd = note.speed_kmh || 0;
    if (spd >= 120) return LEAD_TIME.dritta;
    if (spd >= 80)  return LEAD_TIME.ampia;
    if (spd >= 50)  return LEAD_TIME.media;
    return LEAD_TIME.default;
  }

  /**
   * Calcola la distanza di trigger in metri dato:
   *  - velocità corrente (m/s)
   *  - lead time richiesto dalla nota (s)
   *  - latenza TTS (s)
   * Ritorna anche la distanza di pre-annuncio vocale.
   */
  function computeTriggerDist(speedMs, note) {
    const lead    = noteLeadTime(note);
    const trigDist = speedMs * (lead + TTS_LATENCY_S);
    const voiceDist = Math.min(speedMs * lead * VOICE_FACTOR, PREWARN_CAP_M);
    return {
      trigDist : Math.max(trigDist, FORCE_TRIGGER_M),
      voiceDist: Math.max(voiceDist, trigDist * 1.4),
      leadTime : lead,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // ── MODULO 1 — START BANNER ──────────────────────────────────
  // ══════════════════════════════════════════════════════════════

  function createBanner() {
    if (bannerEl) return;
    bannerEl = document.createElement('div');
    bannerEl.id = 'geoStartBanner';
    bannerEl.setAttribute('style', `
      position:fixed; bottom:0; left:0; right:0; z-index:99000;
      background:linear-gradient(135deg,#0d1117 0%,#111820 100%);
      border-top:2px solid #e8c230; padding:14px 18px 18px;
      display:flex; align-items:center; gap:14px;
      box-shadow:0 -8px 32px rgba(0,0,0,.7);
      font-family:'Barlow Condensed','Rajdhani',sans-serif;
      transform:translateY(110%);
      transition:transform .35s cubic-bezier(.22,.68,0,1.2);
      will-change:transform;
    `);
    bannerEl.setAttribute('role', 'alert');
    bannerEl.setAttribute('aria-live', 'assertive');
    bannerEl.innerHTML = `
      <div id="gsb-pulse" style="width:14px;height:14px;border-radius:50%;background:#2ecc71;flex-shrink:0;
        box-shadow:0 0 0 0 rgba(46,204,113,.7);animation:gsbPulse 1.4s ease-out infinite;"></div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:11px;letter-spacing:2.5px;text-transform:uppercase;color:#6a7385;margin-bottom:2px;">
          📍 SEI VICINO ALLA PARTENZA</div>
        <div id="gsb-title" style="font-size:19px;font-weight:700;letter-spacing:1px;color:#e8eaf0;
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">—</div>
        <div id="gsb-dist" style="font-family:'Share Tech Mono',monospace;font-size:12px;color:#e8c230;margin-top:2px;">— m</div>
      </div>
      <button id="gsb-start" style="flex-shrink:0;background:#e8c230;color:#000;border:none;border-radius:5px;
        font-family:'Rajdhani','Barlow Condensed',sans-serif;font-size:15px;font-weight:700;letter-spacing:2px;
        text-transform:uppercase;padding:10px 20px;cursor:pointer;white-space:nowrap;
        box-shadow:0 0 12px rgba(232,194,48,.4);transition:background .15s,transform .1s;">🏁 INIZIA CORSA</button>
      <button id="gsb-close" style="flex-shrink:0;background:none;border:1px solid #2a3040;color:#6a7385;
        border-radius:4px;font-size:18px;line-height:1;width:32px;height:32px;cursor:pointer;
        transition:border-color .15s,color .15s;display:flex;align-items:center;justify-content:center;"
        title="Ignora" aria-label="Chiudi banner">✕</button>
      <style>
        @keyframes gsbPulse{0%{box-shadow:0 0 0 0 rgba(46,204,113,.7)}70%{box-shadow:0 0 0 10px rgba(46,204,113,0)}100%{box-shadow:0 0 0 0 rgba(46,204,113,0)}}
        #gsb-start:hover{background:#f5d050;transform:scale(1.03)}
        #gsb-start:active{transform:scale(.97)}
        #gsb-close:hover{border-color:#e8c230;color:#e8c230}
      </style>`;
    document.body.appendChild(bannerEl);

    document.getElementById('gsb-start').addEventListener('click', () => {
      raceStarted = true;
      hideBanner(true);
      stopBannerWatch();
      if (typeof window.enterRaceMode === 'function') window.enterRaceMode();
      setTimeout(startGpsNavigator, 400);
    });
    document.getElementById('gsb-close').addEventListener('click', () => {
      dismissed = true;
      hideBanner(true);
    });
  }

  function showBanner(d, name) {
    if (dismissed || raceStarted || !bannerEl) return;
    document.getElementById('gsb-title').textContent = name || 'Percorso caricato';
    document.getElementById('gsb-dist').textContent  = `${Math.round(d)} m dalla partenza`;
    if (!bannerShown) {
      bannerEl.style.transform = 'translateY(0)';
      bannerShown = true;
      vibrate(VIBRATE_PAT);
    }
  }
  function hideBanner(force = false) {
    if (!bannerEl || (!bannerShown && !force)) return;
    bannerEl.style.transform = 'translateY(110%)';
    bannerShown = false;
  }
  function stopBannerWatch() {
    if (bannerWatchId !== null) { navigator.geolocation.clearWatch(bannerWatchId); bannerWatchId = null; }
  }
  function startBannerWatch() {
    if (!('geolocation' in navigator) || bannerWatchId !== null) return;
    bannerWatchId = navigator.geolocation.watchPosition(onBannerPos, onBannerErr, WATCH_OPTS);
  }
  function onBannerPos(pos) {
    if (!startCoord || raceStarted) return;
    const d = distM(pos.coords.latitude, pos.coords.longitude, startCoord.lat, startCoord.lon);
    if (d <= PROXIMITY_M) showBanner(d, window.routeData?.route?.start?.name || 'Percorso');
    else if (d > DISMISS_M && bannerShown && !dismissed) hideBanner();
  }
  function onBannerErr(err) {
    if (err.code === 1) stopBannerWatch();
  }

  // ══════════════════════════════════════════════════════════════
  // ── MODULO 2 — GPS ADAPTIVE RACE NAVIGATOR ───────────────────
  // ══════════════════════════════════════════════════════════════

  // ── HUD ──────────────────────────────────────────────────────

  function createHud() {
    if (hudEl) return;

    hudEl = document.createElement('div');
    hudEl.id = 'gpsRaceHud';
    hudEl.setAttribute('style', `
      position:absolute; top:50px; right:10px; z-index:10;
      background:rgba(10,12,15,.88); border:1px solid #2a3040; border-radius:10px;
      padding:9px 13px; display:flex; flex-direction:column; align-items:flex-end; gap:3px;
      font-family:'Share Tech Mono',monospace; font-size:11px; min-width:140px;
      backdrop-filter:blur(6px); cursor:pointer; user-select:none;
      transition:border-color .2s;
    `);
    hudEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;width:100%;justify-content:space-between;">
        <span id="gpsHudDot" style="width:8px;height:8px;border-radius:50%;background:#6a7385;flex-shrink:0;transition:background .3s;"></span>
        <span id="gpsHudLabel" style="font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:#6a7385;flex:1;text-align:center;">GPS IN ATTESA</span>
        <span id="gpsHudAutoIcon" style="font-size:12px;line-height:1;" title="Auto attivo">🟢</span>
      </div>
      <div id="gpsHudDist" style="font-size:24px;font-weight:700;color:#e8c230;line-height:1;letter-spacing:1px;">—</div>
      <div id="gpsHudEta"  style="font-size:13px;color:#e8eaf0;font-weight:700;line-height:1;">— s</div>
      <div id="gpsHudSpdRow" style="display:flex;gap:8px;align-items:center;margin-top:1px;">
        <span id="gpsHudSpd"  style="color:#3b9eff;font-size:11px;">— km/h</span>
        <span id="gpsHudAcc"  style="color:#6a7385;font-size:10px;">±—m</span>
      </div>
      <div id="gpsHudLead" style="font-size:9px;color:#6a7385;letter-spacing:1px;">preavviso: —s</div>
      <style>
        #gpsRaceHud:hover { border-color:#e8c230 !important; }
        #gpsRaceHud.auto-off { border-color:#ff4d1a !important; }
        #gpsRaceHud .st-prewarn { color:#ff8c00 !important; }
        #gpsRaceHud .st-trigger { color:#2ecc71 !important; }
        @keyframes hudPulse { 0%,100%{opacity:.5} 50%{opacity:1} }
        .hud-blink { animation: hudPulse .55s ease-in-out infinite; }
      </style>`;

    hudEl.addEventListener('click', () => {
      gpsAutoScroll = !gpsAutoScroll;
      updateHudAutoIcon();
      showGpsToast(gpsAutoScroll ? '🟢 Auto-scroll GPS ATTIVO' : '🔴 Manuale — tap HUD per riattivare');
    });

    const overlay = document.getElementById('raceOverlay');
    (overlay || document.body).appendChild(hudEl);
    if (overlay) overlay.style.position = overlay.style.position || 'fixed';
  }

  function updateHudAutoIcon() {
    const ic = document.getElementById('gpsHudAutoIcon');
    const hd = document.getElementById('gpsRaceHud');
    if (!ic || !hd) return;
    ic.textContent = gpsAutoScroll ? '🟢' : '🔴';
    hd.classList.toggle('auto-off', !gpsAutoScroll);
  }

  /**
   * Aggiorna l'HUD con distanza, ETA, velocità, accuratezza, lead time.
   * state: 'normal' | 'prewarn' | 'trigger' | 'wait' | 'done'
   */
  function updateHud({ distMeters, etaSec, speedMs, accuracy, leadTime, state } = {}) {
    const distEl  = document.getElementById('gpsHudDist');
    const etaEl   = document.getElementById('gpsHudEta');
    const spdEl   = document.getElementById('gpsHudSpd');
    const accEl   = document.getElementById('gpsHudAcc');
    const leadEl  = document.getElementById('gpsHudLead');
    const dotEl   = document.getElementById('gpsHudDot');
    const lblEl   = document.getElementById('gpsHudLabel');
    if (!distEl) return;

    // Dot colore GPS accuracy
    dotEl.style.background = accuracy == null ? '#6a7385'
      : accuracy <= 20 ? '#2ecc71'
      : accuracy <= 40 ? '#e8c230'
      : '#ff4d1a';

    // Velocità — mostra anche valori bassi (iOS non fornisce coords.speed)
    const rawSpd = lastPos?.speedMs;
    const displaySpd = speedMs != null ? speedMs : (rawSpd != null ? rawSpd : null);
    spdEl.textContent = displaySpd != null ? `${Math.round(displaySpd * 3.6)} km/h` : '— km/h';
    spdEl.style.color = displaySpd != null && displaySpd >= SPEED_MIN_MS ? '#3b9eff' : '#6a7385';

    accEl.textContent = accuracy != null ? `±${Math.round(accuracy)}m` : '±—m';

    // Lead time
    if (leadTime != null) {
      leadEl.textContent = `preavviso: ${leadTime.toFixed(1)}s`;
    }

    // Distanza & ETA
    if (distMeters == null) {
      distEl.textContent = '—';
      etaEl.textContent  = '— s';
      distEl.className   = '';
      etaEl.className    = '';
      if (state === 'done') {
        lblEl.textContent = '🏁 FINE';
        lblEl.style.color = '#2ecc71';
      } else if (lastPos) {
        // Fix GPS ricevuto, ma siamo fermi
        lblEl.textContent = '🔵 IN ATTESA MOVIMENTO';
        lblEl.style.color = '#3b9eff';
      } else {
        // Nessun fix GPS ancora
        lblEl.textContent = '🟡 IN ATTESA SEGNALE GPS';
        lblEl.style.color = '#e8c230';
      }
      return;
    }

    const dm = Math.round(distMeters);
    distEl.textContent = dm < 1000 ? `${dm}m` : `${(distMeters/1000).toFixed(1)}km`;

    if (etaSec != null) {
      etaEl.textContent = etaSec < 60 ? `${etaSec.toFixed(1)}s` : `${(etaSec/60).toFixed(1)}min`;
    } else {
      etaEl.textContent = '—';
    }

    switch (state) {
      case 'prewarn':
        distEl.className = 'st-prewarn hud-blink';
        etaEl.className  = 'st-prewarn';
        lblEl.textContent = '⚠ VOCE IN USCITA';
        lblEl.style.color = '#ff8c00';
        break;
      case 'trigger':
        distEl.className = 'st-trigger';
        etaEl.className  = 'st-trigger';
        lblEl.textContent = '✔ AVANZATO';
        lblEl.style.color = '#2ecc71';
        break;
      default:
        distEl.className = '';
        etaEl.className  = '';
        lblEl.textContent = 'ALLA NOTA';
        lblEl.style.color = '#6a7385';
    }
  }

  // ── Toast ─────────────────────────────────────────────────────

  function showGpsToast(msg) {
    let t = document.getElementById('gpsRaceToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'gpsRaceToast';
      t.setAttribute('style', `
        position:fixed; bottom:130px; left:50%; transform:translateX(-50%);
        z-index:100000; background:rgba(10,12,15,.93); border:1px solid #2a3040;
        border-radius:20px; padding:7px 18px;
        font-family:'Rajdhani',sans-serif; font-size:14px; font-weight:600;
        letter-spacing:1px; color:#e8eaf0; white-space:nowrap;
        opacity:0; transition:opacity .22s; pointer-events:none;
      `);
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._t);
    t._t = setTimeout(() => { t.style.opacity = '0'; }, 2400);
  }

  // ── GPS Watch ─────────────────────────────────────────────────

  function startGpsNavigator() {
    if (!('geolocation' in navigator)) {
      showGpsToast('⚠ GPS non disponibile');
      return;
    }
    gpsActive     = true;
    gpsAutoScroll = true;
    speedHistory  = [];
    noteState     = {};

    createHud();
    updateHudAutoIcon();

    if (raceWatchId !== null) navigator.geolocation.clearWatch(raceWatchId);
    raceWatchId = navigator.geolocation.watchPosition(onRacePos, onRaceErr, WATCH_OPTS);

    clearInterval(hudTimer);
    hudTimer = setInterval(refreshHudTick, HUD_TICK_MS);

    showGpsToast('📡 GPS Adaptive Navigator ATTIVO');
  }

  function stopGpsNavigator() {
    gpsActive = false;
    if (raceWatchId !== null) { navigator.geolocation.clearWatch(raceWatchId); raceWatchId = null; }
    clearInterval(hudTimer); hudTimer = null;
    lastPos = null; speedHistory = [];
    if (hudEl) { hudEl.style.transition = 'opacity .5s'; hudEl.style.opacity = '0';
      setTimeout(() => { if (hudEl) { hudEl.style.opacity='1'; hudEl.style.transition=''; }}, 4000); }
  }

  function onRacePos(pos) {
    if (!gpsActive) return;

    const newLat = pos.coords.latitude;
    const newLon = pos.coords.longitude;
    const newTs  = pos.timestamp;

    // Velocità: prova coords.speed (funziona su Android), altrimenti
    // la calcola dai fix consecutivi (necessario su iOS Safari).
    let rawSpeedMs = null;
    if (pos.coords.speed != null && pos.coords.speed >= 0) {
      rawSpeedMs = pos.coords.speed;
    } else if (lastPos && lastPos.ts) {
      const dtMs = newTs - lastPos.ts;
      if (dtMs > 200 && dtMs < 10000) {          // fix ragionevole: 0.2s–10s
        const dM = distM(lastPos.lat, lastPos.lon, newLat, newLon);
        const computed = dM / (dtMs / 1000);
        // Filtra spike impossibili (>250 km/h = 69 m/s)
        if (computed >= 0 && computed < 69) rawSpeedMs = computed;
      }
    }

    smoothSpeed(rawSpeedMs);

    const isFirstFix = !lastPos;

    lastPos = {
      lat:      newLat,
      lon:      newLon,
      accuracy: pos.coords.accuracy,
      speedMs:  rawSpeedMs,
      ts:       newTs,
    };

    // Toast di conferma al primo fix GPS (utile per debug su iOS)
    if (isFirstFix) {
      const accStr = pos.coords.accuracy != null ? `±${Math.round(pos.coords.accuracy)}m` : '?';
      showGpsToast(`📡 GPS agganciato — acc ${accStr}`);
    }

    checkAdaptiveProximity();
  }

  function onRaceErr(err) {
    updateHud({ state: 'wait' });
    if (err.code === 1) {
      showGpsToast('⚠ Permesso GPS negato');
      gpsAutoScroll = false;
      updateHudAutoIcon();
      stopGpsNavigator();
    }
  }

  /** Tick periodico per refresh HUD anche senza nuovi fix GPS */
  function refreshHudTick() {
    if (!lastPos) { updateHud({ state: 'wait' }); return; }
    const notes = window.raceNotes;
    const idx   = window.raceIdx;
    if (!notes?.length) return;

    const tIdx = findNextNoteWithCoord(idx);
    if (tIdx == null) { updateHud({ state: 'done' }); return; }

    const note   = notes[tIdx];
    const d      = distM(lastPos.lat, lastPos.lon, note.coord.lat, note.coord.lon);
    const speedMs = estimateSpeedMs();
    const eta    = speedMs != null && speedMs > 0 ? d / speedMs : null;
    const lead   = noteLeadTime(note);
    const ns     = noteState[tIdx] || {};

    const state = ns.triggered ? 'trigger'
                : ns.prewarn   ? 'prewarn'
                : 'normal';

    updateHud({ distMeters: d, etaSec: eta, speedMs, accuracy: lastPos.accuracy, leadTime: lead, state });
  }

  // ── Core logic ────────────────────────────────────────────────

  /**
   * Logica adattiva principale — chiamata ad ogni fix GPS.
   *
   * Due fasi:
   *  1. PRE-ANNUNCIO VOCALE  → quando ETA ≤ leadTime × VOICE_FACTOR
   *     Parla la nota CORRENTE (anticipa la lettura)
   *     MA NON avanza ancora il passo.
   *
   *  2. TRIGGER / AVANZAMENTO → quando ETA ≤ leadTime + TTS_LATENCY_S
   *     (o distanza < FORCE_TRIGGER_M se fermi)
   *     Avanza il passo così il pilota vede la nota mentre il TTS sta parlando.
   */
  function checkAdaptiveProximity() {
    if (!lastPos || !gpsActive || !gpsAutoScroll) return;

    const notes = window.raceNotes;
    const idx   = window.raceIdx;
    if (!notes?.length || idx == null) return;

    const tIdx = findNextNoteWithCoord(idx);
    if (tIdx == null) return;   // fine percorso

    const note = notes[tIdx];
    if (!note?.coord?.lat) return;

    // Accuratezza GPS: se troppo bassa, solo force trigger
    const accOk = lastPos.accuracy <= GPS_ACC_MAX_M;

    const d       = distM(lastPos.lat, lastPos.lon, note.coord.lat, note.coord.lon);
    const speedMs = estimateSpeedMs();
    const eta     = (speedMs != null && speedMs > SPEED_MIN_MS) ? d / speedMs : null;
    const lead    = noteLeadTime(note);

    if (!noteState[tIdx]) noteState[tIdx] = { prewarn: false, triggered: false };
    const ns = noteState[tIdx];

    if (ns.triggered) return;   // già processata

    // ── FASE 1: pre-annuncio vocale ────────────────────────────
    // Condizione: ETA ≤ lead × VOICE_FACTOR  E  distanza ≤ PREWARN_CAP_M
    const voiceThreshSec = lead * VOICE_FACTOR;
    const shouldPrewarn  = accOk && !ns.prewarn && (
      (eta != null && eta <= voiceThreshSec) ||
      d <= Math.min(speedMs != null ? speedMs * voiceThreshSec : PREWARN_CAP_M, PREWARN_CAP_M)
    );

    if (shouldPrewarn) {
      ns.prewarn = true;
      // Parla la nota CORRENTE (quella che sta per arrivare = tIdx-1 scroll già avanzato
      // Oppure usa speakCurrentNote che legge window.raceIdx, quindi ancora la nota corrente
      if (typeof window.speakCurrentNote === 'function') {
        // Prepara l'audio della PROSSIMA nota: salviamo raceIdx, lo impostiamo
        // temporaneamente, lo restauriamo subito dopo la chiamata.
        // NB: non cambia la UI — solo spara il TTS della nota successiva.
        const savedIdx = window.raceIdx;
        window.raceIdx = tIdx - 1;   // nota corrente da leggere (quella che stiamo per avanzare)
        window.speakCurrentNote();
        window.raceIdx = savedIdx;
      }
      const etaStr = eta != null ? `${eta.toFixed(1)}s` : `${Math.round(d)}m`;
      showGpsToast(`📣 ${noteTypeLabel(note)} tra ${etaStr}`);
    }

    // ── FASE 2: trigger avanzamento ───────────────────────────
    const trigDistM  = speedMs != null ? speedMs * (lead + TTS_LATENCY_S) : FORCE_TRIGGER_M;
    const shouldTrig = (
      (accOk && eta != null && eta <= (lead + TTS_LATENCY_S)) ||
      d <= FORCE_TRIGGER_M ||
      (accOk && d <= trigDistM)
    );

    if (shouldTrig) {
      ns.triggered = true;

      vibrate(VIBRATE_ADV);

      if (window.raceIdx < tIdx) {
        if (typeof window.raceNext === 'function') {
          window.raceNext();
        } else {
          window.raceIdx = tIdx;
          if (typeof window.renderRaceNote === 'function') window.renderRaceNote();
          if (typeof window.speakCurrentNote === 'function') window.speakCurrentNote();
        }
      }

      const etaStr = eta != null ? `${eta.toFixed(1)}s` : `${Math.round(d)}m`;
      showGpsToast(`✅ ${noteTypeLabel(note)} — ${etaStr}`);
    }
  }

  /** Etichetta leggibile del tipo di nota per i toast */
  function noteTypeLabel(note) {
    if (!note) return 'Nota';
    const dir = (note.direction || '').toLowerCase();
    if (note.is_chicane) return '⇄ Chicane';
    if (dir.includes('tornante')) return '🔄 Tornante';
    if (dir.includes('sinistra') || dir.includes('left'))  return '↰ Sinistra';
    if (dir.includes('destra')   || dir.includes('right')) return '↱ Destra';
    if (dir.includes('dritto') || dir.includes('straight')) return '⬆ Dritto';
    return '📍 ' + (note.direction || 'Nota');
  }

  function findNextNoteWithCoord(currentIdx) {
    const notes = window.raceNotes;
    if (!notes) return null;
    for (let i = currentIdx + 1; i < notes.length; i++) {
      if (notes[i]?.coord?.lat && notes[i]?.coord?.lon) return i;
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════════
  // ── HOOKS SU FUNZIONI DEL VIEWER ─────────────────────────────
  // ══════════════════════════════════════════════════════════════

  (function wrapEnterRaceMode() {
    const _orig = window.enterRaceMode;
    window.enterRaceMode = function (...a) {
      if (typeof _orig === 'function') _orig.apply(this, a);
      setTimeout(startGpsNavigator, 300);
    };
  })();

  (function wrapExitRaceMode() {
    const _orig = window.exitRaceMode;
    window.exitRaceMode = function (...a) {
      stopGpsNavigator();
      if (typeof _orig === 'function') _orig.apply(this, a);
    };
  })();

  (function wrapRaceNav() {
    const _next = window.raceNext;
    const _prev = window.racePrev;
    window.raceNext = function (...a) {
      // Reset stato pre-annuncio per la nota appena saltata manualmente
      const tIdx = findNextNoteWithCoord(window.raceIdx);
      if (tIdx != null && noteState[tIdx]) noteState[tIdx].prewarn = false;
      if (typeof _next === 'function') _next.apply(this, a);
    };
    window.racePrev = function (...a) {
      // Torna indietro: ri-abilita il trigger della nota che stiamo ri-visitando
      const curIdx = window.raceIdx;
      if (curIdx > 0 && noteState[curIdx]) {
        noteState[curIdx] = { prewarn: false, triggered: false };
      }
      if (typeof _prev === 'function') _prev.apply(this, a);
    };
  })();

  // ══════════════════════════════════════════════════════════════
  // ── EVENTO routeloaded ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════════

  window.addEventListener('rallynav:routeloaded', (e) => {
    const data  = e.detail;
    const coord = data?.route?.start?.coord;
    if (!coord?.lat || !coord?.lon) { console.info('[GeoStart] Nessuna coordinata di partenza.'); return; }
    startCoord  = { lat: coord.lat, lon: coord.lon };
    dismissed   = false;
    raceStarted = false;
    hideBanner(true);
    createBanner();
    startBannerWatch();
  });

  window.addEventListener('pagehide', () => { stopBannerWatch(); stopGpsNavigator(); });

  // ══════════════════════════════════════════════════════════════
  // ── API PUBBLICA ─────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════

  window.GeoRaceNav = {
    start        : startGpsNavigator,
    stop         : stopGpsNavigator,
    toggleAuto   : () => { gpsAutoScroll = !gpsAutoScroll; updateHudAutoIcon(); },
    getState     : () => ({ gpsActive, gpsAutoScroll, lastPos, speedHistory: [...speedHistory] }),
    getLeadTime  : noteLeadTime,
    LEAD_TIME,
  };

})();