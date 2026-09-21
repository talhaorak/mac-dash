import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Two-step "click again to confirm" state.
 *
 * `arm(key)` marks one target as awaiting confirmation. The armed state
 * clears itself after `timeoutMs` (0 disables the timeout). `confirm(key, fn)`
 * arms on the first call and runs `fn` on the second call for the same key.
 */
export function useConfirm<K = string>(timeoutMs: number = DEFAULT_TIMEOUT_MS) {
  const [armed, setArmed] = useState<K | null>(null);
  const armedRef = useRef<K | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const disarm = useCallback(() => {
    clearTimer();
    armedRef.current = null;
    setArmed(null);
  }, [clearTimer]);

  const arm = useCallback(
    (key: K) => {
      clearTimer();
      armedRef.current = key;
      setArmed(key);
      if (timeoutMs > 0) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          armedRef.current = null;
          setArmed(null);
        }, timeoutMs);
      }
    },
    [clearTimer, timeoutMs]
  );

  const confirm = useCallback(
    (key: K, action: () => void) => {
      if (armedRef.current !== null && Object.is(armedRef.current, key)) {
        disarm();
        action();
      } else {
        arm(key);
      }
    },
    [arm, disarm]
  );

  const isArmed = useCallback(
    (key: K) => armed !== null && Object.is(armed, key),
    [armed]
  );

  useEffect(() => clearTimer, [clearTimer]);

  return { armed, isArmed, arm, disarm, confirm };
}

interface ConfirmButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children"> {
  /** Runs on the second click. */
  onConfirm: () => void;
  /** Content in the idle state. */
  children: ReactNode;
  /** Content while the button waits for the second click. */
  confirmLabel?: ReactNode;
  /** Extra classes while the button waits for the second click. */
  armedClassName?: string;
  /** The armed state clears itself after this many milliseconds. 0 disables. */
  timeoutMs?: number;
}

/**
 * Button for destructive actions. The first click arms the button and changes
 * its label. The second click runs `onConfirm`. Escape, blur, and the timeout
 * return the button to the idle state.
 */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel,
  armedClassName,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  className,
  onBlur,
  onKeyDown,
  ...rest
}: ConfirmButtonProps) {
  const { t } = useT();
  const { armed, confirm, disarm } = useConfirm<true>(timeoutMs);
  const isArmed = armed === true;
  const confirmText = confirmLabel ?? t("app.confirmButton.clickAgain");

  return (
    <button
      type="button"
      {...rest}
      aria-live="polite"
      data-armed={isArmed || undefined}
      className={cn(className, isArmed && armedClassName)}
      onClick={(e) => {
        e.stopPropagation();
        confirm(true, onConfirm);
      }}
      onBlur={(e) => {
        disarm();
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && isArmed) {
          // Consume Escape so an enclosing Dialog stays open.
          e.preventDefault();
          e.stopPropagation();
          disarm();
        }
        onKeyDown?.(e);
      }}
    >
      {isArmed ? confirmText : children}
    </button>
  );
}
