import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AllergyBanner } from './allergy-banner';
import type { Allergy } from '@/lib/types';

/**
 * These two states must never collapse into one:
 *
 *   allergies === undefined  →  this role's API response contains no clinical
 *                               data at all (reception, billing, admin)
 *   allergies === []         →  this role can see allergies; there are none
 *
 * Rendering "No known allergies" for a receptionist would be an assertion the
 * server never made — the API did not say the patient has no allergies, it
 * declined to say anything. A clinician glancing at a shared screen could
 * reasonably read that as cleared.
 */

const penicillin: Allergy = {
  id: 1,
  substance: 'Penicillin',
  severity: 'SEVERE',
  notes: null,
};

describe('AllergyBanner', () => {
  it('renders nothing when the role cannot see clinical data', () => {
    const { container } = render(<AllergyBanner allergies={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not claim "no known allergies" when the role simply cannot see them', () => {
    render(<AllergyBanner allergies={undefined} />);
    expect(screen.queryByText(/no known allergies/i)).not.toBeInTheDocument();
  });

  it('states explicitly when a clinical role sees an empty list', () => {
    render(<AllergyBanner allergies={[]} />);
    expect(screen.getByText(/no known allergies recorded/i)).toBeInTheDocument();
  });

  it('shows the substance and severity', () => {
    render(<AllergyBanner allergies={[penicillin]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Penicillin');
    expect(screen.getByRole('alert')).toHaveTextContent('Severe');
  });

  it('lists every allergy, not just the first', () => {
    render(
      <AllergyBanner
        allergies={[
          penicillin,
          { id: 2, substance: 'Sulfa drugs', severity: 'MODERATE', notes: null },
          { id: 3, substance: 'Peanuts', severity: 'LIFE_THREATENING', notes: null },
        ]}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Penicillin');
    expect(alert).toHaveTextContent('Sulfa drugs');
    expect(alert).toHaveTextContent('Peanuts');
  });

  it('exposes allergies as an alert so screen readers announce them', () => {
    // A banner that is only visually prominent is not prominent to everyone.
    render(<AllergyBanner allergies={[penicillin]} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('does not use role="alert" for the empty state', () => {
    // "No known allergies" is reassurance, not a warning.
    render(<AllergyBanner allergies={[]} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
