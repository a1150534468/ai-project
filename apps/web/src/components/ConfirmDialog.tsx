import React, { useState, useCallback } from "react";
import { Icon } from "@iconify/react";
import { Modal, RippleButton } from "../motion";
import { buttonClass } from "./ui";

interface ConfirmDialogProps {
  title: string;
  message: string;
  onConfirm: () => Promise<void> | void;
  onCancel?: () => void;
  confirmText?: string;
  cancelText?: string;
  isDangerous?: boolean;
  children?: React.ReactNode;
}

export function useConfirm() {
  const [dialog, setDialog] = useState<{
    open: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    onCancel: () => void;
    confirmText: string;
    cancelText: string;
    isDangerous: boolean;
    loading?: boolean;
  } | null>(null);

  const confirm = useCallback((options: Omit<ConfirmDialogProps, "children">) => {
    return new Promise<boolean>((resolve) => {
      setDialog({
        open: true,
        title: options.title,
        message: options.message,
        confirmText: options.confirmText || "确认",
        cancelText: options.cancelText || "取消",
        isDangerous: options.isDangerous || false,
        loading: false,
        onConfirm: async () => {
          try {
            setDialog((prev) => prev ? { ...prev, loading: true } : null);
            await options.onConfirm();
            setDialog(null);
            resolve(true);
          } catch (err) {
            setDialog((prev) => prev ? { ...prev, loading: false } : null);
            resolve(false);
          }
        },
        onCancel: () => {
          options.onCancel?.();
          setDialog(null);
          resolve(false);
        },
      });
    });
  }, []);

  const Dialog = () => {
    if (!dialog?.open || !dialog) return null;

    return (
      <Modal
        open={dialog.open}
        onClose={dialog.onCancel}
        className="bg-surface rounded-2xl shadow-lg max-w-sm w-full p-6 mx-4"
      >
        <div className="flex items-start gap-3 mb-4">
          {dialog.isDangerous && (
            <Icon icon="mdi:alert-circle" className="text-danger-ink text-xl flex-none mt-1" />
          )}
          <h2 className="text-lg font-semibold text-ink">{dialog.title}</h2>
        </div>

        <p className="text-sm text-ink-secondary mb-6">{dialog.message}</p>

        <div className="flex gap-3">
          <RippleButton
            onClick={dialog.onCancel}
            disabled={dialog.loading}
            className={buttonClass({ variant: "outline", size: "lg", shape: "rounded", className: "flex-1" })}
          >
            {dialog.cancelText}
          </RippleButton>
          <RippleButton
            onClick={dialog.onConfirm}
            disabled={dialog.loading}
            className={buttonClass({
              variant: dialog.isDangerous ? "danger" : "primary",
              size: "lg",
              shape: "rounded",
              className: "flex-1",
            })}
          >
            {dialog.loading ? (
              <Icon icon="mdi:loading" className="inline animate-spin mr-1" />
            ) : null}
            {dialog.confirmText}
          </RippleButton>
        </div>
      </Modal>
    );
  };

  return { confirm, Dialog };
}
