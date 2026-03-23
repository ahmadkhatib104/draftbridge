import type { ReactNode } from "react";

function handleEmbeddedNavigation(event: Event & { currentTarget: HTMLElement }) {
  event.preventDefault();
  event.currentTarget.dispatchEvent(
    new CustomEvent("shopify:navigate", {
      bubbles: true,
    }),
  );
}

interface EmbeddedNavProps {
  to: string;
  children: ReactNode;
}

interface EmbeddedNavButtonProps extends EmbeddedNavProps {
  slot?: Lowercase<string>;
}

export function EmbeddedNavLink({ to, children }: EmbeddedNavProps) {
  return (
    <s-link href={to} onClick={handleEmbeddedNavigation}>
      {children}
    </s-link>
  );
}

export function EmbeddedNavButton({
  to,
  children,
  slot,
}: EmbeddedNavButtonProps) {
  const isPrimaryAction = slot === "primary-action";

  return (
    <s-button
      slot={slot}
      href={to}
      onClick={handleEmbeddedNavigation}
      {...(isPrimaryAction ? { variant: "primary" } : {})}
    >
      {children}
    </s-button>
  );
}
