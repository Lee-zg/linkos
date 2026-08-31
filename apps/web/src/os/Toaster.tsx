import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, X } from "lucide-react";

type Toast = { id: number; title: string; body?: string };

const ToastContext = createContext<(title: string, body?: string) => void>(
  () => undefined,
);

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);
  const toast = useCallback(
    (title: string, body?: string) => {
      const id = ++counter.current;
      setToasts((current) => [...current.slice(-3), { id, title, body }]);
      window.setTimeout(() => dismiss(id), 4000);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="pointer-events-none fixed top-3 right-3 z-[9500] flex w-[min(340px,calc(100vw-24px))] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-popover p-3 shadow-lg"
            role="status"
          >
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-foreground text-background">
              <Check size={12} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="m-0 text-sm font-medium">{t.title}</p>
              {t.body && (
                <p className="m-0 mt-0.5 text-xs text-muted-foreground">
                  {t.body}
                </p>
              )}
            </div>
            <button
              className="grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded-md border-none bg-transparent p-0 text-muted-foreground hover:bg-accent"
              aria-label="关闭通知"
              onClick={() => dismiss(t.id)}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
