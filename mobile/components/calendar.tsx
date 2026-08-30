import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { accentFor, theme } from '@/lib/theme';
import { useAuth } from '@/lib/auth-context';

/**
 * A month calendar, built from plain Views.
 *
 * WHY NOT A DATE-PICKER LIBRARY
 * -----------------------------
 * `@react-native-community/datetimepicker` opens the *platform* dialog, which
 * knows nothing about this hospital: it will happily offer a Sunday the clinic
 * is shut, and it works in device-local time, which is the one thing every
 * other date in this app deliberately avoids. It is also a native module — one
 * more thing that has to survive an Expo Go version change.
 *
 * A grid of buttons has none of those problems, renders identically on both
 * platforms, and lets days be marked up with what the *server* said about them.
 *
 * ALL DATES HERE ARE PLAIN YYYY-MM-DD STRINGS
 * -------------------------------------------
 * Never `Date` objects in local time. A calendar that builds `new Date(y, m, d)`
 * on a phone in a different zone to the clinic selects the day before or after
 * roughly half the time, and the bug only appears for staff who travel.
 */

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export function MonthCalendar({
  value,
  min,
  max,
  onChange,
}: {
  /** Selected day, YYYY-MM-DD. */
  value: string;
  /** Earliest selectable day, YYYY-MM-DD. Usually today in the clinic's zone. */
  min?: string;
  /**
   * Latest selectable day, YYYY-MM-DD.
   *
   * Booking looks forward and never sets this; a report looks back and caps at
   * today. Both comparisons are string comparisons, which is exact for
   * zero-padded ISO dates and cannot be shifted by a timezone the way parsing
   * to a Date and comparing instants can.
   */
  max?: string;
  onChange: (date: string) => void;
}) {
  const { user } = useAuth();
  const accent = accentFor(user?.role);

  // The month on display, which is not the same as the selection — you can
  // page to December without having chosen a day in it.
  const [cursor, setCursor] = useState(() => value.slice(0, 7));

  const grid = useMemo(() => buildMonth(cursor), [cursor]);
  const [year, month] = cursor.split('-').map(Number);

  return (
    <View style={s.wrap}>
      <View style={s.head}>
        <Pressable
          onPress={() => setCursor(shiftMonth(cursor, -1))}
          accessibilityRole="button"
          accessibilityLabel="Previous month"
          style={s.arrow}
        >
          <Text style={[s.arrowText, { color: accent }]}>‹</Text>
        </Pressable>

        <Text style={s.monthLabel}>{monthName(year, month)}</Text>

        <Pressable
          onPress={() => setCursor(shiftMonth(cursor, 1))}
          accessibilityRole="button"
          accessibilityLabel="Next month"
          style={s.arrow}
        >
          <Text style={[s.arrowText, { color: accent }]}>›</Text>
        </Pressable>
      </View>

      <View style={s.week}>
        {WEEKDAYS.map((d, i) => (
          <Text key={i} style={s.weekday}>
            {d}
          </Text>
        ))}
      </View>

      {grid.map((week, wi) => (
        <View key={wi} style={s.week}>
          {week.map((day, di) => {
            if (!day) return <View key={di} style={s.cell} />;

            const selected = day === value;
            const disabled = (min ? day < min : false) || (max ? day > max : false);

            return (
              <Pressable
                key={di}
                onPress={() => onChange(day)}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityState={{ selected, disabled }}
                accessibilityLabel={day}
                style={[
                  s.cell,
                  selected && { backgroundColor: accent, borderRadius: theme.radius.sm },
                ]}
              >
                <Text
                  style={[
                    s.day,
                    selected && { color: theme.color.onSolid, fontWeight: '800' },
                    disabled && { color: theme.color.borderStrong },
                  ]}
                >
                  {Number(day.slice(8))}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/**
 * Weeks of the month, Monday-first, padded with nulls.
 *
 * Built entirely in UTC. `Date.UTC` and `getUTCDay` mean the grid is the same
 * on every device, which is the whole point — the clinic's calendar is not the
 * phone's calendar.
 */
function buildMonth(cursor: string): (string | null)[][] {
  const [year, month] = cursor.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  // getUTCDay is Sunday-first; shift so Monday is column 0.
  const lead = (first.getUTCDay() + 6) % 7;

  const cells: (string | null)[] = Array(lead).fill(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${cursor}-${String(d).padStart(2, '0')}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function shiftMonth(cursor: string, by: number): string {
  const [year, month] = cursor.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthName(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString([], {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const s = StyleSheet.create({
  wrap: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space(2),
    gap: theme.space(1),
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  arrow: {
    width: theme.touchTarget,
    height: theme.touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowText: { fontSize: 24, fontWeight: '800' },
  monthLabel: { ...theme.font.heading, color: theme.color.text },
  week: { flexDirection: 'row' },
  weekday: {
    flex: 1,
    textAlign: 'center',
    ...theme.font.overline,
    color: theme.color.textSubtle,
    paddingVertical: theme.space(1),
  },
  cell: { flex: 1, height: 38, alignItems: 'center', justifyContent: 'center' },
  day: { ...theme.font.body, color: theme.color.text },
});
