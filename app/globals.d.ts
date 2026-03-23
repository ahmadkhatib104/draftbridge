import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "*.css";
declare module "pdf-parse";

declare global {
  namespace JSX {
    interface ShopifyCardProps
      extends DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> {
      heading?: string;
    }

    interface IntrinsicElements {
      "s-app-nav": HTMLAttributes<HTMLElement>;
      "s-card": ShopifyCardProps;
    }
  }
}
