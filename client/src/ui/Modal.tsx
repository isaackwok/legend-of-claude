import { useEffect, useId, useRef, type ReactNode } from 'react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** Minimal modal: a labelled `role="dialog"` over a dimmed backdrop. Escape closes it. */
export function Modal({ title, onClose, children }: ModalProps) {
  const headingId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button');
    first?.focus();
  }, []);

  return (
    <div className="modal-backdrop">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={headingId} className="frame modal">
        <h2 id={headingId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
