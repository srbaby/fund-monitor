// Jany 基金看板 - PE 信号模块
// 职责：Lagrange 计算、PE 栏渲染、定锚弹窗交互

window._rt_csi300_price = null;

// Lagrange 三点插值，推算实时 PE
function getCurrentPE() {
  const peData = loadPe();
  if (!peData || !peData.bucketStr) return null;

  const [loStr, hiStr] = peData.bucketStr.split(',');
  const buyPct = parseFloat(loStr) - SYS_CONFIG.DEAD_ZONE;
  const sellPct = parseFloat(hiStr) + SYS_CONFIG.DEAD_ZONE;

  let v = peData.peYest, isDynamic = false;

  if (window._rt_csi300_price && peData.priceAnchor && peData.priceBuy && peData.priceSell) {
    const x = window._rt_csi300_price;
    const x1 = peData.priceBuy,    y1 = buyPct;
    const x2 = peData.priceAnchor, y2 = peData.peYest;
    const x3 = peData.priceSell,   y3 = sellPct;

    if (x === x2) {
      v = y2; isDynamic = true;
    } else if (x1 !== x2 && x2 !== x3 && x1 !== x3) {
      v = y1 * ((x-x2)*(x-x3)) / ((x1-x2)*(x1-x3))
        + y2 * ((x-x1)*(x-x3)) / ((x2-x1)*(x2-x3))
        + y3 * ((x-x1)*(x-x2)) / ((x3-x1)*(x3-x2));
      isDynamic = true;
    } else {
      const range = x3 - x1;
      if (range > 0) { v = y1 + ((x-x1)/range)*(y3-y1); isDynamic = true; }
    }
  }

  return {value: v, isDynamic, rawData: peData, bounds: {buyPct, sellPct}};
}

// 当前档位的目标权益
function getDynamicTarget(mode) {
  const currentPE = getCurrentPE();
  if (!currentPE?.rawData?.bucketStr) return null;
  const lo = parseFloat(currentPE.rawData.bucketStr.split(',')[0]);
  const idx = PE_EQUITY_TABLE.findIndex(x => lo >= x.lo && lo < x.hi);
  if (idx === -1) return null;
  if (mode === 'buy')  return PE_EQUITY_TABLE[Math.min(idx + 1, PE_EQUITY_TABLE.length - 1)].target;
  if (mode === 'sell') return PE_EQUITY_TABLE[Math.max(idx - 1, 0)].target;
  return PE_EQUITY_TABLE[idx].target;
}

