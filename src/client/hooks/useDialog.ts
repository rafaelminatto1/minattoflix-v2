import { useEffect, useRef } from 'react';

export function useDialog(onClose?: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const background = [...document.querySelectorAll<HTMLElement>('#root > *')].filter(element => !element.contains(dialog));
    const siblings = [...(dialog.parentElement?.children || [])].filter(element => element instanceof HTMLElement && element !== dialog && !element.contains(dialog)) as HTMLElement[];
    const inertElements = [...new Set([...background, ...siblings])];
    const previousInert = inertElements.map(element => element.inert);
    inertElements.forEach(element => { element.inert = true; });
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, a[href], [tabindex="0"]')].filter(element => element.getClientRects().length > 0 && !element.closest('[inert]'));
    (focusable()[0] || dialog).focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closeRef.current) { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      inertElements.forEach((element, index) => { element.inert = previousInert[index]; });
      document.removeEventListener('keydown', onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return ref;
}
