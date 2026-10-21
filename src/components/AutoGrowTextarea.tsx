import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type TextareaHTMLAttributes,
} from "react";

type AutoGrowTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "rows"> & {
  maxRows?: number;
};

export const AutoGrowTextarea = forwardRef<HTMLTextAreaElement, AutoGrowTextareaProps>(
  function AutoGrowTextarea({ maxRows, onInput, value, ...props }, forwardedRef) {
    const inputRef = useRef<HTMLTextAreaElement>(null);

    useImperativeHandle(forwardedRef, () => inputRef.current!, []);

    const resize = useCallback(() => {
      const input = inputRef.current;
      if (!input) return;

      input.style.height = "auto";

      const styles = window.getComputedStyle(input);
      const fontSize = Number.parseFloat(styles.fontSize) || 16;
      const lineHeight = Number.parseFloat(styles.lineHeight) || fontSize * 1.2;
      const verticalPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
      const verticalBorder = Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth);
      const naturalHeight = input.scrollHeight + verticalBorder;
      const maximumHeight = maxRows
        ? lineHeight * Math.max(1, maxRows) + verticalPadding + verticalBorder
        : Number.POSITIVE_INFINITY;

      input.style.height = `${Math.min(naturalHeight, maximumHeight)}px`;
      input.style.overflowY = naturalHeight > maximumHeight ? "auto" : "hidden";
    }, [maxRows]);

    useLayoutEffect(() => {
      resize();
    }, [resize, value]);

    useEffect(() => {
      window.addEventListener("resize", resize);
      return () => window.removeEventListener("resize", resize);
    }, [resize]);

    return (
      <textarea
        {...props}
        ref={inputRef}
        rows={1}
        value={value}
        onInput={(event) => {
          resize();
          onInput?.(event);
        }}
      />
    );
  },
);
