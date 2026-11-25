(() => {
  const series = [
    ['started', 'Начато изучение'],
    ['reviewed', 'Повторено'],
    ['learned', 'Достигнута ступень «Выучено»'],
    ['known', 'Уже известные']
  ];
  // Stacks grow from the baseline in this order.
  const stackOrder = ['known', 'started', 'reviewed', 'learned'];
  const periods = { week: 'Неделя', month: 'Месяц', season: 'Сезон', year: 'Год' };
  const localDay = date => [
    date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
  const shift = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  const dayLabel = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' });
  const monthLabel = new Intl.DateTimeFormat('ru', { month: 'short' });
  const fullDate = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', year: 'numeric' });
  const weekday = new Intl.DateTimeFormat('ru', { weekday: 'short' });
  const number = new Intl.NumberFormat('ru');
  const dateLabel = date => dayLabel.format(date).replace(/\.$/, '');
  const unique = () => Object.fromEntries(series.map(([kind]) => [kind, new Set()]));

  function bucketsFor(period, today) {
    if (period === 'year') {
      return Array.from({ length: 12 }, (_, i) => {
        const start = new Date(today.getFullYear(), today.getMonth() - 11 + i, 1);
        const end = i === 11 ? today : new Date(start.getFullYear(), start.getMonth() + 1, 0);
        return { start, end, label: monthLabel.format(start), title: dateLabel(start) + ' – ' + dateLabel(end) };
      });
    }
    const days = { week: 7, month: 30, season: 90 }[period];
    const step = period === 'season' ? 7 : 1;
    return Array.from({ length: Math.ceil(days / step) }, (_, i) => {
      const start = shift(today, 1 - days + i * step);
      const end = shift(today, Math.min(0, 1 - days + (i + 1) * step - 1));
      const label = period === 'week' ? weekday.format(start) : dateLabel(start);
      return { start, end, label, title: step === 1 ? dateLabel(start) : dateLabel(start) + ' – ' + dateLabel(end) };
    });
  }

  function activityId(kind, cardKey, date = new Date()) {
    return localDay(date) + '|' + kind + '|' + cardKey;
  }

  function aggregate(progress, activity, period, today = new Date()) {
    const buckets = bucketsFor(period, today).map(bucket => ({
      ...bucket, first: localDay(bucket.start), last: localDay(bucket.end), cards: unique()
    }));
    const total = unique(), selected = unique();
    const events = { ...activity };
    for (const [key, item] of Object.entries(progress)) {
      if (!Number.isFinite(item.l) && item.o > 0) total.known.add(key);
      for (const [kind, ts] of [['started', item.l], ['reviewed', item.lastReview]]) {
        if (Number.isFinite(ts) && ts > 0) {
          const id = activityId(kind, key, new Date(ts * 1000));
          if (!Object.hasOwn(events, id)) events[id] = true;
        }
      }
    }
    const todayKey = localDay(today);
    for (const [id, active] of Object.entries(events)) {
      if (active !== true) continue;
      const first = id.indexOf('|'), second = id.indexOf('|', first + 1);
      const day = id.slice(0, first), kind = id.slice(first + 1, second), key = id.slice(second + 1);
      if (second < 0 || !Object.hasOwn(total, kind) || !Object.hasOwn(progress, key) || day > todayKey) continue;
      total[kind].add(key);
      const bucket = buckets.find(item => item.first <= day && day <= item.last);
      if (bucket) {
        bucket.cards[kind].add(key);
        selected[kind].add(key);
      }
    }
    return { buckets, total, selected };
  }

  function render(container, { progress, activity, learnedBox, period = 'week', today = new Date(), onPeriod }) {
    const { buckets, total, selected } = aggregate(progress, activity, period, today);
    const count = value => number.format(value);
    const max = Math.max(...buckets.map(bucket => series.reduce((sum, [kind]) => sum + bucket.cards[kind].size, 0)));
    const step = [1, 2, 5, 10].map(value => value * 10 ** Math.floor(Math.log10(Math.max(1, max / 4))))
      .find(value => value >= max / 4);
    const scale = Math.max(1, step) * 4;
    const learning = Object.values(progress).filter(item => item.b < learnedBox).length;
    const rangeDate = period === 'year' ? date => fullDate.format(date) : dateLabel;
    const dateRange = rangeDate(buckets[0].start) + ' – ' + rangeDate(today);
    const control = Object.entries(periods).map(([id, label]) =>
      `<button type="button" data-period="${id}" aria-pressed="${id === period}">${label}</button>`).join('');
    const yTicks = Array.from({ length: 5 }, (_, i) => `<span>${count(scale - i * scale / 4)}</span>`).join('');
    const description = bucket => series.map(([kind, label]) => `${label}: ${count(bucket.cards[kind].size)}`).join(' · ');
    const plotHeight = 160, minSegmentHeight = 15;
    const largestSegment = Math.max(...buckets.flatMap(bucket => stackOrder.map(kind => bucket.cards[kind].size)));
    const labelWidth = String(largestSegment).length;
    let smallSegments = false;
    const columns = buckets.map((bucket, i) => {
      const parts = stackOrder.map(kind => ({ kind, n: bucket.cards[kind].size })).filter(part => part.n);
      const minHeight = parts.length * minSegmentHeight;
      let scaledHeight = 0, extra = 0;
      for (const part of parts) {
        const proportional = plotHeight * part.n / scale;
        part.extra = Math.max(0, proportional - minSegmentHeight);
        scaledHeight += proportional;
        extra += part.extra;
        if (proportional < minSegmentHeight) smallSegments = true;
      }
      const height = Math.max(minHeight, scaledHeight);
      const segments = parts.map(({ kind, n, extra: space }) => {
        const partHeight = minSegmentHeight + (extra ? space * (height - minHeight) / extra : 0);
        return `<span class="results-mark results-${kind}" style="height:${partHeight}px">${n}</span>`;
      }).join('');
      return `<button type="button" class="results-column" data-column="${i}" aria-label="${bucket.title}. ${description(bucket)}" aria-pressed="false">
        <span class="results-track" aria-hidden="true"><span class="results-stack" style="height:${height}px">${segments}</span></span>
        <span class="results-tick" aria-hidden="true">${bucket.label}</span>
      </button>`;
    }).join('');
    const rows = series.map(([kind, label]) => `<tr><th scope="row"><span class="results-swatch results-${kind}" aria-hidden="true"></span>${label}</th><td>${count(selected[kind].size)}</td><td>${count(total[kind].size)}</td></tr>`).join('');
    container.innerHTML = `
      <h2>Результаты</h2>
      <div class="results-periods" role="group" aria-label="Период статистики">${control}</div>
      <p class="results-range">${dateRange}</p>
      <div class="results-chart" style="--plot-height:${plotHeight}px;--bar-label-width:${labelWidth}ch" role="group" aria-label="Активность по карточкам">
        <div class="results-axis" aria-hidden="true">${yTicks}</div>
        <div class="results-scroll">
          <div class="results-columns" style="--columns:${buckets.length}" data-span="${period}">${columns}</div>
        </div>
      </div>
      ${smallSegments ? '<p class="results-scale-note results-muted">Тонкие полоски увеличены, чтобы поместились цифры.</p>' : ''}
      <p class="results-detail results-muted" aria-live="polite">${!max ? 'За этот период активности пока нет.' : period === 'week' ? 'Нажми на столбец, чтобы увидеть детали.' : 'Листай по горизонтали или нажми на столбец.'}</p>
      <p class="results-learning">В изучении сейчас <strong>${count(learning)}</strong></p>
      <table class="results-totals"><thead><tr><th scope="col">Активность</th><th scope="col">За период</th><th scope="col">Всего</th></tr></thead><tbody>${rows}</tbody></table>`;
    const scroll = container.querySelector('.results-scroll');
    if (period !== 'week') scroll.scrollLeft = scroll.scrollWidth;
    for (const button of container.querySelectorAll('[data-period]')) button.addEventListener('click', () => {
      if (button.dataset.period !== period) onPeriod(button.dataset.period);
    });
    const detail = container.querySelector('.results-detail');
    for (const button of container.querySelectorAll('[data-column]')) button.addEventListener('click', () => {
      container.querySelector('[data-column][aria-pressed=true]')?.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-pressed', 'true');
      const bucket = buckets[Number(button.dataset.column)];
      detail.textContent = bucket.title + ' · ' + description(bucket);
    });
  }

  function sectionMarkup({ category, name, levels, accuracy, listButton = '' }) {
    const count = value => number.format(value);
    const totals = levels.reduce((sum, row) => ({
      words: sum.words + row.words,
      learned: sum.learned + row.learned,
      learning: sum.learning + row.learning
    }), { words: 0, learned: 0, learning: 0 });
    const rows = levels.map(({ label, words, learned, learning }) => `
      <tr><th scope="row">${label}</th><td>${count(learned)} из ${count(words)}</td><td>${count(learning)}</td></tr>
    `).join('');
    return `<details class="section-progress" data-category="${category}">
      <summary>
        <span class="section-name">${name}</span>
        <strong class="section-earned">Выучено ${count(totals.learned)} из ${count(totals.words)}</strong>
        <span class="section-secondary">В изучении ${count(totals.learning)}${accuracy == null ? '' : ' · верно ' + accuracy + '%'}</span>
      </summary>
      <div class="section-body">
        <table class="results-totals section-levels" aria-label="${name} по уровням">
          <thead><tr><th scope="col">Уровень</th><th scope="col">Выучено</th><th scope="col">В изучении</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${listButton}
      </div>
    </details>`;
  }

  window.WortschatzResults = { render, activityId, sectionMarkup };
})();