// PE 栏渲染
function updatePeBar() {
  const currentPE = getCurrentPE();
  const display = document.getElementById('peDisplay');
  const status  = document.getElementById('peStatus');
  const marker  = document.getElementById('peTrackMarker');
  const planBtn = document.getElementById('planBtn');
  const eqDiv   = document.getElementById('peEquityInfo');
  const loEl    = document.getElementById('peTrackLo');
  const hiEl    = document.getElementById('peTrackHi');

  if (!currentPE) {
    display.textContent = '--.--%'; display.className = 'pe-value pe-normal';
    status.textContent = '未输入PE'; status.className = 'pe-status normal';
    planBtn.className = 'pe-plan-btn neutral'; planBtn.textContent = '预案';
    if (marker) marker.style.display = 'none';
    if (loEl) loEl.style.display = 'none';
    if (hiEl) hiEl.style.display = 'none';
    if (eqDiv) eqDiv.style.display = 'none';
    return;
  }

  const v = currentPE.value, bounds = currentPE.bounds;
  display.innerHTML = `<span style="font-family:var(--f-num)">${v.toFixed(2)}%</span>`
    + (currentPE.isDynamic ? `<span style="font-size:10px;color:var(--accent);font-weight:600;margin-left:4px;vertical-align:top">实时</span>` : '');

  const PE_MID = (bounds.buyPct + bounds.sellPct) / 2;
  const span   = (bounds.sellPct - bounds.buyPct) * 2;
  const peMin  = PE_MID - span / 2, peMax = PE_MID + span / 2;
  const toPos  = pe => Math.min(Math.max((pe - peMin) / (peMax - peMin) * 100, 0), 100);

  if (marker) { marker.style.display = 'block'; marker.style.left = toPos(v) + '%'; }
  if (loEl)   { loEl.style.display = 'block';   loEl.style.left = toPos(bounds.buyPct) + '%'; }
  if (hiEl)   { hiEl.style.display = 'block';   hiEl.style.left = toPos(bounds.sellPct) + '%'; }

  if (eqDiv) {
    const eqData = calcCurrentEquity(loadHoldings());
    const target = getDynamicTarget('neutral');
    if (eqData && target != null) {
      const diff = eqData.equity - target;
      const sign = diff > 0 ? '+' : '';
      const wrongDir = (v >= 65 && diff > 2) || (v < 65 && diff < -2);
      const col = wrongDir ? '#f87171' : (diff > 0 ? '#f59e0b' : '#60a5fa');
      eqDiv.innerHTML = `目标<b style="font-family:var(--f-num)">${target}%</b> 实际<b style="color:${col};font-family:var(--f-num)">${eqData.equity.toFixed(2)}%</b> <span style="color:${col};font-family:var(--f-num)">${sign}${diff.toFixed(2)}%</span>`;
      eqDiv.style.display = 'flex';
    } else {
      eqDiv.style.display = 'none';
    }
  }

  if (v <= bounds.buyPct) {
    display.className = 'pe-value pe-danger-dn'; status.textContent = '▲ 增权信号'; status.className = 'pe-status triggered-buy';
    planBtn.className = 'pe-plan-btn buy'; planBtn.textContent = '增权';
    if (marker) marker.style.background = '#3b82f6';
  } else if (v >= bounds.sellPct) {
    display.className = 'pe-value pe-danger-up'; status.textContent = '▼ 降权信号'; status.className = 'pe-status triggered-sell';
    planBtn.className = 'pe-plan-btn sell'; planBtn.textContent = '降权';
    if (marker) marker.style.background = '#f59e0b';
  } else {
    display.className = 'pe-value pe-normal'; status.textContent = '待机'; status.className = 'pe-status normal';
    planBtn.className = 'pe-plan-btn neutral'; planBtn.textContent = '预案';
    if (marker) marker.style.background = 'var(--t1)';
  }
}

// 定锚弹窗
function openPeModal() {
  const peData = loadPe();
  if (peData) {
    document.getElementById('peModalBucket').value = peData.bucketStr || '65,70';
    document.getElementById('peModalInputPct').value = peData.peYest || '';
    document.getElementById('peModalPriceAnchor').value = peData.priceAnchor || '';
    document.getElementById('peModalBuyPrice').value = peData.priceBuy || '';
    document.getElementById('peModalSellPrice').value = peData.priceSell || '';
  }
  document.getElementById('peModal').style.display = 'flex';
}
function closePeModal() { document.getElementById('peModal').style.display = 'none'; }

function confirmPe() {
  const bucketStr    = document.getElementById('peModalBucket').value;
  const peYest       = parseFloat(document.getElementById('peModalInputPct').value);
  const priceAnchor  = parseFloat(document.getElementById('peModalPriceAnchor').value);
  const priceBuy     = parseFloat(document.getElementById('peModalBuyPrice').value);
  const priceSell    = parseFloat(document.getElementById('peModalSellPrice').value);
  if (isNaN(peYest) || isNaN(priceAnchor)) { alert('请填写完整的【基准PE】与【基准点位】！'); return; }
  savePe({bucketStr, peYest, priceAnchor, priceBuy: isNaN(priceBuy) ? null : priceBuy, priceSell: isNaN(priceSell) ? null : priceSell});
  updatePeBar(); closePeModal();
}