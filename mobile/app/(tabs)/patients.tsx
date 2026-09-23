import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { api } from '@/lib/api';
import { theme } from '@/lib/theme';
import { date } from '@/lib/format';
import {
  AppHeader,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  Screen,
} from '@/components/ui';
import type { Paginated, PatientListItem } from '@/lib/types';
import { useAuth } from '@/lib/auth-context';

/**
 * Patient lookup for reception.
 *
 * Opens on the most recently registered patients and narrows as you type. The
 * first version demanded two characters before showing anything, on a
 * minimum-necessary argument — a scrollable index of every patient is a
 * different thing from looking up the person in front of you.
 *
 * That was the wrong call in practice. It made the tab look broken on open, and
 * it was reasoning about a risk the server had already handled: `GET /patients`
 * is paginated, role-shaped, rate-limited and audited on every call. Withholding
 * the first page bought nothing except a receptionist who cannot tell whether
 * the app is working.
 *
 * The real protection is elsewhere and still holds: reception never receives
 * allergies or diagnoses here, because `toPatientResponse` withholds them by
 * role regardless of how this screen is written.
 */
export default function PatientsScreen() {
  const { user } = useAuth();
  /*
   * This screen was reception's, and only reception's.
   *
   * It had no way to open a patient record at all — every action led to
   * registration or booking — so when the tab was given to the other roles a
   * doctor could search for somebody and then do nothing with them. The list
   * *is* the entry to the record on the web for all five roles, and it was the
   * one thing missing here.
   *
   * Registering and booking stay reception's: both are clinic work, and a
   * pharmacist does not book appointments.
   */
  const books = user?.role === 'RECEPTIONIST';
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const search = useCallback(async (q: string) => {
    const trimmed = q.trim();
    setSearching(true);
    setError(null);
    try {
      // No query means the first page — the server defaults to 25, ordered by
      // most recent, which is what reception wants when they open the tab.
      const qs = trimmed ? `?q=${encodeURIComponent(trimmed)}&limit=20` : '?limit=25';
      const res = await api<Paginated<PatientListItem>>(`/patients${qs}`);
      setResults(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load patients');
    } finally {
      setSearching(false);
    }
  }, []);

  // Debounced: a phone keyboard produces a request per keystroke otherwise, and
  // patient lookup is rate-limited for good reason.
  useEffect(() => {
    const t = setTimeout(() => void search(query), query ? 300 : 0);
    return () => clearTimeout(t);
  }, [query, search]);

  return (
    <Screen>
      <AppHeader
        title="Patients"
        subtitle={query.trim() ? 'Matching your search' : 'Most recently registered'}
      />

      <View style={s.searchWrap}>
        <Field
          value={query}
          onChange={setQuery}
          placeholder="Search name or phone"
          autoCapitalize="words"
        />
        {/* Both of reception's starting actions, on the screen they land on.
            Booking used to live only on Today, which meant finding it required
            knowing it was there. */}
        {books && (
          <View style={s.actions}>
            <Button
              label="+  Register"
              variant="secondary"
              onPress={() => router.push('/patient/new')}
              style={s.grow}
            />
            <Button
              label="+  Book"
              onPress={() => router.push('/appointment/new')}
              style={s.grow}
            />
          </View>
        )}
      </View>

      {error && <ErrorBanner message={error} />}

      <FlatList
        data={results ?? []}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={s.list}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <EmptyState
            glyph="◍"
            title={searching ? 'Loading…' : query.trim() ? 'No patients matched' : 'No patients yet'}
            body={
              query.trim()
                ? 'Try a phone number instead.'
                : // "Register the first one" is an instruction only reception can
                  // follow — a doctor reading it has no such button.
                  books
                  ? 'Register the first one.'
                  : 'Reception registers patients.'
            }
          />
        }
        renderItem={({ item }) => (
          // The whole row opens the record — allergies, records, prescriptions
          // and investigations, all role-shaped by the API. This is what the
          // screen was missing for every role except reception.
          <Pressable onPress={() => router.push(`/patient/${item.id}`)}>
            <Card>
              <View style={s.row}>
                <View style={s.grow}>
                  <Text style={s.name} numberOfLines={1}>
                    {item.fullName}
                  </Text>
                  <Text style={s.muted}>
                    {item.age} · {item.gender.toLowerCase()} · born {date(item.dob)}
                  </Text>
                  <Text style={s.muted}>{item.phone ?? 'No phone on file'}</Text>
                </View>
                {/* Booking for the person you are already looking at.
                    Going through the Book button meant searching for a patient
                    who was on screen a moment ago — the list is the search. */}
                {books && (
                  <Button
                    label="Book"
                    variant="secondary"
                    onPress={() => router.push(`/appointment/new?patientId=${item.id}`)}
                  />
                )}
              </View>
            </Card>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  searchWrap: { padding: theme.space(4), gap: theme.space(3) },
  actions: { flexDirection: 'row', gap: theme.space(2) },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space(3) },
  grow: { flex: 1 },
  list: { paddingHorizontal: theme.space(4), paddingBottom: theme.space(4), gap: theme.space(3) },
  name: { ...theme.font.heading, color: theme.color.text },
  muted: { ...theme.font.small, color: theme.color.textSubtle, marginTop: 2 },
});
