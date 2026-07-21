const idxPrev = {};
const _peDOM = {};
let _peDOMReady = false;
let _popupBound = false;

function _formatIndexTime(quoteAt, receivedAt) {
  let date = null;
  if (typeof quoteAt === "number" && Number.isFinite(quoteAt)) {
    date = new Date(quoteAt < 1e12 ? quoteAt * 1000 : quoteAt);
  } else if (typeof quoteAt === "string" && /^\d{14}$/.test(quoteAt)) {
    date = new Date(
      Number(quoteAt.slice(0, 4)),
      Number(quoteAt.slice(4, 6)) - 1,
      Number(quoteAt.slice(6, 8)),
      Number(quoteAt.slice(8, 10)),
      Number(quoteAt.slice(10, 12)),
      Number(quoteAt.slice(12, 14)),
    );
  }
  if (!date || isNaN(date.getTime())) {
    date = receivedAt ? new Date(receivedAt) : null;
  }
  return date && !isNaN(date.getTime())
    ? date.toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";
}

function renderIndices(map, meta) {
  const bar = _getEl("idxBar");
  const dataMap = map || {};
  const mode = meta?.mode || "empty";
  bar.classList.toggle("is-stale", mode === "stale");

  // 源标签放在最后一张卡片（中证500）右上角。主源也显示——腾讯/新浪两条链
  // 精度不同（新浪无 PE、无总市值，PE 主路会静默退回昨收），静默切源无从察觉。
  let sourceTag = "";
  const source = meta?.source;
  if (mode === "stale") {
    const t = _formatIndexTime(meta.quoteAt, meta.receivedAt);
    sourceTag = `<span class="src-tag idx-src-tag is-stale">行情暂断${t ? ` · ${t}` : ""}</span>`;
  } else if (source === "sina") {
    sourceTag = '<span class="src-tag idx-src-tag is-alt">新浪</span>';
  } else if (source === "tencent") {
    sourceTag = '<span class="src-tag idx-src-tag">腾讯</span>';
  } else if (mode === "empty") {
    sourceTag = '<span class="src-tag idx-src-tag">暂不可用</span>';
  }

  bar.innerHTML = INDICES.map((idx, i) => {
    const d = dataMap[idx.id];
    const isLast = i === INDICES.length - 1;
    if (!d || !Number.isFinite(d.f2))
      return `<div class="idx-cell"><div class="idx-lbl">${idx.lbl}</div><div class="idx-row"><div class="idx-chg flat num">—</div><div class="idx-price num">—</div></div>${isLast ? sourceTag : ""}</div>`;
    const price = typeof d.f2 === "number" ? d.f2.toFixed(2) : String(d.f2);
    const pct = d.f3 ?? 0,
      cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat",
      sign = pct > 0 ? "+" : "";
    const old = idxPrev[idx.id];
    const flash =
      mode === "live" && old && old !== price
        ? parseFloat(price) > parseFloat(old)
          ? "flash-up"
          : "flash-down"
        : "";
    idxPrev[idx.id] = price;
    return `<div class="idx-cell ${cls} ${flash}"><div class="idx-lbl">${idx.lbl}</div><div class="idx-row"><div class="idx-chg num ${cls}">${sign}${typeof pct === "number" ? pct.toFixed(2) : pct}%</div><div class="idx-price num">${price}</div></div>${isLast ? sourceTag : ""}</div>`;
  }).join("");
}

