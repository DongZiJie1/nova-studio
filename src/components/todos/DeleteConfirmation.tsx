import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export function DeleteConfirmation({ title, description, onCancel, onConfirm }: {
  title: string;
  description: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.showModal();
    cancelRef.current?.focus();
    return () => {
      dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="todo-delete-confirmation"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <h2 id={titleId}>{title}</h2>
      <p id={descriptionId}>{description}</p>
      <div className="todo-delete-confirmation-actions">
        <button ref={cancelRef} type="button" onClick={onCancel}>取消</button>
        <button type="button" className="todo-delete-confirmation-submit" onClick={onConfirm}>确认删除</button>
      </div>
    </dialog>,
    document.body,
  );
}
