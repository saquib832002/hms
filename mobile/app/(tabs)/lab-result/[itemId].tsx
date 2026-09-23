import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { api } from '@/lib/api';
import { theme } from '@/lib/theme';
import { AppHeader, Button, Card, ErrorBanner, Field, Screen, SectionTitle } from '@/components/ui';
import * as DocumentPicker from 'expo-document-picker';
import { openLabAttachment, uploadLabAttachment } from '@/lib/documents';
import type { LabAttachment, LabOrder, LabTest } from '@/lib/types';

/**
 * Entering one test's result at the bench.
 *
 * WHY THE VALUES ARE NOT FLAGGED HERE
 * -----------------------------------
 * The server compares each value with its reference range and returns the flag.
 * Doing it on the device would mean a second implementation of that comparison,
 * and a disagreement between the two is a value that reads as normal on a phone
 * and high on the ward terminal — the worst available outcome, because both
 * screens look authoritative.
 *
 * WHY A CRITICAL VALUE STOPS THE SCREEN
 * -------------------------------------
 * Nothing in this system telephones anybody, and it says so out loud. What it
 * can do is refuse to let the moment pass quietly: the technician is here, now,
 * with the number in front of them. Returning straight to a list is how a
 * potassium of 7.2 becomes something somebody notices tomorrow.
 */
