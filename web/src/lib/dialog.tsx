import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';

interface DialogApi {
  open: (content: ReactNode, opts?: { wide?: boolean }) => void;
  close: () => void;
  isOpen: boolean;
}

const DialogContext = createContext<DialogApi>({ open: () => {}, close: () => {}, isOpen: false });

/** A single modal slot backed by the native <dialog> element (focus trap and Esc for free). */
export function DialogProvider({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<{ content: ReactNode; wide: boolean; key: number } | null>(null);
  const open = useCallback(
    (content: ReactNode, opts?: { wide?: boolean }) => setState({ content, wide: !!opts?.wide, key: Date.now() }),
    [],
  );
  const close = useCallback(() => setState(null), []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (state && !d.open) d.showModal();
    if (!state && d.open) d.close();
  }, [state]);

  return (
    <DialogContext.Provider value={{ open, close, isOpen: !!state }}>
      {children}
      <dialog ref={ref} className={`modal${state?.wide ? ' wide' : ''}`} onClose={close}>
        {state && <div key={state.key}>{state.content}</div>}
      </dialog>
    </DialogContext.Provider>
  );
}

export const useDialog = () => useContext(DialogContext);
