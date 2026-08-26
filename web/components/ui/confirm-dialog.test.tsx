import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './confirm-dialog';

const base = {
  open: true,
  title: 'Cancel this appointment?',
  consequence: 'Cancellation is final — rebooking creates a new appointment.',
  confirmLabel: 'Cancel appointment',
};

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <ConfirmDialog {...base} open={false} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('states the consequence, not just the action', () => {
    render(<ConfirmDialog {...base} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/cancellation is final/i)).toBeInTheDocument();
  });

  it('labels the confirm button with what will happen, never "OK"', () => {
    render(<ConfirmDialog {...base} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Cancel appointment' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^ok$/i })).not.toBeInTheDocument();
  });

  it('focuses the dismiss button, not the destructive one', async () => {
    // The action that opened this dialog was often triggered by Enter. If
    // focus landed on Confirm, a second keypress would destroy something.
    render(<ConfirmDialog {...base} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: /keep it/i })).toHaveFocus();
  });

  it('does not confirm when Enter is pressed straight after opening', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...base} onConfirm={onConfirm} onCancel={vi.fn()} />);
    await userEvent.keyboard('{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('calls onConfirm when the destructive button is clicked', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...base} onConfirm={onConfirm} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel appointment' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('dismisses on Escape', async () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...base} onConfirm={vi.fn()} onCancel={onCancel} />);
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });

  it('disables both buttons while the action is in flight', () => {
    render(<ConfirmDialog {...base} busy onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: /keep it/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /working/i })).toBeDisabled();
  });

  it('is announced as an alertdialog', () => {
    render(<ConfirmDialog {...base} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});
