export interface RollupInput {
  metricDates: string[];   // 要产出 MetricsDaily 的日期(YYYY-MM-DD)
  cohortDates: string[];   // 要产出 CohortDaily 的队列日
  registrations: { userId: string; date: string }[];
  activity: { userId: string; date: string }[]; // 去重的 用户×活跃日
  dailyAgg: Record<string, {
    revenueFen: number; topupCount: number; grantedPoints: number;
    consumedPoints: number; payingUsers: number; newPayingUsers: number;
  }>;
  revenueByUser: Record<string, { paidAtDate: string; amountFen: number }[]>;
}

export interface MetricsDailyRow {
  date: string; registered: number; dau: number; wau: number; mau: number;
  newPayingUsers: number; payingTotal: number; revenueFen: number;
  grantedPoints: number; consumedPoints: number;
}
export interface CohortDailyRow {
  cohortDate: string; dayOffset: number; cohortSize: number;
  retained: number; cumRevenueFen: number; cumPayers: number;
}

const MS_DAY = 86_400_000;

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(d.getTime() + n * MS_DAY).toISOString().slice(0, 10);
}

function diffDays(a: string, b: string): number {
  // b - a，单位天
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_DAY);
}

export const COHORT_MAX_OFFSET = 30;

export function computeRollup(input: RollupInput): {
  metricsDaily: MetricsDailyRow[];
  cohortDaily: CohortDailyRow[];
} {
  // 活跃索引：date -> Set<userId>
  const activeByDate = new Map<string, Set<string>>();
  for (const a of input.activity) {
    if (!activeByDate.has(a.date)) activeByDate.set(a.date, new Set());
    activeByDate.get(a.date)!.add(a.userId);
  }
  const activeCount = (from: string, to: string): number => {
    // [from,to] 闭区间去重活跃人数
    const set = new Set<string>();
    for (let d = from; diffDays(d, to) >= 0; d = addDays(d, 1)) {
      const s = activeByDate.get(d);
      if (s) for (const u of s) set.add(u);
    }
    return set.size;
  };

  // 注册索引：date -> userId[]
  const regByDate = new Map<string, string[]>();
  for (const r of input.registrations) {
    if (!regByDate.has(r.date)) regByDate.set(r.date, []);
    regByDate.get(r.date)!.push(r.userId);
  }

  // payingTotal：按 dailyAgg 所有日期排序累加 newPayingUsers
  const aggDatesSorted = Object.keys(input.dailyAgg).sort();
  const payingTotalByDate = new Map<string, number>();
  let running = 0;
  for (const d of aggDatesSorted) {
    running += input.dailyAgg[d].newPayingUsers;
    payingTotalByDate.set(d, running);
  }
  const payingTotalAsOf = (date: string): number => {
    // 截至 date（含）的累计：取 <=date 的最后一个累加值
    let val = 0;
    for (const d of aggDatesSorted) {
      if (diffDays(d, date) >= 0) val = payingTotalByDate.get(d)!;
      else break;
    }
    return val;
  };

  const metricsDaily: MetricsDailyRow[] = input.metricDates.map((date) => {
    const agg = input.dailyAgg[date];
    return {
      date,
      registered: regByDate.get(date)?.length ?? 0,
      dau: activeByDate.get(date)?.size ?? 0,
      wau: activeCount(addDays(date, -6), date),
      mau: activeCount(addDays(date, -29), date),
      newPayingUsers: agg?.newPayingUsers ?? 0,
      payingTotal: payingTotalAsOf(date),
      revenueFen: agg?.revenueFen ?? 0,
      grantedPoints: agg?.grantedPoints ?? 0,
      consumedPoints: agg?.consumedPoints ?? 0,
    };
  });

  const cohortDaily: CohortDailyRow[] = [];
  for (const cohortDate of input.cohortDates) {
    const members = regByDate.get(cohortDate) ?? [];
    const memberSet = new Set(members);
    // 预排序每个成员的付费事件（按日期升序）
    for (let offset = 0; offset <= COHORT_MAX_OFFSET; offset++) {
      const day = addDays(cohortDate, offset);
      // 留存：成员中当天活跃的人数
      let retained = 0;
      const activeSet = activeByDate.get(day);
      if (activeSet) for (const u of members) if (activeSet.has(u)) retained++;
      // 累计实付 + 付费人数（成员中截至 day 有付费的）
      let cumRevenueFen = 0;
      let cumPayers = 0;
      for (const u of members) {
        const evs = input.revenueByUser[u];
        if (!evs) continue;
        let paid = 0;
        let hasPaid = false;
        for (const e of evs) {
          if (diffDays(e.paidAtDate, day) >= 0 && diffDays(cohortDate, e.paidAtDate) >= 0) {
            paid += e.amountFen;
            hasPaid = true;
          }
        }
        cumRevenueFen += paid;
        if (hasPaid) cumPayers++;
      }
      void memberSet;
      cohortDaily.push({ cohortDate, dayOffset: offset, cohortSize: members.length, retained, cumRevenueFen, cumPayers });
    }
  }

  return { metricsDaily, cohortDaily };
}
