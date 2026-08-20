import React from "react";
import { Streamdown, defaultRehypePlugins } from "streamdown";
import { harden } from "rehype-harden";
import "katex/dist/katex.min.css";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isSafeExternalUrl } from "./url-guard";

interface MarkdownRendererProps {
  children: string;
  isStreaming?: boolean;
}

const rehypePlugins = Object.entries(defaultRehypePlugins)
  .filter(([name]) => name !== "raw")
  .map(([, plugin]) =>
    Array.isArray(plugin) && plugin[0] === harden
      ? [
          harden,
          {
            ...(plugin[1] as Record<string, unknown>),
            allowedProtocols: ["http:", "https:", "mailto:"],
          },
        ]
      : plugin,
  );

function isSafeImageSource(src: unknown): src is string {
  return (
    typeof src === "string" &&
    (/^data:image\/(?:png|gif|jpe?g|webp|avif);base64,/i.test(src) ||
      src.startsWith("blob:") ||
      src.startsWith("/") ||
      src.startsWith("./") ||
      src.startsWith("../"))
  );
}

export function Markdown({
  children,
  isStreaming = false,
}: MarkdownRendererProps) {
  return (
    <Streamdown
      isAnimating={isStreaming}
      shikiTheme={["github-light", "github-dark"]}
      components={COMPONENTS as any}
      rehypePlugins={rehypePlugins as any}
      controls={{
        table: true,
        code: true,
        mermaid: {
          download: true,
          copy: true,
          fullscreen: false,
          panZoom: false,
        },
      }}
    >
      {children}
    </Streamdown>
  );
}

const COMPONENTS = {
  a: ({ children, href, node: _node, ...props }: any) => {
    const isSafe = typeof href === "string" && isSafeExternalUrl(href);

    const handleClick = async (e: React.MouseEvent) => {
      e.preventDefault();
      if (!isSafe) return;
      try {
        await openUrl(href);
      } catch (error) {
        console.error("Failed to open URL:", error);
      }
    };

    return (
      <a
        href={isSafe ? href : undefined}
        className="text-primary underline underline-offset-2 hover:text-primary/80 cursor-pointer"
        onClick={handleClick}
        {...props}
      >
        {children}
      </a>
    );
  },
  img: ({ src, node: _node, ...props }: any) => {
    if (!isSafeImageSource(src)) return null;
    return <img src={src} {...props} />;
  },
};
