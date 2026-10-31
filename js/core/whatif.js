// Расчёт последствий: что будет с планом, если поставить задачу в определённое место.

import { clone, normalize } from './doc.js';
import { computePlan } from './plan.js';

export function simulate(doc, now, apply) {
  const draft = clone(doc);
  const id = apply(draft, now);
  normalize(draft);
  return { doc: draft, plan: computePlan(draft, now), id };
}

export function impactOf(basePlan, nextPlan, skipId) {
  let moved = 0;
  let maxShift = 0;
  const newlyLate = [];
  for (const item of basePlan.items) {
    if (item.id === skipId) continue;
    const other = nextPlan.byId.get(item.id);
    if (!other) continue;
    if (other.end > item.end) {
      moved += 1;
      maxShift = Math.max(maxShift, nextPlan.clock.between(item.end, other.end));
    }
    if (other.late > 0 && !item.late) newlyLate.push(item.task);
  }
  return { moved, maxShift, newlyLate };
}

// Самое позднее место в очереди, при котором ни эта задача, ни остальные не срывают дедлайн.
export function suggestIndex(doc, now, count, applyAtIndex) {
  const base = computePlan(doc, now);
  for (let index = count; index >= 0; index -= 1) {
    const sim = simulate(doc, now, (draft) => applyAtIndex(draft, index, now));
    const own = sim.plan.byId.get(sim.id);
    if (own && !own.late && !impactOf(base, sim.plan, sim.id).newlyLate.length) return index;
  }
  return null;
}
