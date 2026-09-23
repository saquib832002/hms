import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { api, ApiError } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { theme } from '@/lib/theme';
import {
  AppHeader,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  Screen,
} from '@/components/ui';
import type { DepartmentRow } from '@/lib/types';

/**
 * The departments doctors belong to.
 *
 * Small enough to be worth having on the phone: it is a name and a list, and
 * the thing an administrator actually does here — adding one because a new
 * consultant is starting — is a single field. It was web-only for no reason
 * beyond nobody having built it, which is the shape this project keeps finding.
 *
 * Renaming and deleting stay on the web. A rename is rare and a delete has to
 * consider the doctors attached to it, which is a decision better made looking
 * at the whole list on a screen that can show it.
 */
export default function DepartmentsScreen() {
  const [rows, setRows] = useState<DepartmentRow[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: DepartmentRow[] }>('/departments');
      setRows(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load departments');
    }
  }, []);

  useLiveData(load);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await api('/departments', { method: 'POST', body: { name: name.trim() } });
      setName('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add that department');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <AppHeader
        title="Departments"
        subtitle={rows === null ? 'Loading…' : `${rows.length} departments`}
      />

      <View style={s.form}>
        <Field
          value={name}
          onChange={setName}
          placeholder="New department, e.g. Cardiology"
          autoCapitalize="words"
        />
        <Button label="Add" busy={busy} disabled={!name.trim()} onPress={() => void add()} />
      </View>

      {error && <ErrorBanner message={error} />}

      <FlatList
        data={rows ?? []}
        keyExtractor={(d) => String(d.id)}
        contentContainerStyle={s.list}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
        ListEmptyComponent={
          rows === null ? null : (
            <EmptyState
              glyph="▢"
              title="No departments yet"
              body="Add one, then assign doctors to it when you create their accounts."
            />
          )
        }
        renderItem={({ item }) => (
          <Card>
            <Text style={s.name}>{item.name}</Text>
            <Text style={s.muted}>
              {item.doctorCount === 0
                ? 'No doctors yet'
                : `${item.doctorCount} ${item.doctorCount === 1 ? 'doctor' : 'doctors'}`}
            </Text>
            {item.doctors.slice(0, 4).map((d) => (
              <Text key={d.id} style={s.doctor}>
                {d.fullName} · {d.specialization}
              </Text>
            ))}
          </Card>
        )}
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  form: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.space(2),
    padding: theme.space(4),
    paddingBottom: 0,
  },
  list: { padding: theme.space(4), gap: theme.space(3) },
  name: { ...theme.font.body, fontWeight: '700', color: theme.color.text },
  muted: { ...theme.font.caption, color: theme.color.textMuted },
  doctor: { ...theme.font.caption, color: theme.color.textSubtle, marginTop: 2 },
});
