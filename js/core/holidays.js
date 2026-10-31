// Производственный календарь РФ для пятидневки.
// 2026: постановление Правительства № 1466 от 24.09.2025.
// 2027: постановление Правительства № 1187 от 17.09.2026, данные сверены с xmlcalendar.ru.
// Для остальных лет действуют только фиксированные праздники, без переносов.

const NEW_YEAR = 'Новогодние каникулы';
const MOVED = 'Перенесённый выходной';

const FIXED = {
  '01-01': NEW_YEAR,
  '01-02': NEW_YEAR,
  '01-03': NEW_YEAR,
  '01-04': NEW_YEAR,
  '01-05': NEW_YEAR,
  '01-06': NEW_YEAR,
  '01-07': 'Рождество Христово',
  '01-08': NEW_YEAR,
  '02-23': 'День защитника Отечества',
  '03-08': 'Международный женский день',
  '05-01': 'Праздник Весны и Труда',
  '05-09': 'День Победы',
  '06-12': 'День России',
  '11-04': 'День народного единства',
};

const TRANSFERS = {
  2026: {
    off: { '01-09': MOVED, '03-09': MOVED, '05-11': MOVED, '12-31': MOVED },
    work: [],
  },
  2027: {
    off: {
      '01-09': NEW_YEAR,
      '01-10': NEW_YEAR,
      '02-22': MOVED,
      '05-03': MOVED,
      '05-10': MOVED,
      '06-14': MOVED,
      '11-05': MOVED,
      '12-31': MOVED,
    },
    work: ['02-20'],
  },
};

export function holidayInfo(key) {
  const year = key.slice(0, 4);
  const monthDay = key.slice(5);
  const transfers = TRANSFERS[year];
  if (transfers?.work.includes(monthDay)) return { work: true, name: 'Рабочая суббота' };
  const name = transfers?.off[monthDay] ?? FIXED[monthDay];
  return name ? { off: true, name } : null;
}