export default function LabResultScreen() {
  const { itemId } = useLocalSearchParams<{ itemId: string }>();
  const id = Number(itemId);

  const [order, setOrder] = useState<LabOrder | null>(null);
  const [test, setTest] = useState<LabTest | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [findings, setFindings] = useState('');
  const [impression, setImpression] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<LabAttachment[]>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      /*
       * The item id is what the worklist hands over, and the order it belongs
       * to is not known here — so the order is fetched by walking the same
       * worklist the technician just came from. One request rather than a
       * dedicated by-item route, which would be a second way to read the same
       * row and a second place to get the role rules right.
       */
      const list = await api<{ data: { id: number; items: { id: number }[] }[] }>(
        '/lab/worklist?status=all',
      );
      const owning = list.data.find((o) => o.items.some((i) => i.id === id));
      if (!owning) {
        setError('That test is no longer on the worklist.');
        return;
      }

      const full = await api<LabOrder>(`/lab-orders/${owning.id}`);
      setOrder(full);
      const item = full.items.find((i) => i.id === id);
      setFindings(item?.findings ?? '');
      setImpression(item?.impression ?? '');
      setValues(Object.fromEntries((item?.values ?? []).map((v) => [v.analyteName, v.value])));

      const catalogue = await api<{ data: LabTest[] }>('/lab-tests');
      setTest(catalogue.data.find((t) => t.code === item?.testCode) ?? null);

      const files = await api<{ data: LabAttachment[] }>(
        `/lab/orders/${owning.id}/attachments`,
      );
      setAttachments(files.data.filter((f) => f.orderItemId === id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load that test');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const item = order?.items.find((i) => i.id === id);

  const recordCall = (analytes: string[]) => {
    Alert.prompt?.(
      'Critical result',
      `${analytes.join(', ')} — outside the critical range. Nothing here notifies anybody: telephone the requesting clinician, then say who you spoke to.`,
      async (notifiedTo?: string) => {
        if (!notifiedTo || notifiedTo.trim().length < 2) {
          router.back();
          return;
        }
        try {
          await api(`/lab/items/${id}/critical-notified`, {
            method: 'POST',
            body: { notifiedTo: notifiedTo.trim() },
          });
        } catch {
          /* The result is already saved; failing to log the call must not lose
             it. Reported on the worklist as "critical · not called". */
        }
        router.back();
      },
    );
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ critical: string[] }>(`/lab/items/${id}/result`, {
        method: 'POST',
        body: {
          values: (test?.analytes ?? [])
            .filter((a) => (values[a.name] ?? '').trim())
            .map((a) => ({ analyteName: a.name, value: values[a.name].trim(), unit: a.unit })),
          findings: findings.trim() || null,
          impression: impression.trim() || null,
        },
      });

      if (res.critical.length > 0) recordCall(res.critical);
      else router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that result');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Attach the laboratory's own report.
   *
   * For a histopathology or an imaging result the file IS the report — the
   * narrative boxes above summarise it. PDF and Word only; the server reads the
   * file's own leading bytes and its refusal is shown verbatim, because it
   * names the type or the size and that is the only actionable part.
   */
  const attach = async () => {
    const picked = await DocumentPicker.getDocumentAsync({
      // A hint to the picker, not a check. The server decides.
      type: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
      copyToCacheDirectory: true,
    });
    if (picked.canceled || !picked.assets?.[0]) return;

    const file = picked.assets[0];
    setBusy(true);
    setError(null);
    try {
      await uploadLabAttachment(id, {
        uri: file.uri,
        name: file.name,
        mimeType: file.mimeType,
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not attach that file');
    } finally {
      setBusy(false);
    }
  };

  const removeAttachment = (attachment: LabAttachment) => {
    Alert.alert('Remove file', `Remove ${attachment.fileName}?`, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await api(`/lab/attachments/${attachment.id}`, { method: 'DELETE' });
            await load();
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not remove that file');
          }
        },
      },
    ]);
  };

  /** Fixing a missing price where it is found, not two screens away. */
  const savePrice = async () => {
    if (!test) return;
    setBusy(true);
    try {
      await api(`/lab-tests/${test.id}`, { method: 'PATCH', body: { sellingPrice: price.trim() } });
      setTest({ ...test, sellingPrice: price.trim() });
      setPrice('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not set that price');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <AppHeader
        title={item ? item.testName : 'Result'}
        subtitle={order?.patient?.fullName ?? ''}
      />

      {error && <ErrorBanner message={error} />}

      <ScrollView contentContainerStyle={s.body}>
        {order?.clinicalDetails ? (
          <Card>
            <Text style={s.overline}>Clinical details</Text>
            <Text style={s.body13}>{order.clinicalDetails}</Text>
          </Card>
        ) : null}

        {test && test.sellingPrice === null && (
          <Card style={s.warn}>
            <Text style={s.warnText}>
              Nobody has priced this test. It will be performed and not charged for.
            </Text>
            <Field label="Price" value={price} onChange={setPrice} keyboardType="decimal-pad" />
            <Button
              label="Set price"
              variant="secondary"
              disabled={busy || !price.trim()}
              onPress={() => void savePrice()}
            />
          </Card>
        )}

        {test && test.analytes.length > 0 && (
          <Card>
            <SectionTitle>Values</SectionTitle>
            {test.analytes.map((a) => (
              <View key={a.id}>
                <Field
                  label={`${a.name}${a.unit ? ` (${a.unit})` : ''}`}
                  value={values[a.name] ?? ''}
                  onChange={(v) => setValues((prev) => ({ ...prev, [a.name]: v }))}
                  /*
                   * Not a numeric keyboard. "<0.01" and "No growth" are real
                   * laboratory results and a number pad cannot type either.
                   */
                  autoCapitalize="none"
                />
                <Text style={s.range}>{a.display ?? 'No reference range set'}</Text>
              </View>
            ))}
          </Card>
        )}

        {test && test.analytes.length === 0 && (
          <Card>
            <Text style={s.muted}>
              This test has no analytes, so it reports as findings and an impression — which is how
              imaging and histopathology work.
            </Text>
          </Card>
        )}

        <Card>
          <SectionTitle>Files</SectionTitle>
          {attachments.length === 0 ? (
            <Text style={s.muted}>
              Nothing attached. A signed report or an analyser printout goes here — PDF or Word, up
              to 10 MB.
            </Text>
          ) : (
            attachments.map((a) => (
              <View key={a.id} style={s.fileRow}>
                <Pressable style={s.fileName} onPress={() => void openLabAttachment(a.id)}>
                  <Text style={s.fileLink}>{a.fileName}</Text>
                  <Text style={s.muted}>{fileSize(a.sizeBytes)}</Text>
                </Pressable>
                <Pressable onPress={() => removeAttachment(a)}>
                  <Text style={s.remove}>Remove</Text>
                </Pressable>
              </View>
            ))
          )}
          <Button
            label={busy ? 'Working…' : 'Attach a file'}
            variant="secondary"
            disabled={busy}
            onPress={() => void attach()}
          />
        </Card>

        <Card>
          <SectionTitle>Report</SectionTitle>
          <Field label="Findings" value={findings} onChange={setFindings} multiline />
          <Field label="Impression" value={impression} onChange={setImpression} multiline />
        </Card>

        <Button label={busy ? 'Saving…' : 'Save result'} disabled={busy} onPress={() => void save()} />

        <Text style={s.footnote}>
          Saving does not release this to the ward. A report becomes visible outside the laboratory
          only once somebody authorises it.
        </Text>
      </ScrollView>
    </Screen>
  );
}

/** Bytes as a person reads them. On a ward tablet, 4 MB is the useful fact. */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const s = StyleSheet.create({
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: theme.space(1),
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
  },
  fileName: { flex: 1 },
  fileLink: { ...theme.font.body, color: theme.color.primary },
  remove: { ...theme.font.caption, color: theme.color.danger },
  body: { padding: theme.space(3), gap: theme.space(2), paddingBottom: theme.space(10) },
  overline: {
    ...theme.font.overline,
    color: theme.color.textSubtle,
    textTransform: 'uppercase',
    marginBottom: theme.space(0.5),
  },
  body13: { ...theme.font.body, color: theme.color.text },
  muted: { ...theme.font.caption, color: theme.color.textMuted, lineHeight: 16 },
  range: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    marginTop: -theme.space(1),
    marginBottom: theme.space(1.5),
  },
  warn: { backgroundColor: theme.color.warningSoft, gap: theme.space(1) },
  warnText: { ...theme.font.caption, color: theme.color.warning, lineHeight: 16 },
  footnote: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    textAlign: 'center',
    lineHeight: 16,
  },
});
