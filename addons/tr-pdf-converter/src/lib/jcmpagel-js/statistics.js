/* ===================== Statistik-Funktionen ===================== */

const MONTH_MAP = {
  jan: 0, januar: 0,
  feb: 1, februar: 1,
  mär: 2, märz: 2, mar: 2, maerz: 2, march: 2,
  apr: 3, april: 3,
  mai: 4, may: 4,
  jun: 5, juni: 5, june: 5, giugno: 5,
  jul: 6, juli: 6, july: 6, luglio: 6,
  aug: 7, august: 7, agosto: 7,
  sep: 8, sept: 8, september: 8, settembre: 8,
  okt: 9, oktober: 9, oct: 9, october: 9, ottobre: 9,
  nov: 10, november: 10, novembre: 10,
  dez: 11, dezember: 11, dec: 11, december: 11, dicembre: 11
};

let chartIdCounter = 0;

function uniqueChartId(prefix = 'chart') {
  chartIdCounter += 1;
  return `${prefix}-${Date.now()}-${chartIdCounter}`;
}

function parseEuro(value) {
  if (typeof value === 'number') return value;
  if (!value || typeof value !== 'string') return 0;

  let normalized = value
    .replace(/\u00A0/g, '')
    .replace(/\s+/g, '')
    .replace(/€/g, '')
    .replace(/[^\d,.\-]/g, '')
    .trim();

  const hasComma = normalized.includes(',');
  const hasDot = normalized.includes('.');

  if (hasComma && hasDot) {
    if (normalized.lastIndexOf(',') > normalized.lastIndexOf('.')) {
      // European format: 1.234,56
      normalized = normalized.replace(/\./g, '').replace(/,/g, '.');
    } else {
      // English format: 1,234.56
      normalized = normalized.replace(/,/g, '');
    }
  } else if (hasComma) {
    // Assume comma decimal separator
    normalized = normalized.replace(/\./g, '').replace(/,/g, '.');
  } else {
    // Dot-only values may still contain thousands separators.
    normalized = normalized.replace(/\.(?=\d{3}(?:\.|$))/g, '');
  }

  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseGermanDate(value) {
  if (!value) return null;
  const parts = value.trim().split(/\s+/);
  if (parts.length < 3) return null;

  const day = parseInt(parts[0], 10);
  const monthKey = parts[1].toLowerCase().replace(/[.,]/g, '');
  const year = parseInt(parts[2], 10);
  const month = MONTH_MAP[monthKey];

  if (!Number.isInteger(day) || !Number.isInteger(year) || month == null) return null;
  return new Date(year, month, day);
}

function formatEuro(value) {
  return value.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function formatSignedEuro(value) {
  return `${value >= 0 ? '+' : ''}${formatEuro(value)}`;
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toMonthKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function monthLabelFromKey(monthKey) {
  if (!monthKey) return '';
  const [year, month] = monthKey.split('-').map(part => parseInt(part, 10));
  if (!Number.isInteger(year) || !Number.isInteger(month)) return monthKey;
  return new Date(year, month - 1, 1).toLocaleDateString('de-DE', { month: 'short', year: 'numeric' });
}

function normalizeMerchantLabel(value) {
  const raw = String(value || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  return raw || 'Unbekannt';
}

function buildDenseDailySeries(dailySeries) {
  if (!Array.isArray(dailySeries) || dailySeries.length === 0) return [];

  const sorted = [...dailySeries].sort((a, b) => a.date - b.date);
  const start = new Date(sorted[0].date.getFullYear(), sorted[0].date.getMonth(), sorted[0].date.getDate());
  const end = new Date(sorted[sorted.length - 1].date.getFullYear(), sorted[sorted.length - 1].date.getMonth(), sorted[sorted.length - 1].date.getDate());
  const byKey = new Map(sorted.map(entry => [toDateKey(entry.date), entry]));

  const dense = [];
  for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const date = new Date(cursor);
    const key = toDateKey(date);
    const source = byKey.get(key);
    dense.push({
      date,
      incoming: source ? source.incoming : 0,
      outgoing: source ? source.outgoing : 0,
      net: source ? source.net : 0,
      balance: source ? source.balance : 0
    });
  }
  return dense;
}

function buildRollingWindowSeries(denseDailySeries, windowSize = 30) {
  if (!Array.isArray(denseDailySeries) || denseDailySeries.length < windowSize) return [];

  const rolling = [];
  let runningIncoming = 0;
  let runningOutgoing = 0;

  for (let i = 0; i < denseDailySeries.length; i += 1) {
    runningIncoming += denseDailySeries[i].incoming;
    runningOutgoing += denseDailySeries[i].outgoing;

    if (i >= windowSize) {
      runningIncoming -= denseDailySeries[i - windowSize].incoming;
      runningOutgoing -= denseDailySeries[i - windowSize].outgoing;
    }

    if (i >= windowSize - 1) {
      rolling.push({
        date: denseDailySeries[i].date,
        incoming: runningIncoming,
        outgoing: runningOutgoing
      });
    }
  }

  return rolling;
}

function buildMerchantMoMSeries(numericTransactions) {
  const totalsByMonth = {};
  const totalsByMerchant = {};

  numericTransactions.forEach(tx => {
    if (tx.outgoing <= 0) return;
    const monthKey = toMonthKey(tx.date);
    const merchant = normalizeMerchantLabel(tx.raw.description || tx.raw.beschreibung);
    if (!totalsByMonth[monthKey]) totalsByMonth[monthKey] = {};
    totalsByMonth[monthKey][merchant] = (totalsByMonth[monthKey][merchant] || 0) + tx.outgoing;
    totalsByMerchant[merchant] = (totalsByMerchant[merchant] || 0) + tx.outgoing;
  });

  const monthKeys = Object.keys(totalsByMonth).sort();
  const currentMonthKey = monthKeys.length ? monthKeys[monthKeys.length - 1] : null;
  const previousMonthKey = monthKeys.length > 1 ? monthKeys[monthKeys.length - 2] : null;
  const currentTotals = currentMonthKey ? totalsByMonth[currentMonthKey] : {};
  const previousTotals = previousMonthKey ? totalsByMonth[previousMonthKey] : {};

  const entries = Object.entries(totalsByMerchant)
    .map(([label, total]) => {
      const current = currentTotals[label] || 0;
      const previous = previousTotals[label] || 0;
      const delta = current - previous;
      const deltaPct = previous > 0 ? (delta / previous) * 100 : null;
      return { label, total, current, previous, delta, deltaPct };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  return { entries, currentMonthKey, previousMonthKey };
}

function analyzeTransactions(transactions, typKey = "type") {
  if (!transactions || transactions.length === 0) return [];
  const types = {};
  transactions.forEach(tx => {
    const type = tx[typKey] || "Andere";
    types[type] = (types[type] || 0) + 1;
  });
  return Object.entries(types)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

function analyzeCashFlow(transactions) {
  const result = { incoming: 0, outgoing: 0 };
  transactions.forEach(tx => {
    if (tx.incoming) {
      const value = parseEuro(tx.incoming);
      result.incoming += value;
    }
    if (tx.outgoing) {
      const value = parseEuro(tx.outgoing);
      result.outgoing += value;
    }
  });
  return result;
}

function createStatsSummary(cash, mmf) {
  let html = '<div id="results-summary" class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-2">';
  html += `<h3 class="text-lg font-semibold text-slate-900">Transaktionsübersicht (${cash.length + mmf.length} Transaktionen insgesamt)</h3>`;
  if (cash.length > 0) {
    html += `<p class="text-sm text-slate-700"><strong class="font-semibold text-slate-900">${cash.length} Cash-Transaktionen</strong> gefunden</p>`;
  }
  if (mmf.length > 0) {
    html += `<p class="text-sm text-slate-700"><strong class="font-semibold text-slate-900">${mmf.length} Geldmarktfonds-Transaktionen</strong> gefunden</p>`;
  }
  html += '</div>';
  return html;
}

function createCharts(cash, mmf) {
  if (!cash || cash.length === 0) return null;

  const container = document.createElement('div');
  container.className = 'space-y-6';

  const numericTransactions = cash.map(tx => {
    const incoming = parseEuro(tx.incoming);
    const outgoing = parseEuro(tx.outgoing);
    const balance = parseEuro(tx.balance ?? tx.saldo);
    const date = parseGermanDate(tx.date ?? tx.datum);
    return {
      raw: tx,
      date,
      dateLabel: tx.date ?? tx.datum,
      incoming,
      outgoing,
      net: incoming - outgoing,
      balance
    };
  }).filter(tx => tx.date instanceof Date && !Number.isNaN(tx.date.getTime()));

  const totalIncoming = numericTransactions.reduce((sum, tx) => sum + tx.incoming, 0);
  const totalOutgoing = numericTransactions.reduce((sum, tx) => sum + tx.outgoing, 0);
  const netChange = totalIncoming - totalOutgoing;
  const outgoingCount = numericTransactions.filter(tx => tx.outgoing > 0).length;
  const avgSpend = outgoingCount ? totalOutgoing / outgoingCount : 0;

  const dailyMap = new Map();
  numericTransactions.forEach(tx => {
    const key = toDateKey(tx.date);
    if (!dailyMap.has(key)) {
      dailyMap.set(key, {
        date: tx.date,
        incoming: 0,
        outgoing: 0,
        net: 0,
        balance: tx.balance
      });
    }
    const entry = dailyMap.get(key);
    entry.incoming += tx.incoming;
    entry.outgoing += tx.outgoing;
    entry.net += tx.net;
    entry.balance = tx.balance;
  });
  const dailySeries = Array.from(dailyMap.values()).sort((a, b) => a.date - b.date);
  const denseDailySeries = buildDenseDailySeries(dailySeries);
  const rolling30Series = buildRollingWindowSeries(denseDailySeries, 30);

  const typeTotals = {};
  numericTransactions.forEach(tx => {
    const type = tx.raw.type || tx.raw.typ || 'Andere';
    typeTotals[type] = typeTotals[type] || { incoming: 0, outgoing: 0 };
    typeTotals[type].incoming += tx.incoming;
    typeTotals[type].outgoing += tx.outgoing;
  });
  const typeBreakdown = Object.entries(typeTotals)
    .map(([label, totals]) => ({ label, incoming: totals.incoming, outgoing: totals.outgoing }))
    .sort((a, b) => b.outgoing - a.outgoing);
  const merchantMoM = buildMerchantMoMSeries(numericTransactions);

  const weekdayTotals = Array(7).fill(0);
  numericTransactions.forEach(tx => {
    if (tx.outgoing > 0) {
      weekdayTotals[tx.date.getDay()] += tx.outgoing;
    }
  });
  const weekdayLabels = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

  const summaryGrid = document.createElement('div');
  summaryGrid.className = 'grid gap-4 md:grid-cols-2 xl:grid-cols-4';
  summaryGrid.innerHTML = `
    <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Eingänge</p>
      <p class="mt-2 text-2xl font-semibold text-emerald-600">${formatEuro(totalIncoming)}</p>
      <p class="mt-1 text-xs text-slate-500">Zinsen, Prämien &amp; Rückzahlungen</p>
    </div>
    <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Ausgänge</p>
      <p class="mt-2 text-2xl font-semibold text-rose-600">-${formatEuro(totalOutgoing)}</p>
      <p class="mt-1 text-xs text-slate-500">Kartenzahlungen, Sparpläne &amp; Überweisungen</p>
    </div>
    <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Saldo-Veränderung</p>
      <p class="mt-2 text-2xl font-semibold ${netChange >= 0 ? 'text-emerald-600' : 'text-rose-600'}">${formatEuro(netChange)}</p>
      <p class="mt-1 text-xs text-slate-500">${netChange >= 0 ? 'Netto-Plus' : 'Netto-Minus'} im Zeitraum</p>
    </div>
    <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Ø Kartenkauf</p>
      <p class="mt-2 text-2xl font-semibold text-slate-900">${formatEuro(avgSpend)}</p>
      <p class="mt-1 text-xs text-slate-500">Durchschnitt pro Kartentransaktion</p>
    </div>
  `;
  container.appendChild(summaryGrid);

  const chartGrid = document.createElement('div');
  chartGrid.className = 'grid gap-6 xl:grid-cols-2';
  container.appendChild(chartGrid);

  const chartConfigs = [];

  function addChartCard({ title, description, type, data, options }) {
    if (!data || !data.datasets || !data.datasets.length || !data.datasets[0].data.length) return;
    const card = document.createElement('div');
    card.className = 'flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm';
    const heading = document.createElement('div');
    heading.innerHTML = `
      <h4 class="text-base font-semibold text-slate-900">${title}</h4>
      ${description ? `<p class="text-sm text-slate-600">${description}</p>` : ''}
    `;
    const canvas = document.createElement('canvas');
    const canvasId = uniqueChartId('chart');
    canvas.id = canvasId;
    card.appendChild(heading);
    card.appendChild(canvas);
    chartGrid.appendChild(card);
    chartConfigs.push({ canvasId, type, data, options });
  }

  if (rolling30Series.length > 0) {
    addChartCard({
      title: '30-Tage-Trend: Einnahmen vs Ausgaben',
      description: 'Rollierende 30-Tage-Summe für Income und Spend.',
      type: 'line',
      data: {
        labels: rolling30Series.map(d => d.date.toLocaleDateString('de-DE', { day: '2-digit', month: 'short' })),
        datasets: [
          {
            label: 'Einnahmen (30T)',
            data: rolling30Series.map(d => Math.round(d.incoming * 100) / 100),
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.15)',
            tension: 0.35,
            fill: false
          },
          {
            label: 'Ausgaben (30T)',
            data: rolling30Series.map(d => Math.round(d.outgoing * 100) / 100),
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239, 68, 68, 0.15)',
            tension: 0.35,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'top' },
          tooltip: {
            callbacks: {
              label: context => `${context.dataset.label}: ${formatEuro(context.parsed.y)}`
            }
          }
        },
        scales: {
          y: {
            ticks: { callback: value => formatEuro(value) }
          }
        }
      }
    });
  }

  if (dailySeries.length > 1) {
    addChartCard({
      title: 'Saldoverlauf',
      description: 'Schlussstände pro Tag – zeigt, wie sich dein Kontostand entwickelt.',
      type: 'line',
      data: {
        labels: dailySeries.map(d => d.date.toLocaleDateString('de-DE', { day: '2-digit', month: 'short' })),
        datasets: [{
          label: 'Saldo',
          data: dailySeries.map(d => Math.round(d.balance * 100) / 100),
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.15)',
          fill: true,
          tension: 0.35
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            ticks: { callback: value => formatEuro(value) }
          }
        }
      }
    });
  }

  if (dailySeries.length > 0) {
    addChartCard({
      title: 'Nettozufluss nach Tag',
      description: 'Vergleich der täglichen Einnahmen und Ausgaben.',
      type: 'bar',
      data: {
        labels: dailySeries.map(d => d.date.toLocaleDateString('de-DE', { day: '2-digit', month: 'short' })),
        datasets: [{
          label: 'Nettozufluss',
          data: dailySeries.map(d => Math.round(d.net * 100) / 100),
          backgroundColor: dailySeries.map(d => d.net >= 0 ? '#10b981' : '#ef4444'),
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            ticks: { callback: value => formatEuro(value) }
          }
        }
      }
    });
  }

  const spendingTypes = typeBreakdown.filter(entry => entry.outgoing > 0).slice(0, 6);
  if (spendingTypes.length > 0) {
    addChartCard({
      title: 'Ausgaben nach Kategorie',
      description: 'Zeigt, wofür die meisten Ausgaben angefallen sind.',
      type: 'doughnut',
      data: {
        labels: spendingTypes.map(entry => entry.label),
        datasets: [{
          data: spendingTypes.map(entry => Math.round(entry.outgoing * 100) / 100),
          backgroundColor: ['#6366f1', '#ec4899', '#10b981', '#facc15', '#f97316', '#0ea5e9']
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'right' },
          tooltip: {
            callbacks: {
              label: context => `${context.label}: ${formatEuro(context.parsed)}`
            }
          }
        }
      }
    });
  }

  if (merchantMoM.entries.length > 0) {
    const currentMonthLabel = monthLabelFromKey(merchantMoM.currentMonthKey);
    const previousMonthLabel = merchantMoM.previousMonthKey ? monthLabelFromKey(merchantMoM.previousMonthKey) : 'Vormonat';
    const description = merchantMoM.previousMonthKey
      ? `Top 10 nach Gesamtausgaben. Vergleich ${previousMonthLabel} vs ${currentMonthLabel}.`
      : `Top 10 nach Gesamtausgaben. Für ${currentMonthLabel} liegt noch kein vollständiger Vormonat vor.`;

    addChartCard({
      title: 'Top 10 Händler nach Ausgaben (MoM)',
      description,
      type: 'bar',
      data: {
        labels: merchantMoM.entries.map(entry => entry.label.length > 32 ? `${entry.label.slice(0, 29)}…` : entry.label),
        datasets: [
          {
            label: previousMonthLabel,
            data: merchantMoM.entries.map(entry => Math.round(entry.previous * 100) / 100),
            backgroundColor: '#cbd5e1',
            borderRadius: 6
          },
          {
            label: currentMonthLabel,
            data: merchantMoM.entries.map(entry => Math.round(entry.current * 100) / 100),
            backgroundColor: '#0ea5e9',
            borderRadius: 6
          }
        ]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        plugins: {
          legend: { position: 'top' },
          tooltip: {
            callbacks: {
              label: context => `${context.dataset.label}: ${formatEuro(context.parsed.x)}`,
              afterBody: contextItems => {
                const idx = contextItems?.[0]?.dataIndex;
                if (!Number.isInteger(idx)) return '';
                const entry = merchantMoM.entries[idx];
                if (!merchantMoM.previousMonthKey) return 'MoM: Noch kein Vormonat vorhanden';
                if (entry.previous <= 0) return `MoM: Neu (+${formatEuro(entry.current)})`;
                return `MoM: ${entry.delta >= 0 ? '+' : ''}${entry.deltaPct.toFixed(1)}% (${formatSignedEuro(entry.delta)})`;
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { callback: value => formatEuro(value) }
          }
        }
      }
    });
  }

  if (weekdayTotals.some(value => value > 0)) {
    addChartCard({
      title: 'Ausgaben nach Wochentag',
      description: 'Welche Tage sind kostenintensiv?',
      type: 'radar',
      data: {
        labels: weekdayLabels,
        datasets: [{
          label: 'Ausgaben',
          data: weekdayTotals.map(v => Math.round(v * 100) / 100),
          backgroundColor: 'rgba(236, 72, 153, 0.15)',
          borderColor: '#ec4899',
          pointBackgroundColor: '#ec4899',
          pointRadius: 3
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          r: {
            ticks: { callback: value => formatEuro(value) }
          }
        }
      }
    });
  }

  if (chartGrid.children.length === 0) {
    chartGrid.remove();
  }

  return { element: container, charts: chartConfigs };
}

function renderCharts(chartConfigs) {
  if (!Array.isArray(chartConfigs) || chartConfigs.length === 0) return;
  chartConfigs.forEach(config => {
    const canvas = document.getElementById(config.canvasId);
    if (!canvas || canvas.dataset.chartInitialized === 'true') return;
    try {
      new Chart(canvas.getContext('2d'), {
        type: config.type,
        data: config.data,
        options: config.options || {}
      });
      canvas.dataset.chartInitialized = 'true';
    } catch (error) {
      console.error('Fehler beim Rendern des Charts:', error);
    }
  });
}
