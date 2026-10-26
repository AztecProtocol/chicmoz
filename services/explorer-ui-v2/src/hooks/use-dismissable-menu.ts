import { type RefObject, useEffect } from "react";

/** Closes an open menu on a click outside `ref` or on Escape. */
export const useDismissableMenu = (
  ref: RefObject<HTMLElement>,
  open: boolean,
  close: () => void,
): void => {
  useEffect(() => {
    if (!open) {
      return;
    }

    const handleDocClick = (event: MouseEvent) => {
      if (
        ref.current &&
        event.target instanceof Node &&
        !ref.current.contains(event.target)
      ) {
        close();
      }
    };
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };

    document.addEventListener("mousedown", handleDocClick);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleDocClick);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [open, ref, close]);
};