function updatePeBar() {
  if (!_peDOMReady) {
    _peDOM.display = document.getElementById("peDisplay");
    _peDOM.status = document.getElementById("peStatus");
    _peDOM.marker = document.getElementById("peTrackMarker");
    _peDOM.eqDiv = document.getElementById("peEquityInfo");
    _peDOM.loEl = document.getElementById("peTrackLo");
    _peDOM.hiEl = document.getElementById("peTrackHi");
    _peDOMReady = true;
  }

  const peData = loadPe();
  const qqIdx = getQQIndex();
  const engineData = loadPeEngine();
  const engRef = getRefPE(engineData, qqIdx); // 非锚定的那条，小字并列展示
  const currentPE = getCurrentPE(peData, getAnchorPE(engineData, qqIdx));

  // 已定档但引擎数据未就绪(新开端/夜锚未拉到)时 value 为非有限值，
  // 直接落入“未就绪”分支，避免下方 v.toFixed 抛错致定档保存“没反应”
  if (!currentPE || !Number.isFinite(currentPE.value)) {
    _peDOM.display.textContent = "--.--%";
    _peDOM.display.className = "pe-value pe-normal";
    _peDOM.status.textContent = peData?.bucketStr ? "等待数据" : "未定档";
    _peDOM.status.className = "pe-status normal";
    [_peDOM.marker, _peDOM.loEl, _peDOM.hiEl, _peDOM.eqDiv].forEach((el) => {
      if (el) el.style.display = "none";
    });
    return;
  }

  const { value: v, bounds } = currentPE;
  // 参考路只由自己的 mode 决定显示，不挂在主路的 isDynamic 上：
  // 走备用指数源时总市值路因缺 mcap 而失效、主数字冻回昨收，此时点位路算出的
  // 数字恰恰是仅存的实时估计，正是最该露出来的时候。
  // 注：类名 pe-bypass2 是 PE_ANCHOR="mcap" 时代的遗留（那时小字恒为 2.0）。
  // 翻成 "price" 后小字变 1.0，类名语义会反过来——纯命名问题，不影响渲染，故不动 CSS。
  // 备用源标签由数据源名称替代（D-020）。
  const refHtml = engRef && engRef.mode !== "close"
    ? `<span class="pe-bypass2"><span class="num">${engRef.pct.toFixed(2)}%</span>${
        getIndicesMeta()?.source === "sina" ? '<span class="src-tag is-alt">新浪</span>' : ""
      }</span>`
    : "";
  _peDOM.display.innerHTML = `<span class="num">${v.toFixed(2)}%</span>${refHtml}`;

  const span = (bounds.sellPct - bounds.buyPct) * 2;
  const peMin = (bounds.buyPct + bounds.sellPct) / 2 - span / 2;
  const toPos = (pe) =>
    Math.min(Math.max(((pe - peMin) / span) * 100, 0), 100) + "%";

  if (_peDOM.marker) {
    _peDOM.marker.style.display = "block";
    _peDOM.marker.style.left = toPos(v);
  }
  if (_peDOM.loEl) {
    _peDOM.loEl.style.display = "block";
    _peDOM.loEl.style.left = toPos(bounds.buyPct);
  }
  if (_peDOM.hiEl) {
    _peDOM.hiEl.style.display = "block";
    _peDOM.hiEl.style.left = toPos(bounds.sellPct);
  }

  if (_peDOM.eqDiv) {
    // 权益计算由 interact 层在打开抽屉时执行；PE 栏展示使用轻量实时计算
    // 此处是 PE 栏专属的只读展示，依赖注入给 engine 纯函数，不写 store 不改 DOM 之外的任何状态
    const eqData = calcCurrentEquity(
      loadHoldings(),
      getActiveProducts(),
      getNavByCode,
    );
    const target = getDynamicTarget("neutral", peData?.bucketStr);
    if (eqData && target != null) {
      const diff = eqData.equity - target,
        wrongDir = isEquityWrongDir(v, diff);
      const col = wrongDir
        ? "var(--warn)"
        : Math.abs(diff) < 1 && !wrongDir
          ? "var(--t1)"
          : diff > 0
            ? "var(--sell)"
            : "var(--buy)";
      const diffCol = Math.abs(diff) < 1 && !wrongDir ? "var(--t2)" : col;
      _peDOM.eqDiv.innerHTML = `权益<b class="num" style="color:${col};margin-left:2px;">${eqData.equity.toFixed(2)}%</b><span class="num" style="color:${diffCol};margin-left:2px;font-size:10px;vertical-align:baseline;">${diff > 0 ? "+" : ""}${diff.toFixed(2)}%</span><span style="display:inline-block;width:1px;height:10px;background:var(--bd2);vertical-align:middle;margin:0 2px;"></span>目标<b class="num" style="margin-left:2px;">${target}%</b>`;
      _peDOM.eqDiv.style.display = "flex";
    } else _peDOM.eqDiv.style.display = "none";
  }

  // 更新 bar 条浮层：买卖边界对应的沪深300点位
  const peTrackEl = document.getElementById("peTrack");
  const popup = document.getElementById("peTrackPopup");
  if (peTrackEl && popup) {
    const bp = getBoundaryPrices(engineData, bounds.buyPct, bounds.sellPct);
    if (bp) {
      const fmt = (n) => n.toLocaleString("zh-CN");
      popup.innerHTML =
        `<span style="color:var(--buy);font-weight:600">买 ${fmt(bp.buyPrice)}</span>` +
        `<span style="color:var(--bd2);margin:0 6px">|</span>` +
        `<span style="color:var(--sell);font-weight:600">卖 ${fmt(bp.sellPrice)}</span>`;
      peTrackEl.dataset.hasPopup = "1";
    } else {
      peTrackEl.dataset.hasPopup = "";
    }
    if (!_popupBound) {
      _popupBound = true;
      // 点击/tap：显示浮层
      peTrackEl.addEventListener("click", (e) => {
        if (!peTrackEl.dataset.hasPopup) return;
        e.stopPropagation();
        popup.style.display = popup.style.display === "none" ? "block" : "none";
      });
      // 桌面：离开 bar 区域自动关闭
      peTrackEl.addEventListener("mouseleave", () => {
        popup.style.display = "none";
      });
      // 桌面：悬停自动显示
      peTrackEl.addEventListener("mouseenter", () => {
        if (peTrackEl.dataset.hasPopup) popup.style.display = "block";
      });
      // 点击外部关闭
      document.addEventListener("click", () => {
        popup.style.display = "none";
      });
    }
  }

  if (v <= bounds.buyPct) {
    _peDOM.display.className = "pe-value pe-danger-dn";
    _peDOM.status.textContent = "▲ 增权";
    _peDOM.status.className = "pe-status triggered-buy";
    if (_peDOM.marker) _peDOM.marker.style.background = "var(--buy)";
  } else if (v >= bounds.sellPct) {
    _peDOM.display.className = "pe-value pe-danger-up";
    _peDOM.status.textContent = "▼ 降权";
    _peDOM.status.className = "pe-status triggered-sell";
    if (_peDOM.marker) _peDOM.marker.style.background = "var(--sell)";
  } else {
    _peDOM.display.className = "pe-value pe-normal";
    _peDOM.status.textContent = "待机";
    _peDOM.status.className = "pe-status normal";
    if (_peDOM.marker) _peDOM.marker.style.background = "var(--t1)";
  }
}

function inlinePctHtml(ep, op, stale, ef, of2) {
  const opCls = stale ? "flat" : op.cls,
    staleCls = stale ? " stale-text" : "";
  if (miniMode === 0)
    return `<span class="inline-pct num ${ep.cls} ${ef}">${ep.txt}</span>`;
  if (miniMode === 1)
    return `<span class="inline-pct num ${opCls} ${of2}${staleCls}">${op.txt}</span>`;
  return `<span class="inline-pct num"><span class="${ep.cls} ${ef}">${ep.txt}</span><span style="color:var(--t3);margin:0 3px">|</span><span class="${opCls} ${of2}${staleCls}">${op.txt}</span></span>`;
}

function UI_updateIndices() {
  renderIndices(getIndices(), getIndicesMeta());
  updatePeBar();
}

