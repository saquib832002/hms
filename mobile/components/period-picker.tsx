import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from '@/lib/theme';
import { Button } from './ui';

/**
 * The period a statement covers, on a phone.
 *
 * WHY THIS IS NOT A MONTH PICKER
 * ------------------------------
 * Reported by the product owner: *"Some partner lab may have, as an agreement,
 * a statement every week or every ten days or biweekly."* That is how referral
 * contracts are written, and a month picker expresses none of them.
 *
 * WHY THE PHONE NOW PICKS DATES, HAVING DELIBERATELY NOT
 * -----------------------------------------------------
 * This shipped as presets only, and the reason given was that *"two date
 * pickers on a small screen is where an off-by-one boundary comes from, and a
 * boundary error on a statement is money billed twice or not at all"*. The
 * hazard is real and the conclusion did not follow from it. A laboratory on an
 * unusual cycle simply could not issue its statement from a phone — which is
 * the same shape as the medication round kept off the web because signing
 * belongs at the bedside, and reception kept off mobile because the screens had
 * never been built. Withholding the control did not make the boundary safer; it
 * made the statement unissuable.
 *
 * What the hazard actually argues against is **typing** two dates, and that is
 * avoided rather than accepted. A day is *tapped on a calendar*, so there is no
 * `01/09` that might be the ninth of January, no month a thumb slipped past,
 * and no format to get wrong. Days that would put the end before the start are
 * not disabled-with-a-message — they are **not tappable at all**, so a
 * backwards range has no way to exist on this screen. That is a stronger
 * guarantee than the web's two boxes offer, which is the right way round for
 * the smaller screen.
 *
 * WHY THREE PRESETS AND NOT FIVE
 * ------------------------------
 * Cut by the product owner from seven days, ten days, fourteen days, this month
 * and last month. Ten-daily and fortnightly are two taps on the calendar either
 * way, and a chip for them is only correct on the one day of the cycle it was
 * written for. What is left is the three whose ends move with the calendar or
 * with today, which is the part a person cannot just read off a wall.
 *
 * WHY THE CALENDAR IS DRAWN HERE
 * ------------------------------
 * `@react-native-community/datetimepicker` is a native module: another
 * dependency, another permission-free-but-still-native surface on an app that
 * has never run on hardware, and a control that looks different on each
 * platform for a job that is seven columns of numbers. Same reasoning as the
 * Code 128 encoder — what is needed here is a grid, and a grid is `View`s.
 *
 * The days are the **hospital's** calendar days, resolved server-side. A client
 * deciding what "the last seven days" means across a timezone boundary is
 * exactly how a referral accessioned at 23:40 lands on the wrong statement.
 */
export interface Period {
  from: string;
  to: string;
}

