import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { theme } from '@/lib/theme';
import { Button, Card } from './ui';
import type { LabReferral, LabTest } from '@/lib/types';

/**
 * Say which of this laboratory's tests the referred ones are.
 *
 * WHY THIS SCREEN EXISTS
 * ----------------------
 * Accepting matched on the test *code* and refused everything else with "add it
 * to the catalogue" — an instruction the technician reading it cannot follow,
 * because creating a test is an administrator's job. A correct refusal with no
 * route out is the shape this project has hit repeatedly; this is the route.
 *
 * It is also how reference laboratories actually work. Codes are local
 * vocabulary: one hospital's `FBC` is another's `CBC`, and two independent
 * businesses have no reason to have agreed a compendium. Inbound codes get
 * mapped to the performing lab's own, by somebody who knows both.
 *
 * A picker rather than free text, because the mapping has to resolve to a real
 * `LabTest` — that is what carries the analytes and the reference ranges this
 * laboratory will report against.
 */
export function MapTestsSheet({
  referral,
  catalogue,
  busy,
  onClose,
  onAccept,
}: {
  /** Null closes it — an overlay has to unmount or it covers the tab bar. */
  referral: LabReferral | null;
  catalogue: LabTest[];
  busy: boolean;
  onClose: () => void;
  onAccept: (chosen: Record<number, number>) => void;
}) {
  const [chosen, setChosen] = useState<Record<number, number>>({});

  if (!referral) return null;

  // Every test has to be answered. A referral accepted with one silently
  // dropped produces a report that looks complete and is not.
  const complete = referral.items.every((i) => chosen[i.id]);

  return (
    <View style={s.overlay} pointerEvents="auto">
      <View style={s.header}>
        <Text style={s.title}>Accept {referral.reference}</Text>
        <Text style={s.close} onPress={onClose}>
          Close
        </Text>
      </View>

      <ScrollView contentContainerStyle={s.body}>
        <Text style={s.muted}>
          {referral.from} uses their own test codes. Say which of yours each one is — this
          laboratory runs its own test, under its own reference ranges.
        </Text>

        {catalogue.length === 0 && (
          <Text style={s.danger}>
            This laboratory has no active tests at all. An administrator adds them under Lab Tests
            before any work can be accepted.
          </Text>
        )}

        {referral.items.map((item) => (
          <Card key={item.id}>
            <Text style={s.testName}>{item.testName}</Text>
            <Text style={s.muted}>{item.testCode}</Text>

            <View style={s.options}>
              {catalogue.map((t) => {
                const on = chosen[item.id] === t.id;
                return (
                  <Pressable
                    key={t.id}
                    onPress={() => setChosen((prev) => ({ ...prev, [item.id]: t.id }))}
                    style={[s.option, on && s.optionOn]}
                  >
                    <Text style={[s.optionText, on && s.optionTextOn]}>
                      {t.name} ({t.code})
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Card>
        ))}
      </ScrollView>

      <View style={s.actions}>
        <Button
          label={busy ? 'Accepting…' : 'Accept onto the worklist'}
          busy={busy}
          disabled={!complete}
          onPress={() => onAccept(chosen)}
          style={s.grow}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.color.bg,
    zIndex: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(3),
    borderBottomWidth: 1,
    borderBottomColor: theme.color.border,
  },
  title: { ...theme.font.title, color: theme.color.text },
  close: { ...theme.font.body, color: theme.color.primary },
  body: { padding: theme.space(4), gap: theme.space(3) },
  muted: { ...theme.font.caption, color: theme.color.textMuted },
  danger: { ...theme.font.caption, color: theme.color.danger },
  testName: { ...theme.font.body, fontWeight: '700', color: theme.color.text },
  options: { marginTop: theme.space(2), gap: theme.space(1) },
  option: {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
  },
  optionOn: { borderColor: theme.color.primary, backgroundColor: theme.color.surface },
  optionText: { ...theme.font.caption, color: theme.color.textMuted },
  optionTextOn: { color: theme.color.text, fontWeight: '700' },
  actions: {
    flexDirection: 'row',
    padding: theme.space(4),
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
  },
  grow: { flex: 1 },
});
