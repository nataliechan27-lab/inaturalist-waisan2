/* ============================================================
   iNaturalist 觀察地圖
   - 內建快照（snapshot.js）優先，沒有才即時抓取
   - 可輸入任何公開帳號，或按「更新資料」抓最新
   - 原始坐标一律 WGS84，顯示时才轉 GCJ-02
   ============================================================ */
(function () {
  'use strict';

  var API = 'https://api.inaturalist.org/v1';
  var TAXA_CACHE_KEY = 'inat_taxa_v1';
  var USER_KEY = 'inat_last_user';
  var DATA_CACHE_PREFIX = 'inat_data_v1_';

  var COLORS = {
    Plantae: '#2e7d32',
    Aves: '#1565c0',
    Insecta: '#ef6c00',
    Animalia: '#6a1b9a',
    Fungi: '#c62828',
    Actinopterygii: '#00838f',
    Mollusca: '#ad1457',
    Arachnida: '#5e35b1',
    Reptilia: '#558b2f',
    Amphibia: '#0097a7',
    Mammalia: '#8d6e63',
    Chromista: '#00695c',
    Protozoa: '#827717',
    Other: '#546e7a'
  };
  var LABELS = {
    Plantae: '植物', Aves: '鳥類', Insecta: '昆蟲', Animalia: '其他動物',
    Fungi: '真菌', Actinopterygii: '魚類', Mollusca: '軟體動物',
    Arachnida: '蛛形類', Reptilia: '爬蟲類', Amphibia: '兩棲類',
    Mammalia: '哺乳類', Chromista: '藻類', Protozoa: '原生生物', Other: '其他'
  };
  var RANK_LABELS = { class: '綱', order: '目', family: '科' };

  var isTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* ---------------- 狀態 ---------------- */
  var state = {
    user: '',
    records: [],
    source: '',
    fetchedAt: null,
    layers: {},
    groups: {},
    active: new Set(),
    chipEls: {},
    taxFilter: null,
    markerRefs: [],
    wallList: [],
    lbIdx: 0
  };
  var tmMode = 'order';

  /* ---------------- 座標轉換 ---------------- */
  var PI = Math.PI, AXIS = 6378245.0, EE = 0.00669342162296594323;
  function outOfChina(lat, lng) { return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55); }
  function transformLat(x, y) {
    var r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    r += (160.0 * Math.sin(y / 12.0 * PI) + 320.0 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return r;
  }
  function transformLng(x, y) {
    var r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    r += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return r;
  }
  function wgs2gcj(lat, lng) {
    if (outOfChina(lat, lng)) return [lat, lng];
    var dLat = transformLat(lng - 105.0, lat - 35.0);
    var dLng = transformLng(lng - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * PI;
    var magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((AXIS * (1 - EE)) / (magic * sqrtMagic) * PI);
    dLng = (dLng * 180.0) / (AXIS / sqrtMagic * Math.cos(radLat) * PI);
    return [lat + dLat, lng + dLng];
  }

  /* ---------------- 地圖 ---------------- */
  var map = L.map('map', { zoomControl: true, maxZoom: 18, minZoom: 2, worldCopyJump: true });
  map.createPane('accPane');
  map.getPane('accPane').style.zIndex = 350;

  var street = L.tileLayer(
    'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    { subdomains: '1234', maxZoom: 18, attribution: '&copy; 高德地圖 AutoNavi' }
  ).addTo(map);
  var satellite = L.tileLayer(
    'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    { subdomains: '1234', maxZoom: 18, attribution: '&copy; 高德地圖 AutoNavi' }
  );
  var carto = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors &copy; CARTO' }
  );
  L.control.layers(
    { '高德街道': street, '高德衛星': satellite, '淺色底圖': carto },
    null,
    { position: 'topright', collapsed: false }
  ).addTo(map);
  L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 140 }).addTo(map);

  /* ---------------- 相片卡 ---------------- */
  var card = document.createElement('div');
  card.id = 'photoCard';
  card.innerHTML =
    '<img id="photoImg" alt="">' +
    '<div class="pc-body">' +
      '<div class="pc-name" id="pcName"></div>' +
      '<div class="pc-sci" id="pcSci"></div>' +
      '<div class="pc-date" id="pcDate"></div>' +
      '<div class="pc-meta" id="pcMeta"></div>' +
      '<a class="pc-link" id="pcLink" target="_blank" rel="noopener">在 iNaturalist 查看 →</a>' +
    '</div>';
  $('map').appendChild(card);

  var photoImg = $('photoImg');
  var pcName = $('pcName');
  var pcSci = $('pcSci');
  var pcDate = $('pcDate');
  var pcMeta = $('pcMeta');
  var hoverMarker = null;

  function photoSet(url, size) {
    if (!url) return '';
    return url.replace(/\/(square|small|medium|large|original)\./, '/' + size + '.');
  }
  function positionCard() {
    if (!hoverMarker) return;
    var pt = map.latLngToContainerPoint(hoverMarker.getLatLng());
    var w = card.offsetWidth, h = card.offsetHeight;
    var size = map.getSize();
    var x = pt.x + 20;
    if (x + w > size.x - 10) x = pt.x - w - 20;
    var y = pt.y - h / 2;
    y = Math.max(10, Math.min(y, size.y - h - 10));
    card.style.left = Math.round(x) + 'px';
    card.style.top = Math.round(y) + 'px';
  }
  function showCard(m) {
    var p = m._p;
    hoverMarker = m;
    var nameZh = p.common_name_zh || p.common_name_en || p.scientific_name;
    pcName.textContent = nameZh;
    pcSci.textContent = p.scientific_name + (p.common_name_en && p.common_name_zh ? ' · ' + p.common_name_en : '');
    pcDate.textContent = p.observed_on || '';
    var chain = [p.kingdom, p['class'], p.order, p.family].filter(Boolean).join(' › ');
    var acc = p.positional_accuracy ? 'GPS ±' + Math.round(p.positional_accuracy) + ' m' : 'GPS 精度未提供';
    if (p.obscured) acc += '（座標已模糊）';
    pcMeta.textContent = (chain ? chain + '\n' : '') + (p.place_guess || '') + '\n' + acc;
    $('pcLink').href = p.observation_url || '#';
    photoImg.src = photoSet(p.photo_url, 'large');
    card.classList.add('show');
    positionCard();
  }
  function hideCard() {
    hoverMarker = null;
    card.classList.remove('show');
    setTimeout(function () { if (!hoverMarker) photoImg.removeAttribute('src'); }, 220);
  }

  /* ---------------- 標記 ---------------- */
  function currentLatLng(m) {
    if (!$('gcj').checked) return m._wgs;
    return wgs2gcj(m._wgs[0], m._wgs[1]);
  }
  function boundsOf(list) {
    return L.latLngBounds(list.map(function (m) {
      var ll = currentLatLng(m);
      return [ll[0], ll[1]];
    }));
  }
  function fitVisible() {
    var vis = visibleMarkers();
    if (!vis.length) return;
    if (vis.length === 1) { map.setView(currentLatLng(vis[0]), 16); return; }
    map.fitBounds(boundsOf(vis).pad(0.2), { maxZoom: 15 });
  }
  function applyCoords() {
    state.markerRefs.forEach(function (m) {
      var ll = currentLatLng(m);
      m.setLatLng(ll);
      if (m._acc) m._acc.setLatLng(ll);
    });
    syncAcc();
    positionCard();
  }
  function syncAcc() {
    var on = $('accChk').checked;
    state.markerRefs.forEach(function (m) {
      if (!m._acc) return;
      var lg = state.layers[m._group];
      var visible = on && lg && state.active.has(m._group) && lg.hasLayer(m);
      if (visible) { if (!map.hasLayer(m._acc)) m._acc.addTo(map); }
      else if (map.hasLayer(m._acc)) map.removeLayer(m._acc);
    });
  }

  function popupHtml(p) {
    var nameZh = p.common_name_zh || p.common_name_en || p.scientific_name;
    var chain = [p.order, p.family].filter(Boolean).join(' › ');
    var acc = p.positional_accuracy ? 'GPS 精度 ±' + Math.round(p.positional_accuracy) + ' m' : 'GPS 精度未提供';
    return '' +
      '<img class="popup-img" src="' + esc(photoSet(p.photo_url, 'medium')) + '" loading="lazy" alt="">' +
      '<div class="popup-title">' + esc(nameZh) + '</div>' +
      '<div class="popup-sci">' + esc(p.scientific_name) + '</div>' +
      '<div class="popup-meta">' +
        esc(p.observed_on || '') + '<br>' +
        esc(p.place_guess || '') + '<br>' +
        esc(chain) + '<br>' +
        esc(acc) + (p.obscured ? '（座標已模糊）' : '') + '<br>' +
        '<span style="color:#999">WGS84 ' + Number(p.lat).toFixed(5) + ', ' + Number(p.lon).toFixed(5) + '</span><br>' +
        '<a href="' + esc(p.observation_url || '#') + '" target="_blank" rel="noopener">在 iNaturalist 查看 →</a>' +
      '</div>';
  }

  function buildMarkers() {
    state.markerRefs.forEach(function (m) { if (m._acc && map.hasLayer(m._acc)) map.removeLayer(m._acc); });
    Object.keys(state.layers).forEach(function (k) {
      if (map.hasLayer(state.layers[k])) map.removeLayer(state.layers[k]);
    });
    map.closePopup();
    state.layers = {};
    state.markerRefs = [];

    var BASE = { radius: isTouch ? 10 : 8, color: '#fff', weight: 1.6, fillOpacity: 0.92 };
    var HOVER = { radius: isTouch ? 13 : 11, weight: 2.6, color: '#111' };

    state.records.forEach(function (p) {
      var lat = Number(p.lat), lon = Number(p.lon);
      if (!isFinite(lat) || !isFinite(lon)) return;
      var color = COLORS[p.iconic_taxon] || COLORS.Other;

      var m = L.circleMarker([lat, lon], Object.assign({ bubblingMouseEvents: false }, BASE, { fillColor: color }));
      m._p = p;
      m._wgs = [lat, lon];
      m._group = p.iconic_taxon || 'Other';
      m._color = color;
      m._name = [p.common_name_zh, p.common_name_en, p.scientific_name, p.family, p.order, p.place_guess, p.observed_on]
        .filter(Boolean).join(' ').toLowerCase();

      if (p.positional_accuracy && !p.obscured) {
        m._acc = L.circle([lat, lon], {
          pane: 'accPane',
          radius: Number(p.positional_accuracy),
          stroke: false,
          fillColor: color,
          fillOpacity: 0.14,
          interactive: false
        });
      }

      if (isTouch) {
        m.on('click', function () {
          if (hoverMarker === m) hideCard(); else showCard(m);
        });
      } else {
        m.bindPopup(popupHtml(p), { maxWidth: 260 });
        m.on('mouseover', function () {
          m.setStyle(Object.assign({}, HOVER, { fillColor: color }));
          m.bringToFront();
          showCard(m);
        });
        m.on('mouseout', function () {
          m.setStyle(Object.assign({}, BASE, { fillColor: color }));
          if (hoverMarker === m) hideCard();
        });
        m.on('click', hideCard);
      }

      if (!state.layers[m._group]) state.layers[m._group] = L.layerGroup();
      if (state.active.has(m._group)) state.layers[m._group].addTo(map);
      m.addTo(state.layers[m._group]);
      state.markerRefs.push(m);
    });
  }

  /* ---------------- 篩選 ---------------- */
  function visibleMarkers() {
    return state.markerRefs.filter(function (m) {
      var lg = state.layers[m._group];
      return lg && state.active.has(m._group) && lg.hasLayer(m);
    });
  }
  function applyFilters(opts) {
    var q = $('search').value.trim().toLowerCase();
    var tf = state.taxFilter;
    state.markerRefs.forEach(function (m) {
      var p = m._p;
      var ok = (!q || m._name.indexOf(q) !== -1) && state.active.has(m._group) && (!tf || p[tf.rank] === tf.name);
      var lg = state.layers[m._group];
      if (!lg) return;
      if (ok) { if (!lg.hasLayer(m)) lg.addLayer(m); }
      else if (lg.hasLayer(m)) lg.removeLayer(m);
    });
    syncAcc();
    updateExportCount();
    highlightTreemap();
    if (opts && opts.fit) fitVisible();
  }

  function buildChips() {
    var el = $('chips');
    el.innerHTML = '';
    state.chipEls = {};
    Object.keys(state.groups).sort(function (a, b) { return state.groups[b] - state.groups[a]; }).forEach(function (g) {
      var chip = document.createElement('div');
      chip.className = 'chip' + (state.active.has(g) ? '' : ' off');
      chip.innerHTML = '<span class="dot" style="background:' + (COLORS[g] || COLORS.Other) + '"></span>' +
        esc(LABELS[g] || g) + ' ' + state.groups[g];
      chip.onclick = function () {
        if (state.active.has(g)) {
          state.active.delete(g);
          chip.classList.add('off');
          if (map.hasLayer(state.layers[g])) map.removeLayer(state.layers[g]);
        } else {
          state.active.add(g);
          chip.classList.remove('off');
          state.layers[g].addTo(map);
        }
        applyFilters();
      };
      el.appendChild(chip);
      state.chipEls[g] = chip;
    });
  }

  function buildOrderSelect() {
    var sel = $('orderSel');
    sel.innerHTML = '';
    var info = new Map();
    state.records.forEach(function (p) {
      if (!p.order) return;
      if (!info.has(p.order)) info.set(p.order, { count: 0, kingdom: p.kingdom || '', klass: p['class'] || '' });
      info.get(p.order).count++;
    });
    var all = document.createElement('option');
    all.value = '';
    all.textContent = '全部分類（' + info.size + ' 目）';
    sel.appendChild(all);

    var current = null, og = null;
    Array.from(info.entries()).sort(function (a, b) {
      var A = a[1], B = b[1];
      return (A.kingdom + A.klass + a[0]).localeCompare(B.kingdom + B.klass + b[0]);
    }).forEach(function (entry) {
      var order = entry[0], i = entry[1];
      var key = [i.kingdom, i.klass].filter(Boolean).join(' › ');
      if (key !== current) {
        current = key;
        og = document.createElement('optgroup');
        og.label = key || '其他';
        sel.appendChild(og);
      }
      var opt = document.createElement('option');
      opt.value = order;
      opt.textContent = order + '（' + i.count + '）';
      og.appendChild(opt);
    });
  }

  function updateStats() {
    var recs = state.records;
    $('s-count').textContent = recs.length;
    $('s-taxa').textContent = new Set(recs.map(function (r) { return r.scientific_name; }).filter(Boolean)).size;
    var years = recs.map(function (r) { return parseInt((r.observed_on || '').slice(0, 4), 10); })
      .filter(function (y) { return isFinite(y); });
    $('s-years').textContent = years.length ? (Math.max.apply(null, years) - Math.min.apply(null, years) + 1) : 0;
  }

  function fmtDate(d) {
    if (!d) return '';
    var x = d instanceof Date ? d : new Date(d);
    if (isNaN(x.getTime())) return '';
    function p(n) { return String(n).padStart(2, '0'); }
    return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate()) + ' ' + p(x.getHours()) + ':' + p(x.getMinutes());
  }

  function updateMeta() {
    $('userLabel').textContent = state.user ? '@' + state.user : '@—';
    $('userInput').value = state.user || '';
    var st = $('status');
    st.className = 'status' + (state.source === 'live' ? ' live' : '');
    var when = fmtDate(state.fetchedAt);
    if (state.source === 'live') {
      st.textContent = '已連線 iNaturalist · 資料時間 ' + when;
    } else if (state.source === 'snapshot') {
      st.textContent = '內建快照 · ' + when + ' · 按「更新資料」抓最新';
    } else {
      st.textContent = '請輸入 iNaturalist 帳號';
    }
    document.title = (state.user ? '@' + state.user + ' · ' : '') + 'iNaturalist 觀察地圖';
  }

  /* ---------------- 主渲染 ---------------- */
  function render(opts) {
    opts = opts || {};
    var prevGroups = state.groups || {};
    var prevActive = new Set(state.active || []);

    var groups = {};
    state.records.forEach(function (r) {
      var k = r.iconic_taxon || 'Other';
      groups[k] = (groups[k] || 0) + 1;
    });
    state.groups = groups;

    var nextActive = new Set();
    Object.keys(groups).forEach(function (k) {
      if (opts.keepFilters && prevGroups[k] != null && !prevActive.has(k)) return;
      nextActive.add(k);
    });
    state.active = nextActive;

    buildChips();
    buildOrderSelect();
    $('orderSel').value = state.taxFilter && state.taxFilter.rank === 'order' ? state.taxFilter.name : '';
    buildMarkers();
    updateStats();
    updateMeta();
    applyCoords();
    applyFilters();
    if (opts.fit !== false) fitVisible();
    if (drawerOpen()) renderAnalysis();
  }

  function loadRecords(records, opts) {
    state.records = records;
    seedTaxonCache(records);
    state.user = opts.user;
    state.source = opts.source || 'live';
    state.fetchedAt = opts.fetchedAt || new Date();
    safeSet(USER_KEY, state.user);
    if (!opts.keepFilters) {
      state.taxFilter = null;
      $('search').value = '';
    } else if (state.taxFilter) {
      var tf = state.taxFilter;
      var still = records.some(function (r) { return r[tf.rank] === tf.name; });
      if (!still) state.taxFilter = null;
    }
    render({ fit: opts.fit !== false, keepFilters: !!opts.keepFilters });
  }

  /* ---------------- 資料抓取 ---------------- */
  function fromSnapshot(f) {
    var p = f.properties || {};
    var r = {};
    Object.keys(p).forEach(function (k) { r[k] = p[k]; });
    r.lat = f.geometry.coordinates[1];
    r.lon = f.geometry.coordinates[0];
    return r;
  }

  function fromApi(o) {
    var t = o.taxon || {};
    var lat = null, lon = null;
    if (o.geojson && o.geojson.coordinates && o.geojson.coordinates.length >= 2) {
      lon = Number(o.geojson.coordinates[0]);
      lat = Number(o.geojson.coordinates[1]);
    } else if (o.location) {
      var parts = String(o.location).split(',');
      lat = Number(parts[0]);
      lon = Number(parts[1]);
    }
    var pref = t.preferred_common_name || '';
    var hasZh = /[\u3400-\u9fff]/.test(pref);
    return {
      id: o.id,
      taxon_id: t.id || null,
      observed_on: o.observed_on || '',
      time_observed_at: o.time_observed_at || '',
      quality_grade: o.quality_grade || '',
      scientific_name: t.name || o.species_guess || '',
      common_name_zh: hasZh ? pref : '',
      common_name_en: t.english_common_name || (!hasZh ? pref : '') || '',
      rank: t.rank || '',
      iconic_taxon: t.iconic_taxon_name || 'Other',
      kingdom: '', phylum: '', 'class': '', order: '', family: '', genus: '',
      lat: lat,
      lon: lon,
      positional_accuracy: o.positional_accuracy || o.public_positional_accuracy || null,
      geoprivacy: o.geoprivacy || '',
      obscured: !!o.obscured,
      place_guess: o.place_guess || '',
      tags: (o.tags || []).join('; '),
      photo_url: (o.photos && o.photos[0] && o.photos[0].url) || '',
      observation_url: 'https://www.inaturalist.org/observations/' + o.id
    };
  }

  async function getJson(url, tries) {
    tries = tries || 3;
    var lastErr;
    for (var i = 0; i < tries; i++) {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 25000);
      try {
        var res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) {
          var httpErr = new Error('HTTP ' + res.status);
          httpErr.status = res.status;
          throw httpErr;
        }
        return await res.json();
      } catch (e) {
        lastErr = e;
        /* 4xx（除 429）重試也不會成功，直接放棄 */
        if (e && e.status && e.status !== 429 && e.status < 500) throw e;
      } finally {
        clearTimeout(timer);
      }
      if (i < tries - 1) await new Promise(function (r) { setTimeout(r, 700 * (i + 1)); });
    }
    throw lastErr;
  }

  async function fetchAllObservations(user, onProgress) {
    var base = API + '/observations?user_login=' + encodeURIComponent(user) +
      '&quality_grade=research&per_page=200&locale=zh-TW&order_by=observed_on&order=desc';
    var first = await getJson(base + '&page=1');
    var total = Number(first.total_results || 0);
    var all = Array.isArray(first.results) ? first.results : [];
    var maxPages = Math.min(Math.ceil(total / 200), 40);
    if (!maxPages) maxPages = 1;
    if (onProgress) onProgress(1, maxPages, all.length);
    for (var pg = 2; pg <= maxPages; pg++) {
      var j = await getJson(base + '&page=' + pg);
      all = all.concat(Array.isArray(j.results) ? j.results : []);
      if (onProgress) onProgress(pg, maxPages, all.length);
    }
    if (total > all.length && maxPages === 40) {
      toast('資料量較大，僅載入前 ' + all.length + ' 筆（共 ' + total + ' 筆）', 6000);
    }
    return all;
  }

  /* ---------------- 分類快取 ---------------- */
  var taxonCache = (function () {
    try { return JSON.parse(safeGet(TAXA_CACHE_KEY) || '{}') || {}; } catch (e) { return {}; }
  })();
  function saveTaxonCache() {
    try { localStorage.setItem(TAXA_CACHE_KEY, JSON.stringify(taxonCache)); } catch (e) {}
  }
  function seedTaxonCache(records) {
    var changed = false;
    records.forEach(function (r) {
      if (!r.taxon_id) return;
      var c = taxonCache[r.taxon_id];
      if (c && c.order) return;
      if (r.order) {
        taxonCache[r.taxon_id] = {
          kingdom: r.kingdom || '', phylum: r.phylum || '', 'class': r['class'] || '',
          order: r.order || '', family: r.family || '', genus: r.genus || ''
        };
        changed = true;
      }
    });
    if (changed) saveTaxonCache();
  }
  function applyTaxonCache(records) {
    records.forEach(function (r) {
      if (!r.taxon_id) return;
      var c = taxonCache[r.taxon_id];
      if (!c) return;
      if (c.kingdom) r.kingdom = c.kingdom;
      if (c.phylum) r.phylum = c.phylum;
      if (c['class']) r['class'] = c['class'];
      if (c.order) r.order = c.order;
      if (c.family) r.family = c.family;
      if (c.genus) r.genus = c.genus;
    });
  }
  async function enrichTaxa(records, onProgress) {
    var ids = Array.from(new Set(records.map(function (r) { return r.taxon_id; }).filter(Boolean)));
    applyTaxonCache(records);
    var missing = ids.filter(function (id) { return !taxonCache[id] || !taxonCache[id].order; });
    if (!missing.length) {
      if (onProgress) onProgress(ids.length, ids.length);
      return;
    }
    /* API 支援 /taxa/{id1,id2,...}，每批 30 個，減少請求次數 */
    var CHUNK = 30;
    var chunks = [];
    for (var i = 0; i < missing.length; i += CHUNK) chunks.push(missing.slice(i, i + CHUNK));

    var done = 0, idx = 0;
    var workers = Math.min(2, chunks.length);
    async function worker() {
      while (idx < chunks.length) {
        var chunk = chunks[idx++];
        try {
          var j = await getJson(API + '/taxa/' + chunk.join(',') + '?locale=zh-TW');
          var byId = {};
          ((j && j.results) || []).forEach(function (t) {
            if (!t || !t.id) return;
            var ranks = {};
            (t.ancestors || []).forEach(function (a) { if (a && a.rank) ranks[a.rank] = a.name; });
            if (t.rank) ranks[t.rank] = t.name;
            byId[t.id] = {
              kingdom: ranks.kingdom || '', phylum: ranks.phylum || '', 'class': ranks['class'] || '',
              order: ranks.order || '', family: ranks.family || '', genus: ranks.genus || ''
            };
          });
          chunk.forEach(function (id) { if (byId[id]) taxonCache[id] = byId[id]; });
        } catch (e) {
          /* 整批失敗，下次再試 */
        }
        done += chunk.length;
        saveTaxonCache();
        if (onProgress) onProgress(Math.min(done, missing.length), missing.length);
      }
    }
    var arr = [];
    for (var k = 0; k < workers; k++) arr.push(worker());
    await Promise.all(arr);
    saveTaxonCache();
    applyTaxonCache(records);
  }

  /* ---------------- 載入帳號 ---------------- */
  async function loadUser(user, opts) {
    opts = opts || {};
    user = String(user || '').trim().replace(/^@+/, '');
    if (!user) { toast('請輸入 iNaturalist 帳號'); return; }

    setBusy(true, '連線 iNaturalist…', 0.03);
    try {
      var raw = await fetchAllObservations(user, function (done, pages, count) {
        setBusy(true, '抓取觀察資料…', 0.05 + 0.25 * (pages ? done / pages : 0.5));
        $('loadSub').textContent = count + ' 筆 · 第 ' + done + '/' + pages + ' 頁';
      });
      if (!raw.length) throw new Error('EMPTY');

      var records = raw.map(fromApi).filter(function (r) { return isFinite(r.lat) && isFinite(r.lon); });
      if (!records.length) throw new Error('NOLOC');

      seedTaxonCache(records);
      var ids = Array.from(new Set(records.map(function (r) { return r.taxon_id; }).filter(Boolean)));
      var missing = ids.filter(function (id) { return !taxonCache[id] || !taxonCache[id].order; });
      if (missing.length > 120) {
        toast('首次載入需查詢 ' + missing.length + ' 個分類，請稍候…', 6000);
      }
      $('loadSub').textContent = missing.length ? '分類資料 0/' + missing.length : '使用快取分類';

      await enrichTaxa(records, function (done, total) {
        setBusy(true, '取得分類資料…', 0.32 + 0.63 * (total ? done / total : 1));
        $('loadSub').textContent = done + '/' + total + ' 個分類';
      });

      loadRecords(records, {
        user: user,
        source: 'live',
        fetchedAt: new Date(),
        fit: opts.fit !== false,
        keepFilters: !!opts.keepFilters
      });
      writeCache(user, records);
      if (opts.hash) applyHash(opts.hash);
      toast('已載入 @' + user + '：' + records.length + ' 筆觀察');
    } catch (err) {
      var msg = String((err && err.message) || '');
      if (msg !== 'HTTP 422' && msg !== 'HTTP 404') console.error(err);
      if (msg === 'EMPTY') toast('@' + user + ' 沒有 research grade 觀察');
      else if (msg === 'NOLOC') toast('這些觀察沒有可用的座標');
      else if (msg === 'HTTP 422' || msg === 'HTTP 404') toast('找不到帳號 @' + user + '（請確認拼寫）');
      else toast('載入失敗：' + (msg || '網路錯誤'));
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- 本機快取 ---------------- */
  function readCache(user) {
    try {
      var raw = safeGet(DATA_CACHE_PREFIX + String(user).toLowerCase());
      if (!raw) return null;
      var j = JSON.parse(raw);
      if (!j || !Array.isArray(j.records) || !j.records.length) return null;
      return j;
    } catch (e) { return null; }
  }
  function writeCache(user, records) {
    try {
      var payload = JSON.stringify({ savedAt: new Date().toISOString(), records: records });
      if (payload.length > 4500000) return;
      safeSet(DATA_CACHE_PREFIX + String(user).toLowerCase(), payload);
    } catch (e) {}
  }

  /* ---------------- 分析：熱圖 ---------------- */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function mix(hex, t) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    var k = 0.1 + 0.9 * Math.max(0, Math.min(1, t));
    return 'rgb(' + Math.round(255 - (255 - r) * k) + ',' + Math.round(255 - (255 - g) * k) + ',' + Math.round(255 - (255 - b) * k) + ')';
  }
  function drawHeatmap() {
    var root = $('heatmap');
    root.innerHTML = '';
    var groups = Object.keys(state.groups).sort(function (a, b) { return state.groups[b] - state.groups[a]; });
    var counts = {};
    groups.forEach(function (g) { counts[g] = new Array(12).fill(0); });
    state.records.forEach(function (r) {
      var g = r.iconic_taxon || 'Other';
      if (!counts[g]) counts[g] = new Array(12).fill(0);
      var mo = parseInt((r.observed_on || '').slice(5, 7), 10);
      if (mo >= 1 && mo <= 12) counts[g][mo - 1]++;
    });
    var max = 1;
    Object.keys(counts).forEach(function (g) {
      counts[g].forEach(function (v) { if (v > max) max = v; });
    });

    root.appendChild(el('div', 'hm-h', ''));
    for (var m = 1; m <= 12; m++) root.appendChild(el('div', 'hm-h', String(m)));

    groups.forEach(function (g) {
      var lab = el('div', 'hm-row', LABELS[g] || g);
      lab.title = LABELS[g] || g;
      root.appendChild(lab);
      for (var i = 0; i < 12; i++) {
        var v = counts[g][i];
        var d = document.createElement('div');
        if (v) {
          var t = v / max;
          d.className = 'cell';
          d.style.background = mix(COLORS[g] || COLORS.Other, t);
          d.style.color = t > 0.55 ? '#fff' : '#3a4048';
          d.textContent = v;
        } else {
          d.className = 'cell zero';
          d.textContent = '·';
        }
        d.title = (LABELS[g] || g) + ' · ' + (i + 1) + ' 月：' + v + ' 筆';
        root.appendChild(d);
      }
    });

    $('hmMax').textContent = max + ' 筆';
    $('hmTotal').textContent = '全部 ' + state.records.length + ' 筆（未套用篩選）';
  }

  /* ---------------- 分析：Treemap ---------------- */
  function tmItems() {
    var m = new Map();
    state.records.forEach(function (r) {
      var key = r[tmMode];
      if (!key) return;
      if (!m.has(key)) m.set(key, { key: key, value: 0, group: r.iconic_taxon || 'Other' });
      m.get(key).value++;
    });
    return Array.from(m.values()).sort(function (a, b) { return b.value - a.value; });
  }
  function splitLayout(items, x, y, w, h, out) {
    if (!items.length || w <= 0 || h <= 0) return;
    if (items.length === 1) {
      out.push({ key: items[0].key, value: items[0].value, group: items[0].group, x: x, y: y, w: w, h: h });
      return;
    }
    var total = 0;
    items.forEach(function (i) { total += i.value; });
    var acc = 0, cut = 1;
    for (var i = 0; i < items.length - 1; i++) {
      acc += items[i].value;
      cut = i + 1;
      if (acc >= total / 2) break;
    }
    var a = items.slice(0, cut);
    var b = items.slice(cut);
    if (!b.length) {
      items.forEach(function (it) { out.push({ key: it.key, value: it.value, group: it.group, x: x, y: y, w: w, h: h }); });
      return;
    }
    var av = 0;
    a.forEach(function (i) { av += i.value; });
    var ratio = av / total;
    if (w >= h) {
      var aw = w * ratio;
      splitLayout(a, x, y, aw, h, out);
      splitLayout(b, x + aw, y, w - aw, h, out);
    } else {
      var ah = h * ratio;
      splitLayout(a, x, y, w, ah, out);
      splitLayout(b, x, y + ah, w, h - ah, out);
    }
  }
  function updateCrumb() {
    if (state.taxFilter) {
      $('tmCrumb').textContent = '已篩選：' + (RANK_LABELS[state.taxFilter.rank] || state.taxFilter.rank) + ' = ' + state.taxFilter.name;
    } else {
      $('tmCrumb').textContent = '未篩選 · 點擊區塊可篩選，再點一次取消';
    }
  }
  function highlightTreemap() {
    if (!drawerOpen()) return;
    var sel = state.taxFilter && state.taxFilter.rank === tmMode ? state.taxFilter.name : null;
    var nodes = document.querySelectorAll('#treemap .tm-node');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle('sel', nodes[i].dataset.key === sel);
    }
    updateCrumb();
  }
  function drawTreemap() {
    var box = $('treemap');
    box.innerHTML = '';
    var W = box.clientWidth || 330;
    var H = box.clientHeight || 230;
    var items = tmItems();
    var out = [];
    splitLayout(items, 0, 0, W, H, out);
    var sel = state.taxFilter && state.taxFilter.rank === tmMode ? state.taxFilter.name : null;

    out.forEach(function (n) {
      var d = document.createElement('div');
      d.className = 'tm-node' + (n.key === sel ? ' sel' : '');
      d.dataset.key = n.key;
      d.style.left = n.x + 'px';
      d.style.top = n.y + 'px';
      d.style.width = Math.max(0, n.w) + 'px';
      d.style.height = Math.max(0, n.h) + 'px';
      d.style.background = COLORS[n.group] || COLORS.Other;
      d.title = n.key + '：' + n.value + ' 筆';
      if (n.w > 44 && n.h > 22) {
        d.innerHTML = '<span><b>' + esc(n.key) + '</b>' + n.value + '</span>';
      }
      d.onclick = function () {
        if (state.taxFilter && state.taxFilter.rank === tmMode && state.taxFilter.name === n.key) {
          state.taxFilter = null;
        } else {
          state.taxFilter = { rank: tmMode, name: n.key };
        }
        $('orderSel').value = state.taxFilter && state.taxFilter.rank === 'order' ? state.taxFilter.name : '';
        applyFilters({ fit: true });
        drawTreemap();
      };
      box.appendChild(d);
    });
    updateCrumb();
  }

  function drawerOpen() { return $('drawer').classList.contains('open'); }
  function renderAnalysis() {
    drawHeatmap();
    drawTreemap();
    updateExportCount();
  }

  /* ---------------- 匯出 ---------------- */
  function updateExportCount() {
    var n = visibleMarkers().length;
    var el2 = $('expCount');
    if (el2) el2.textContent = '目前篩選 ' + n + ' 筆（共 ' + state.records.length + ' 筆）';
  }
  function csvCell(v) {
    if (v == null) return '""';
    return '"' + String(v).replace(/"/g, '""') + '"';
  }
  function stamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }
  function slug(s) { return String(s || 'inat').replace(/[^\w.-]+/g, '_'); }
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function exportCsv() {
    var list = visibleMarkers();
    if (!list.length) { toast('目前沒有可匯出的資料'); return; }
    var cols = ['id', 'observed_on', 'time_observed_at', 'quality_grade', 'taxon_id', 'scientific_name',
      'common_name_zh', 'common_name_en', 'rank', 'iconic_taxon', 'kingdom', 'phylum', 'taxon_class',
      'order_name', 'family_name', 'genus_name', 'latitude', 'longitude', 'positional_accuracy',
      'geoprivacy', 'obscured', 'place_guess', 'tags', 'photo_url', 'observation_url'];
    var rows = [cols.map(csvCell).join(',')];
    list.forEach(function (m) {
      var p = m._p;
      rows.push([
        p.id, p.observed_on, p.time_observed_at, p.quality_grade, p.taxon_id, p.scientific_name,
        p.common_name_zh, p.common_name_en, p.rank, p.iconic_taxon, p.kingdom, p.phylum, p['class'],
        p.order, p.family, p.genus, p.lat, p.lon, p.positional_accuracy, p.geoprivacy, p.obscured,
        p.place_guess, p.tags, p.photo_url, p.observation_url
      ].map(csvCell).join(','));
    });
    download('inat_' + slug(state.user) + '_' + stamp() + '.csv', '\uFEFF' + rows.join('\r\n'), 'text/csv;charset=utf-8');
  }
  function exportGeo() {
    var list = visibleMarkers();
    if (!list.length) { toast('目前沒有可匯出的資料'); return; }
    var fc = {
      type: 'FeatureCollection',
      features: list.map(function (m) {
        var p = m._p;
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [Number(p.lon), Number(p.lat)] },
          properties: {
            id: p.id, taxon_id: p.taxon_id, observed_on: p.observed_on,
            time_observed_at: p.time_observed_at || '', quality_grade: p.quality_grade,
            scientific_name: p.scientific_name, common_name_zh: p.common_name_zh,
            common_name_en: p.common_name_en, rank: p.rank, iconic_taxon: p.iconic_taxon,
            kingdom: p.kingdom, phylum: p.phylum, 'class': p['class'], order: p.order,
            family: p.family, genus: p.genus, positional_accuracy: p.positional_accuracy,
            geoprivacy: p.geoprivacy, obscured: p.obscured, place_guess: p.place_guess,
            tags: p.tags, photo_url: p.photo_url, observation_url: p.observation_url
          }
        };
      })
    };
    download('inat_' + slug(state.user) + '_' + stamp() + '.geojson', JSON.stringify(fc, null, 2), 'application/geo+json');
  }

  /* ---------------- 分享連結 ---------------- */
  function buildShareURL() {
    var c = map.getCenter();
    var p = new URLSearchParams();
    p.set('user', state.user || '');
    var q = $('search').value.trim();
    if (q) p.set('q', q);
    var all = Object.keys(state.groups);
    if (state.active.size !== all.length) {
      p.set('taxa', all.filter(function (g) { return state.active.has(g); }).join(','));
    }
    if (state.taxFilter) {
      p.set('rank', state.taxFilter.rank);
      p.set('val', state.taxFilter.name);
    }
    if (!$('gcj').checked) p.set('gcj', '0');
    if ($('accChk').checked) p.set('acc', '1');
    p.set('ll', c.lat.toFixed(5) + ',' + c.lng.toFixed(5));
    p.set('z', String(Math.round(map.getZoom() * 100) / 100));
    return location.href.split('#')[0] + '#' + p.toString();
  }
  function parseHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) return null;
    var p = new URLSearchParams(h);
    var out = {};
    if (p.get('user')) out.user = p.get('user');
    if (p.get('q')) out.q = p.get('q');
    if (p.has('taxa')) out.taxa = p.get('taxa').split(',').filter(Boolean);
    if (p.get('rank') && p.get('val')) out.taxFilter = { rank: p.get('rank'), name: p.get('val') };
    if (p.get('gcj') === '0') out.gcj = false;
    if (p.get('acc') === '1') out.acc = true;
    if (p.get('ll')) {
      var parts = p.get('ll').split(',').map(Number);
      if (isFinite(parts[0]) && isFinite(parts[1])) out.ll = [parts[0], parts[1]];
    }
    if (p.get('z')) out.z = Number(p.get('z'));
    return out;
  }
  function applyHash(h) {
    if (!h) return;
    if (h.q) $('search').value = h.q;
    if (h.taxa) {
      var set = new Set(h.taxa);
      Object.keys(state.groups).forEach(function (g) {
        var on = set.has(g);
        if (on) state.active.add(g); else state.active.delete(g);
        if (state.chipEls[g]) state.chipEls[g].classList.toggle('off', !on);
        var lg = state.layers[g];
        if (lg) { if (on) lg.addTo(map); else if (map.hasLayer(lg)) map.removeLayer(lg); }
      });
    }
    if (h.taxFilter) state.taxFilter = h.taxFilter;
    $('orderSel').value = state.taxFilter && state.taxFilter.rank === 'order' ? state.taxFilter.name : '';
    if (h.gcj === false) $('gcj').checked = false;
    if (h.acc) $('accChk').checked = true;
    applyCoords();
    applyFilters();
    if (h.ll && isFinite(h.ll[0]) && isFinite(h.ll[1])) {
      map.setView(h.ll, isFinite(h.z) ? h.z : map.getZoom(), { animate: false });
    }
    if (drawerOpen()) drawTreemap();
  }

  /* ---------------- 照片牆 / 燈箱 ---------------- */
  function byTaxonomy(a, b) {
    var x = a._p, y = b._p;
    return [x.order || '', x.family || '', x.scientific_name || ''].join('|')
      .localeCompare([y.order || '', y.family || '', y.scientific_name || ''].join('|'));
  }
  function openWall() {
    hideCard();
    var list = visibleMarkers().filter(function (m) { return !!m._p.photo_url; });
    state.wallList = [];
    $('wallCount').textContent = '· ' + list.length + ' 張（依目前篩選）';
    var body = $('wallBody');
    body.innerHTML = '';

    if (!list.length) {
      body.innerHTML = '<p style="color:#888;font-size:13px">目前沒有符合篩選條件的照片。</p>';
    } else {
      var grouped = {};
      list.forEach(function (m) { (grouped[m._group] = grouped[m._group] || []).push(m); });
      Object.keys(grouped).sort(function (a, b) { return grouped[b].length - grouped[a].length; }).forEach(function (key) {
        var items = grouped[key].slice().sort(byTaxonomy);
        items.forEach(function (m) { state.wallList.push(m); });

        var sec = document.createElement('section');
        var h = document.createElement('h3');
        h.innerHTML = '<span class="dot" style="background:' + (COLORS[key] || COLORS.Other) + '"></span>' +
          esc(LABELS[key] || key) + '<span class="c">' + items.length + ' 張</span>';

        var grid = document.createElement('div');
        grid.className = 'wall-grid';
        items.forEach(function (m) {
          var p = m._p;
          var nameZh = p.common_name_zh || p.common_name_en || p.scientific_name;
          var sub = [p.order, p.family].filter(Boolean).join(' › ');
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'wall-item';
          b.innerHTML =
            '<img src="' + esc(photoSet(p.photo_url, 'small')) + '" loading="lazy" alt="' + esc(nameZh) + '">' +
            '<span class="wi-cap"><b>' + esc(nameZh) + '</b><span>' + esc(sub) + '</span></span>';
          b.onclick = function () { openLightbox(m); };
          grid.appendChild(b);
        });

        sec.appendChild(h);
        sec.appendChild(grid);
        body.appendChild(sec);
      });
    }
    $('wall').classList.remove('hidden');
    body.scrollTop = 0;
  }
  function closeWall() {
    $('wall').classList.add('hidden');
    closeLightbox();
  }
  function openLightbox(m) {
    state.lbIdx = Math.max(0, state.wallList.indexOf(m));
    renderLightbox();
    $('lightbox').classList.remove('hidden');
  }
  function renderLightbox() {
    var m = state.wallList[state.lbIdx];
    if (!m) return;
    var p = m._p;
    $('lbImg').src = photoSet(p.photo_url, 'large');
    var nameZh = p.common_name_zh || p.common_name_en || p.scientific_name;
    var chain = [p.kingdom, p['class'], p.order, p.family].filter(Boolean).join(' › ');
    $('lbMeta').innerHTML =
      '<b>' + esc(nameZh) + '</b>' + (p.common_name_en ? ' · ' + esc(p.common_name_en) : '') + '<br>' +
      '<span class="sci">' + esc(p.scientific_name) + '</span><br>' +
      esc(chain) + '<br>' +
      esc(p.observed_on || '') + ' · ' + esc(p.place_guess || '') + '<br>' +
      '<a href="' + esc(p.observation_url || '#') + '" target="_blank" rel="noopener">在 iNaturalist 查看 →</a>' +
      '<span style="color:#8b949c"> · ' + (state.lbIdx + 1) + ' / ' + state.wallList.length + '</span>';
    $('lbPrev').style.visibility = state.lbIdx > 0 ? 'visible' : 'hidden';
    $('lbNext').style.visibility = state.lbIdx < state.wallList.length - 1 ? 'visible' : 'hidden';
  }
  function closeLightbox() {
    $('lightbox').classList.add('hidden');
    $('lbImg').removeAttribute('src');
  }

  /* ---------------- 載入遮罩 / 提示 ---------------- */
  function setBusy(on, text, ratio) {
    $('loading').classList.toggle('hidden', !on);
    $('loadBtn').disabled = !!on;
    $('updateBtn').disabled = !!on;
    if (text != null) $('loadText').textContent = text;
    if (ratio != null) $('loadBar').style.width = Math.round(Math.max(0.02, Math.min(1, ratio)) * 100) + '%';
  }
  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, ms || 3200);
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    $('gcj').addEventListener('change', function () { applyCoords(); });
    $('accChk').addEventListener('change', syncAcc);
    $('search').addEventListener('input', function () { applyFilters(); });
    $('orderSel').addEventListener('change', function () {
      var v = $('orderSel').value;
      state.taxFilter = v ? { rank: 'order', name: v } : null;
      applyFilters({ fit: true });
      if (drawerOpen()) drawTreemap();
    });

    $('loadBtn').onclick = function () {
      var v = $('userInput').value.trim();
      if (v) loadUser(v, { fit: true });
    };
    $('userInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('loadBtn').click();
    });
    $('updateBtn').onclick = function () {
      if (!state.user) { toast('請先載入帳號'); return; }
      loadUser(state.user, { fit: false, keepFilters: true });
    };
    $('reset').onclick = function () {
      $('search').value = '';
      state.taxFilter = null;
      $('orderSel').value = '';
      Object.keys(state.groups).forEach(function (g) {
        state.active.add(g);
        if (state.layers[g]) state.layers[g].addTo(map);
        if (state.chipEls[g]) state.chipEls[g].classList.remove('off');
      });
      applyFilters();
      fitVisible();
      if (drawerOpen()) drawTreemap();
    };

    $('drawerBtn').onclick = function () {
      hideCard();
      $('drawer').classList.add('open');
      renderAnalysis();
    };
    $('drawerClose').onclick = function () { $('drawer').classList.remove('open'); };

    document.querySelectorAll('.tm-toggle button').forEach(function (b) {
      b.onclick = function () {
        tmMode = b.dataset.mode;
        document.querySelectorAll('.tm-toggle button').forEach(function (x) {
          x.classList.toggle('on', x === b);
        });
        drawTreemap();
      };
    });

    $('expCsv').onclick = exportCsv;
    $('expGeo').onclick = exportGeo;
    $('shareBtn').onclick = function () {
      var url = buildShareURL();
      function fallback() { window.prompt('請手動複製連結：', url); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () {
          $('copyMsg').textContent = '已複製連結 ✓';
          setTimeout(function () { $('copyMsg').textContent = ''; }, 2600);
        }).catch(fallback);
      } else {
        fallback();
      }
    };

    $('wallBtn').onclick = openWall;
    $('wallClose').onclick = closeWall;
    $('lbClose').onclick = closeLightbox;
    $('lbPrev').onclick = function () { if (state.lbIdx > 0) { state.lbIdx--; renderLightbox(); } };
    $('lbNext').onclick = function () { if (state.lbIdx < state.wallList.length - 1) { state.lbIdx++; renderLightbox(); } };
    $('lightbox').addEventListener('click', function (e) { if (e.target === $('lightbox')) closeLightbox(); });

    document.addEventListener('keydown', function (e) {
      if (!$('lightbox').classList.contains('hidden')) {
        if (e.key === 'Escape') closeLightbox();
        else if (e.key === 'ArrowLeft' && state.lbIdx > 0) { state.lbIdx--; renderLightbox(); }
        else if (e.key === 'ArrowRight' && state.lbIdx < state.wallList.length - 1) { state.lbIdx++; renderLightbox(); }
        return;
      }
      if (!$('wall').classList.contains('hidden') && e.key === 'Escape') { closeWall(); return; }
      if (drawerOpen() && e.key === 'Escape') $('drawer').classList.remove('open');
    });

    map.on('click', hideCard);
    map.on('move zoom', positionCard);

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (drawerOpen()) drawTreemap();
        positionCard();
      }, 150);
    });

    boot();
  }

  function boot() {
    var hash = parseHash();
    var snap = window.INAT_SNAPSHOT;
    var last = safeGet(USER_KEY);
    var user = (hash && hash.user) || last || (snap && snap.user) || '';

    if (!user) {
      updateMeta();
      return;
    }

    var cached = readCache(user);
    var snapTime = snap && snap.generated_at ? new Date(snap.generated_at) : null;
    var cacheTime = cached ? new Date(cached.savedAt) : null;
    var cacheNewer = cached && cacheTime && (!snapTime || cacheTime > snapTime);

    if (cached && (!snap || snap.user !== user || cacheNewer)) {
      loadRecords(cached.records, { user: user, source: 'live', fetchedAt: cacheTime, fit: !(hash && hash.ll), keepFilters: false });
      applyHash(hash);
      toast('使用本機快取，按「更新資料」抓最新');
      return;
    }

    if (snap && snap.user === user) {
      var recs = snap.features.map(fromSnapshot);
      loadRecords(recs, { user: user, source: 'snapshot', fetchedAt: snapTime, fit: !(hash && hash.ll), keepFilters: false });
      applyHash(hash);
      return;
    }

    loadUser(user, { fit: !(hash && hash.ll), hash: hash });
  }

  window.__INAT_APP = {
    state: state,
    map: map,
    taxonCache: taxonCache,
    loadUser: loadUser,
    render: render,
    applyFilters: applyFilters,
    buildShareURL: buildShareURL,
    openWall: openWall,
    fromApi: fromApi
  };

  init();
})();
