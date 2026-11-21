import { t } from "@shared/i18n";
import { Children, isValidElement, useContext, useEffect, useState, type ReactNode } from "react";
import { NoticeBanner } from "../feedback/NoticeBanner";
import { ModalSurfaceContext } from "./ModalSurface";
import { Dialog } from "./Dialog";
import { Button } from "../actions/Button";

function messageText(content: ReactNode): string {
  return Children.toArray(content)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? messageText(child.props.children)
        : String(child),
    )
    .join(" ");
}

export function ErrorDialog({
  children,
  title = t("errorDialog.couldNotCompleteTheAction"),
  onDismiss,
  actions,
}: {
  children: ReactNode;
  title?: string;
  onDismiss?: () => void;
  actions?: ReactNode;
}) {
  const parent = useContext(ModalSurfaceContext);
  const [dismissed, setDismissed] = useState(false);
  const message = messageText(children);

  useEffect(() => setDismissed(false), [message]);

  if (!children || dismissed) return null;

  const close = () => {
    setDismissed(true);
    onDismiss?.();
  };

  const controls = (
    <>
      {actions}
      <Button size="sm" onClick={close}>
        {t("errorDialog.dismiss")}
      </Button>
    </>
  );

  if (parent)
    return (
      <NoticeBanner tone="error" action={controls}>
        {children}
      </NoticeBanner>
    );

  return (
    <Dialog title={title} onClose={close} footer={controls}>
      <div role="alert" className="break-words text-sm leading-relaxed text-text-secondary">
        {children}
      </div>
    </Dialog>
  );
}