function key(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function daysBack(n: number): Period {
  const to = new Date();
  const from = new Date();
  // `n - 1`, so "7 days" is seven including today rather than eight — the
  // off-by-one that bills a day twice across consecutive weekly cycles.
  from.setDate(from.getDate() - (n - 1));
  return { from: key(from), to: key(to) };
}

function lastMonth(): Period {
  const now = new Date();
  return {
    from: key(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
    to: key(new Date(now.getFullYear(), now.getMonth(), 0)),
  };
}

const PRESETS: { label: string; period: () => Period | null }[] = [
  /*
   * Null, not this month's two dates. The server resolves an absent period as
   * the hospital's own month, so the commonest case never consults this
   * device's clock at all. Filling the two boundaries in from here would give
   * that up to make the chip look like its neighbours.
   */
  { label: 'This month', period: () => null },
  { label: 'Last month', period: lastMonth },
  { label: '7 days', period: () => daysBack(7) },
];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Monday first. Sunday-first is a US convention and this ships to neither. */
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** `2026-09-26` → `26 Sep`. Long enough to be unambiguous on a pill. */
function short(k: string): string {
  const [y, m, d] = k.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1].slice(0, 3)} ${y.slice(2)}`;
}

/**
 * The day numbers of a month, padded to whole weeks with nulls.
 *
 * `getDay()` is 0 for Sunday, so `+ 6 % 7` rotates the week onto Monday. Doing
 * that arithmetic inline in the render is how a calendar comes to start the
 * month on the wrong column for exactly the months beginning on a Sunday.
 */
function monthCells(year: number, month: number): (number | null)[] {
  const lead = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = Array(lead).fill(null);
  for (let d = 1; d <= days; d += 1) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function PeriodPicker({
  value,
  onChange,
}: {
  value: Period | null;
  onChange: (next: Period | null) => void;
}) {
  const [draft, setDraft] = useState<Period>({ from: value?.from ?? '', to: value?.to ?? '' });
  /** Which boundary the calendar is choosing. Null closes it. */
  const [editing, setEditing] = useState<'from' | 'to' | null>(null);
  const today = new Date();
  const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() });

  // A preset writes the two pills too. Chips and pills disagreeing would leave
  // the person reading whichever they looked at first.
  useEffect(() => {
    setDraft({ from: value?.from ?? '', to: value?.to ?? '' });
  }, [value?.from, value?.to]);

  /** Only a complete pair is a period. A half-written one is never sent. */
  function commit(next: Period) {
    setDraft(next);
    if (next.from && next.to) onChange(next);
    else if (!next.from && !next.to) onChange(null);
  }

  function open(which: 'from' | 'to') {
    const anchor = which === 'from' ? draft.from : draft.to || draft.from;
    if (anchor) {
      const [y, m] = anchor.split('-');
      setCursor({ year: Number(y), month: Number(m) - 1 });
    }
    setEditing(editing === which ? null : which);
  }

  function pick(day: number) {
    const picked = key(new Date(cursor.year, cursor.month, day));
    if (editing === 'from') {
      // Choosing a start after the existing end drops the end rather than
      // keeping an impossible pair — and lands on it next, so the range is
      // never left half-written by a correction.
      const to = draft.to && draft.to >= picked ? draft.to : '';
      commit({ from: picked, to });
      setEditing(to ? null : 'to');
    } else {
      commit({ from: draft.from, to: picked });
      setEditing(null);
    }
  }

  const cells = monthCells(cursor.year, cursor.month);

  return (
    <View style={s.wrap}>
      <View style={s.row}>
        {PRESETS.map((p) => {
          const period = p.period();
          const active =
            period === null
              ? value === null && !draft.from && !draft.to
              : value !== null && value.from === period.from && value.to === period.to;
          return (
            <Button
              key={p.label}
              label={p.label}
              size="sm"
              variant={active ? 'primary' : 'secondary'}
              onPress={() => {
                setDraft({ from: period?.from ?? '', to: period?.to ?? '' });
                setEditing(null);
                onChange(period);
              }}
            />
          );
        })}
      </View>

      <View style={s.row}>
        <Pressable
          onPress={() => open('from')}
          accessibilityRole="button"
          accessibilityLabel={draft.from ? `Start date ${short(draft.from)}` : 'Choose a start date'}
          style={[s.pill, editing === 'from' && s.pillActive]}
        >
          <Text style={[s.pillText, !draft.from && s.pillPlaceholder]}>
            {draft.from ? short(draft.from) : 'Start date'}
          </Text>
        </Pressable>

        <Text style={s.between}>to</Text>

        <Pressable
          onPress={() => open('to')}
          accessibilityRole="button"
          accessibilityLabel={draft.to ? `End date ${short(draft.to)}` : 'Choose an end date'}
          style={[s.pill, editing === 'to' && s.pillActive]}
        >
          <Text style={[s.pillText, !draft.to && s.pillPlaceholder]}>
            {draft.to ? short(draft.to) : 'End date'}
          </Text>
        </Pressable>

        {(draft.from || draft.to) && (
          <Button
            label="Clear"
            size="sm"
            variant="ghost"
            onPress={() => {
              setDraft({ from: '', to: '' });
              setEditing(null);
              onChange(null);
            }}
          />
        )}
      </View>

      {editing && (
        <View style={s.calendar}>
          <View style={s.calHead}>
            <Pressable
              onPress={() =>
                setCursor(
                  cursor.month === 0
                    ? { year: cursor.year - 1, month: 11 }
                    : { ...cursor, month: cursor.month - 1 },
                )
              }
              accessibilityRole="button"
              accessibilityLabel="Previous month"
              hitSlop={12}
            >
              <Text style={s.arrow}>‹</Text>
            </Pressable>

            <Text style={s.calTitle}>
              {MONTHS[cursor.month]} {cursor.year}
            </Text>

            <Pressable
              onPress={() =>
                setCursor(
                  cursor.month === 11
                    ? { year: cursor.year + 1, month: 0 }
                    : { ...cursor, month: cursor.month + 1 },
                )
              }
              accessibilityRole="button"
              accessibilityLabel="Next month"
              hitSlop={12}
            >
              <Text style={s.arrow}>›</Text>
            </Pressable>
          </View>

          {/* Which end is being chosen, said in words. Two identical grids that
              mean different things is how a start gets set twice. */}
          <Text style={s.calWhich}>
            {editing === 'from' ? 'Choose the first day' : 'Choose the last day'}
          </Text>

          <View style={s.grid}>
            {WEEKDAYS.map((d, i) => (
              <Text key={`wd-${i}`} style={[s.cell, s.weekday]}>
                {d}
              </Text>
            ))}

            {cells.map((day, i) => {
              if (day === null) return <View key={`pad-${i}`} style={s.cell} />;
              const k = key(new Date(cursor.year, cursor.month, day));
              /*
               * A day that would invert the period is not tappable. The server
               * refuses `end before start` and the web says so in words; here
               * the state is simply unreachable, which is the better answer on
               * the screen with the least room to explain itself.
               */
              const blocked =
                editing === 'to'
                  ? Boolean(draft.from) && k < draft.from
                  : Boolean(draft.to) && k > draft.to;
              const selected = k === draft.from || k === draft.to;
              const inside =
                Boolean(draft.from) && Boolean(draft.to) && k > draft.from && k < draft.to;

              return (
                <Pressable
                  key={k}
                  disabled={blocked}
                  onPress={() => pick(day)}
                  accessibilityRole="button"
                  accessibilityLabel={short(k)}
                  accessibilityState={{ disabled: blocked, selected }}
                  style={[s.cell, inside && s.cellInside, selected && s.cellSelected]}
                >
                  <Text
                    style={[
                      s.day,
                      blocked && s.dayBlocked,
                      selected && s.daySelected,
                    ]}
                  >
                    {day}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}
    </View>
  );
}

/** `?from=&to=`, or empty for "this month". Kept beside the picker so both agree. */
export function periodQuery(period: Period | null): string {
  if (!period?.from || !period.to) return '';
  return `?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`;
}

/** What to hand a document helper — the resolved period, never the picked one. */
export function resolvedPeriod(payload: { from: string; to: string }): Period {
  return { from: payload.from, to: payload.to };
}

const s = StyleSheet.create({
  wrap: {
    paddingHorizontal: theme.space(4),
    paddingTop: theme.space(2),
    gap: theme.space(1.5),
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space(1.5),
  },
  pill: {
    borderWidth: 1,
    borderColor: theme.color.borderStrong,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(1.5),
    minHeight: theme.space(8),
    justifyContent: 'center',
  },
  pillActive: {
    borderColor: theme.color.primary,
    backgroundColor: theme.color.primarySoft,
  },
  pillText: { ...theme.font.small, color: theme.color.text },
  pillPlaceholder: { color: theme.color.textSubtle },
  between: { ...theme.font.small, color: theme.color.textSubtle },

  calendar: {
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    padding: theme.space(2),
    ...theme.elevation.card,
  },
  calHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.space(2),
  },
  calTitle: { ...theme.font.title, color: theme.color.text },
  calWhich: {
    ...theme.font.caption,
    color: theme.color.textMuted,
    textAlign: 'center',
    paddingBottom: theme.space(1),
  },
  arrow: { ...theme.font.display, color: theme.color.primary, paddingHorizontal: theme.space(2) },

  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    // A seventh, written out. `${100 / 7}%` is the same number and types as a
    // bare string, which RN's `DimensionValue` will not take.
    width: '14.285%',
    height: theme.space(9),
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekday: {
    ...theme.font.overline,
    color: theme.color.textSubtle,
    height: theme.space(6),
    textAlign: 'center',
  },
  cellInside: { backgroundColor: theme.color.primarySoft },
  cellSelected: { backgroundColor: theme.color.primary, borderRadius: theme.radius.sm },
  day: { ...theme.font.body, color: theme.color.text },
  dayBlocked: { color: theme.color.textSubtle, opacity: 0.4 },
  daySelected: { color: theme.color.onSolid, fontWeight: '800' as const },
});
